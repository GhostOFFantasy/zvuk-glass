//! Тексты песен из открытой базы LRCLIB (lrclib.net) — для треков, у которых в Zvuk текста нет
//! или он без привязки ко времени. Синхронизированный текст берём только той же версии песни:
//! длительность должна совпадать с треком в пределах нескольких секунд.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};

const BASE: &str = "https://lrclib.net/api";
/// Синхронизированный текст подходит, если длительность отличается не больше чем на столько секунд.
const SYNC_TOLERANCE: f64 = 3.5;
const CACHE_MAX: usize = 300;

pub struct Lyrics {
    http: reqwest::Client,
    cache: Mutex<HashMap<String, Value>>,
}

/// Строка для сравнения: нижний регистр, «ё» → «е», без скобок, «feat.» и знаков.
fn norm(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut depth = 0i32;
    for c in s.to_lowercase().replace('ё', "е").chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = (depth - 1).max(0),
            _ if depth > 0 => {}
            c if c.is_alphanumeric() => out.push(c),
            _ => out.push(' '),
        }
    }
    let s = out.split_whitespace().collect::<Vec<_>>().join(" ");
    // «Song feat. X» и «Song - Remastered 2011» → «song»
    for cut in [" feat ", " ft ", " remaster", " radio edit", " remix"] {
        if let Some(i) = s.find(cut) {
            if i > 0 {
                return s[..i].trim().to_string();
            }
        }
    }
    s
}

fn close(a: &str, b: &str) -> bool {
    !a.is_empty() && !b.is_empty() && (a == b || a.contains(b) || b.contains(a))
}

impl Lyrics {
    pub fn new() -> Self {
        let http = crate::net::builder()
            .user_agent(concat!("ZvukGlass/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(10))
            .build()
            .expect("http client");
        Self { http, cache: Mutex::new(HashMap::new()) }
    }

    async fn get_json(&self, path: &str, params: &[(&str, String)]) -> Option<Value> {
        let qs = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(params.iter().map(|(k, v)| (*k, v.as_str()))).finish();
        let res = self.http.get(format!("{BASE}{path}?{qs}")).send().await.ok()?;
        if !res.status().is_success() {
            return None;
        }
        res.json::<Value>().await.ok()
    }

    /// Ищет текст. Возвращает { text, synced, source } (text — LRC со временем строк или обычный текст) или null.
    pub async fn find(&self, id: &str, artist: &str, title: &str, duration: f64) -> Value {
        if let Some(v) = self.cache.lock().unwrap().get(id) {
            return v.clone();
        }
        let found = self.lookup(artist, title, duration).await;
        let mut c = self.cache.lock().unwrap();
        if c.len() >= CACHE_MAX {
            c.clear();
        }
        c.insert(id.to_string(), found.clone());
        found
    }

    async fn lookup(&self, artist: &str, title: &str, duration: f64) -> Value {
        // 1. Точное совпадение по исполнителю, названию и длительности (±2 с на стороне LRCLIB)
        if duration > 0.0 {
            let p = [("artist_name", artist.to_string()), ("track_name", title.to_string()), ("duration", format!("{}", duration.round() as i64))];
            if let Some(v) = self.get_json("/get", &p).await {
                if let Some(s) = v.get("syncedLyrics").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
                    return json!({ "text": s, "synced": true, "source": "LRCLIB" });
                }
            }
        }
        // 2. Поиск и выбор лучшего кандидата: та же песня того же исполнителя, ближе по длительности, со временем строк
        let want_t = norm(title);
        let want_a = norm(artist);
        let mut best: Option<(f64, Value)> = None;
        let mut queries = vec![vec![("track_name", title.to_string()), ("artist_name", artist.to_string())]];
        if norm(title) != title.to_lowercase() {
            queries.push(vec![("track_name", want_t.clone()), ("artist_name", artist.to_string())]);
        }
        queries.push(vec![("q", format!("{artist} {want_t}"))]);
        for q in queries {
            let Some(Value::Array(list)) = self.get_json("/search", &q).await else { continue };
            for c in list {
                if c.get("instrumental").and_then(Value::as_bool).unwrap_or(false) {
                    continue;
                }
                let ct = norm(c.get("trackName").and_then(Value::as_str).unwrap_or(""));
                let ca = norm(c.get("artistName").and_then(Value::as_str).unwrap_or(""));
                if !close(&ct, &want_t) || !close(&ca, &want_a) {
                    continue;
                }
                let dd = (c.get("duration").and_then(Value::as_f64).unwrap_or(0.0) - duration).abs();
                let synced = c.get("syncedLyrics").and_then(Value::as_str).map(|s| !s.trim().is_empty()).unwrap_or(false);
                let plain = c.get("plainLyrics").and_then(Value::as_str).map(|s| !s.trim().is_empty()).unwrap_or(false);
                let score = if synced && (duration <= 0.0 || dd <= SYNC_TOLERANCE) {
                    100.0 - dd * 5.0 + if ct == want_t { 5.0 } else { 0.0 }
                } else if plain || synced {
                    20.0 - dd.min(20.0) / 2.0
                } else {
                    continue;
                };
                if best.as_ref().map(|(s, _)| score > *s).unwrap_or(true) {
                    best = Some((score, c));
                }
            }
            if best.as_ref().map(|(s, _)| *s >= 50.0).unwrap_or(false) {
                break; // синхронизированный нужной версии уже есть
            }
        }
        let Some((score, c)) = best else { return Value::Null };
        if score >= 50.0 {
            if let Some(s) = c.get("syncedLyrics").and_then(Value::as_str) {
                return json!({ "text": s, "synced": true, "source": "LRCLIB" });
            }
        }
        // другая версия песни или только обычный текст — показываем без привязки ко времени
        let plain = c
            .get("plainLyrics")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(String::from)
            .or_else(|| c.get("syncedLyrics").and_then(Value::as_str).map(|s| strip_times(s)));
        match plain {
            Some(t) => json!({ "text": t, "synced": false, "source": "LRCLIB" }),
            None => Value::Null,
        }
    }
}

/// LRC без отметок времени.
fn strip_times(s: &str) -> String {
    s.lines()
        .map(|l| {
            let mut l = l.trim_start();
            while l.starts_with('[') {
                match l.find(']') {
                    Some(i) => l = l[i + 1..].trim_start(),
                    None => break,
                }
            }
            l
        })
        .collect::<Vec<_>>()
        .join("\n")
}
