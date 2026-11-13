//! Поиск официальных клипов на YouTube (YouTube Data API v3, ключ пользователя) и кэш найденного.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use regex::Regex;
use serde_json::{json, Value};

use crate::zvuk::{ApiError, ApiResult};

const API: &str = "https://www.googleapis.com/youtube/v3";

static NON_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^\p{L}\p{N}]+").unwrap());
static CH_SUFFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r" (official|music|vevo)$").unwrap());
static OFFICIAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(official|официальн|клип|music video|\bmv\b)").unwrap());
static ISO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?").unwrap());
static VIDEO_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:youtu\.be/|[?&]v=|/embed/|/shorts/|/live/)([\w-]{11})").unwrap());
static BARE_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\w-]{11}$").unwrap());

const BAD: [&str; 33] = [
    "lyric", "lyrics", "текст", "караоке", "karaoke", "cover", "кавер", "live", "концерт", "concert", "reaction", "реакция", "remix", "ремикс",
    "speed up", "sped up", "slowed", "8d", "nightcore", "instrumental", "минус", "tutorial", "разбор", "fan made", "fanmade", "visualizer",
    "audio", "аудио", "teaser", "тизер", "trailer", "snippet", "acoustic",
];

fn norm(s: &str) -> String {
    let s = s.to_lowercase().replace('ё', "е");
    NON_WORD.replace_all(&s, " ").trim().to_string()
}

/// ISO 8601 (PT3M25S) → секунды
fn iso_dur(s: &str) -> i64 {
    let Some(m) = ISO.captures(s) else { return 0 };
    let g = |i: usize| m.get(i).and_then(|x| x.as_str().parse::<i64>().ok()).unwrap_or(0);
    g(1) * 86400 + g(2) * 3600 + g(3) * 60 + g(4)
}

/// Оценка «насколько это официальный клип именно этого трека».
fn score(title: &str, channel: &str, dur: i64, track: &Value) -> i64 {
    let t = norm(title);
    let ch = norm(channel);
    let artist = norm(track.pointer("/artists/0").and_then(Value::as_str).unwrap_or(""));
    let tt = norm(track.get("title").and_then(Value::as_str).unwrap_or(""));
    let mut s = 0;
    if !tt.is_empty() && t.contains(&tt) {
        s += 4;
    }
    if !artist.is_empty() && (t.contains(&artist) || ch.contains(&artist)) {
        s += 3;
    }
    if !artist.is_empty() && CH_SUFFIX.replace(&ch, "").contains(&artist) {
        s += 1;
    }
    if ch.replace(char::is_whitespace, "").ends_with("vevo") {
        s += 2;
    }
    if OFFICIAL.is_match(&t) {
        s += 2;
    }
    if ch.ends_with(" topic") {
        s -= 5; // автоканалы YouTube с одной обложкой
    }
    for w in BAD {
        if t.contains(w) && !tt.contains(w) {
            s -= 3;
        }
    }
    let td = track.get("duration").and_then(Value::as_i64).unwrap_or(0);
    if td > 0 && dur > 0 {
        let d = (dur - td).abs();
        if d <= 12 {
            s += 2;
        } else if d > 90 {
            s -= 2;
        }
    }
    s
}

fn api_error(j: &Value, status: u16) -> ApiError {
    let reason = j.pointer("/error/errors/0/reason").and_then(Value::as_str).unwrap_or("");
    let msg = j.pointer("/error/message").and_then(Value::as_str).unwrap_or("");
    if reason == "quotaExceeded" || reason == "dailyLimitExceeded" {
        return ApiError::new("QUOTA", "Дневной лимит поиска YouTube исчерпан — найденные клипы продолжат работать");
    }
    if reason == "keyInvalid" || msg.to_lowercase().contains("api key not valid") {
        return ApiError::new("BAD_KEY", "Ключ YouTube недействителен");
    }
    if reason == "accessNotConfigured" || msg.contains("has not been used") || msg.contains("is disabled") {
        return ApiError::new("API_DISABLED", "В проекте Google не включён «YouTube Data API v3»");
    }
    ApiError::new("API", if msg.is_empty() { format!("Ошибка YouTube (HTTP {status})") } else { msg.to_string() })
}

pub struct Clips {
    http: reqwest::Client,
    file: PathBuf,
    data: Mutex<HashMap<String, Value>>,
}

impl Clips {
    pub fn new(dir: &std::path::Path) -> Self {
        let file = dir.join("clips.json");
        let data = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        let http = reqwest::Client::builder().timeout(Duration::from_secs(15)).build().expect("http client");
        Self { http, file, data: Mutex::new(data) }
    }

    async fn get_json(&self, path: &str, params: &[(&str, &str)]) -> ApiResult<Value> {
        let qs = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(params).finish();
        let r = self
            .http
            .get(format!("{API}/{path}?{qs}"))
            .send()
            .await
            .map_err(|e| ApiError::new("NETWORK", format!("YouTube недоступен: {}", crate::zvuk::short_err(&e))))?;
        let status = r.status();
        let j: Value = r.json().await.unwrap_or(json!({}));
        if !status.is_success() {
            return Err(api_error(&j, status.as_u16()));
        }
        Ok(j)
    }

    /// Проверка ключа самым дешёвым запросом (1 единица квоты).
    pub async fn check_key(&self, key: &str) -> ApiResult<()> {
        self.get_json("videos", &[("part", "id"), ("id", "dQw4w9WgXcQ"), ("key", key)]).await.map(|_| ())
    }

    /// Кандидаты для трека { id, title, artists: [названия], duration }, лучшие первыми.
    pub async fn search(&self, key: &str, track: &Value) -> ApiResult<Vec<Value>> {
        let artist = track.pointer("/artists/0").and_then(Value::as_str).unwrap_or("");
        let title = track.get("title").and_then(Value::as_str).unwrap_or("");
        let cyr = format!("{title}{artist}").to_lowercase().chars().any(|c| ('а'..='я').contains(&c) || c == 'ё');
        let q = format!("{artist} {title} {}", if cyr { "клип" } else { "official video" }).trim().to_string();
        let j = self
            .get_json("search", &[("part", "snippet"), ("type", "video"), ("videoEmbeddable", "true"), ("maxResults", "8"), ("q", &q), ("key", key)])
            .await?;
        let ids: Vec<String> = j
            .get("items")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|i| i.pointer("/id/videoId").and_then(Value::as_str).map(String::from)).collect())
            .unwrap_or_default();
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let d = self.get_json("videos", &[("part", "contentDetails,status,snippet"), ("id", &ids.join(",")), ("key", key)]).await?;
        let mut cands: Vec<(i64, Value)> = d
            .get("items")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter(|v| v.pointer("/status/embeddable").and_then(Value::as_bool) != Some(false))
                    .map(|v| {
                        let title = v.pointer("/snippet/title").and_then(Value::as_str).unwrap_or("");
                        let channel = v.pointer("/snippet/channelTitle").and_then(Value::as_str).unwrap_or("");
                        let dur = iso_dur(v.pointer("/contentDetails/duration").and_then(Value::as_str).unwrap_or(""));
                        let sc = score(title, channel, dur, track);
                        (sc, json!({ "id": v.get("id"), "title": title, "channel": channel, "dur": dur, "score": sc }))
                    })
                    .collect()
            })
            .unwrap_or_default();
        cands.sort_by(|a, b| b.0.cmp(&a.0));
        Ok(cands.into_iter().map(|c| c.1).collect())
    }

    // ---------- Кэш: { trackId: { cands, pick, manual, offset, at } } ----------
    pub fn get(&self, id: &str) -> Option<Value> {
        self.data.lock().unwrap().get(id).cloned()
    }

    pub fn set(&self, id: &str, entry: Value) -> Value {
        let mut d = self.data.lock().unwrap();
        d.insert(id.to_string(), entry.clone());
        self.write(&d);
        entry
    }

    pub fn clear(&self) {
        let mut d = self.data.lock().unwrap();
        d.clear();
        self.write(&d);
    }

    pub fn size(&self) -> usize {
        self.data.lock().unwrap().len()
    }

    fn write(&self, d: &HashMap<String, Value>) {
        if let Ok(t) = serde_json::to_string(d) {
            let _ = std::fs::write(&self.file, t);
        }
    }
}

/// Достаёт id ролика из ссылки YouTube (watch, youtu.be, shorts, embed) или из самого id.
pub fn parse_video_id(text: &str) -> Option<String> {
    let s = text.trim();
    if BARE_ID.is_match(s) {
        return Some(s.to_string());
    }
    VIDEO_ID.captures(s).and_then(|m| m.get(1)).map(|m| m.as_str().to_string())
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
