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
static CH_SUFFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r" (official|music|vevo|topic)$").unwrap());
// «настоящий клип»: official music video, официальный клип, MV…
static CLIP_WORDS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(official music video|official video|music video|official mv|\bmv\b|официальный клип|официальное видео|премьера клипа|\bклип\b)").unwrap()
});
static OFFICIAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(official|официальн|премьера)").unwrap());
// хвосты в названии трека, которых обычно нет в названии клипа: (feat. …), [prod. …], ft. …
static TITLE_TAIL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\s*(\(|\[|\s(feat|ft)\.?\s).*$").unwrap());
static ISO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?").unwrap());
static VIDEO_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:youtu\.be/|[?&]v=|/embed/|/shorts/|/live/)([\w-]{11})").unwrap());
static BARE_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\w-]{11}$").unwrap());

/// Версия подбора: записи кэша без клипа, найденные прежним подбором, ищутся заново.
pub const SEARCH_V: i64 = 2;

/// Признаки «не тот ролик» — подстрокой: переводы, лирик-видео, хореография, реакции, «10 часов»…
const BAD_SUB: [&str; 40] = [
    "lyric", "караоке", "karaoke", "кавер", "nightcore", "tradu", "перевод", "choreograph", "хореограф", "subtitul", "legendad",
    "fanmade", "fan made", "reaction", "реакци", "instrumental", "минусовк", "tutorial", "разбор", "visualizer", "teaser", "тизер",
    "trailer", "трейлер", "snippet", "сниппет", "acoustic", "акустик", "slowed", "sped up", "speed up", "behind the scenes",
    "making of", "dance practice", "dance cover", "color coded", "часов", "hours", "hour version", "текст песни",
];
/// …и целым словом (чтобы «live» не ловилось в «alive», а «edit» — в «edition»).
const BAD_WORD: [&str; 28] = [
    "cover", "live", "remix", "ремикс", "концерт", "concert", "audio", "аудио", "8d", "amv", "edit", "fancam", "letra", "mashup", "loop",
    "extended", "shorts", "dance", "performance", "stage", "fmv", "fan", "текст", "минус", "лайв", "acapella", "lofi", "sub",
];

fn norm(s: &str) -> String {
    let s = s.to_lowercase().replace('ё', "е");
    NON_WORD.replace_all(&s, " ").trim().to_string()
}

/// Кириллица → латиница (чтобы «темнота» совпадала с «temnota»).
fn translit(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        let r = match c {
            'а' => "a",
            'б' => "b",
            'в' => "v",
            'г' => "g",
            'д' => "d",
            'е' | 'ё' | 'э' => "e",
            'ж' => "zh",
            'з' => "z",
            'и' => "i",
            'й' | 'ы' => "y",
            'к' => "k",
            'л' => "l",
            'м' => "m",
            'н' => "n",
            'о' => "o",
            'п' => "p",
            'р' => "r",
            'с' => "s",
            'т' => "t",
            'у' => "u",
            'ф' => "f",
            'х' => "h",
            'ц' => "ts",
            'ч' => "ch",
            'ш' => "sh",
            'щ' => "sch",
            'ъ' | 'ь' => "",
            'ю' => "yu",
            'я' => "ya",
            _ => {
                out.push(c);
                continue;
            }
        };
        out.push_str(r);
    }
    out
}

/// Есть ли фраза в тексте (оба уже нормализованы): напрямую или в транслите.
fn has(text: &str, phrase: &str) -> bool {
    !phrase.is_empty() && (text.contains(phrase) || translit(text).contains(&translit(phrase)))
}

fn has_word(text: &str, w: &str) -> bool {
    format!(" {text} ").contains(&format!(" {w} "))
}

/// ISO 8601 (PT3M25S) → секунды
fn iso_dur(s: &str) -> i64 {
    let Some(m) = ISO.captures(s) else { return 0 };
    let g = |i: usize| m.get(i).and_then(|x| x.as_str().parse::<i64>().ok()).unwrap_or(0);
    g(1) * 86400 + g(2) * 3600 + g(3) * 60 + g(4)
}

/// Название трека без хвостов (feat., скобки).
fn short_title(track: &Value) -> String {
    let t = track.get("title").and_then(Value::as_str).unwrap_or("");
    let c = TITLE_TAIL.replace(t, "").trim().to_string();
    if c.is_empty() {
        t.trim().to_string()
    } else {
        c
    }
}

/// Оценка «насколько это официальный клип именно этого трека» и есть ли в ролике название трека.
fn score(title: &str, channel: &str, dur: i64, views: u64, max_views: u64, track: &Value) -> (i64, bool) {
    let t = norm(title);
    let ch = norm(channel);
    let tt = norm(&short_title(track));
    let artists: Vec<String> = track
        .get("artists")
        .and_then(Value::as_array)
        .map(|a| a.iter().take(3).filter_map(Value::as_str).map(norm).filter(|x| !x.is_empty()).collect())
        .unwrap_or_default();
    let mut s = 0;
    let title_ok = has(&t, &tt);
    if title_ok {
        s += 4;
    }
    if artists.iter().any(|a| has(&t, a) || has(&ch, a)) {
        s += 3;
    }
    let ch_base = CH_SUFFIX.replace(&ch, "").to_string();
    if artists.iter().any(|a| has(&ch_base, a)) {
        s += 1; // канал самого исполнителя
    }
    if ch.replace(char::is_whitespace, "").ends_with("vevo") {
        s += 2;
    }
    if CLIP_WORDS.is_match(&t) {
        s += 3;
    } else if OFFICIAL.is_match(&t) {
        s += 1;
    }
    if ch.ends_with(" topic") {
        s -= 5; // автоканалы YouTube с одной обложкой
    }
    let mut bad = 0;
    for w in BAD_SUB {
        if t.contains(w) && !tt.contains(w) {
            bad += 4;
        }
    }
    for w in BAD_WORD {
        if has_word(&t, w) && !has_word(&tt, w) {
            bad += 4;
        }
    }
    s -= bad.min(8);
    let td = track.get("duration").and_then(Value::as_i64).unwrap_or(0);
    if td > 0 && dur > 0 {
        if (dur - td).abs() <= 15 {
            s += 1;
        }
        // часовые подборки и короткие нарезки
        if dur as f64 > td as f64 * 2.0 + 60.0 || (dur as f64) < td as f64 * 0.5 {
            s -= 3;
        }
    }
    // у оригинального клипа просмотров обычно больше, чем у перезаливов, переводов и нарезок
    if views > 0 && max_views > 0 {
        let rel = (views as f64 / max_views as f64).log10();
        s += ((rel + 1.5) * 2.0).round().clamp(0.0, 3.0) as i64;
    }
    (s, title_ok)
}

/// Номер подходящего клипа в списке кандидатов (или null — подходящего нет).
pub fn pick_index(cands: &[Value]) -> Value {
    cands
        .iter()
        .position(|c| c["ok"].as_bool().unwrap_or(false) && c["score"].as_i64().unwrap_or(-99) >= 6)
        .map(|i| json!(i))
        .unwrap_or(Value::Null)
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
        let http = crate::net::builder().timeout(Duration::from_secs(15)).build().expect("http client");
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

    /// Поиск роликов (100 единиц квоты).
    async fn search_ids(&self, key: &str, q: &str) -> ApiResult<Vec<String>> {
        let j = self
            .get_json("search", &[("part", "snippet"), ("type", "video"), ("videoEmbeddable", "true"), ("maxResults", "12"), ("q", q), ("key", key)])
            .await?;
        Ok(j.get("items")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|i| i.pointer("/id/videoId").and_then(Value::as_str).map(String::from)).collect())
            .unwrap_or_default())
    }

    /// Подробности роликов (1 единица квоты) и оценка каждого: ролики с названием трека впереди, дальше — по оценке.
    async fn rate(&self, key: &str, ids: &[String], track: &Value) -> ApiResult<Vec<Value>> {
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let d = self.get_json("videos", &[("part", "contentDetails,status,snippet,statistics"), ("id", &ids.join(",")), ("key", key)]).await?;
        let items: Vec<&Value> = d
            .get("items")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter(|v| v.pointer("/status/embeddable").and_then(Value::as_bool) != Some(false)).collect())
            .unwrap_or_default();
        let views = |v: &Value| v.pointer("/statistics/viewCount").and_then(Value::as_str).and_then(|x| x.parse::<u64>().ok()).unwrap_or(0);
        let max_views = items.iter().map(|v| views(v)).max().unwrap_or(0);
        let mut cands: Vec<(bool, i64, Value)> = items
            .iter()
            .map(|v| {
                let title = v.pointer("/snippet/title").and_then(Value::as_str).unwrap_or("");
                let channel = v.pointer("/snippet/channelTitle").and_then(Value::as_str).unwrap_or("");
                let dur = iso_dur(v.pointer("/contentDetails/duration").and_then(Value::as_str).unwrap_or(""));
                let vw = views(v);
                let (sc, ok) = score(title, channel, dur, vw, max_views, track);
                (ok, sc, json!({ "id": v.get("id"), "title": title, "channel": channel, "dur": dur, "views": vw, "score": sc, "ok": ok }))
            })
            .collect();
        cands.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
        Ok(cands.into_iter().map(|c| c.2).collect())
    }

    /// Кандидаты для трека { id, title, artists: [названия], duration }, лучшие первыми.
    /// Сначала «исполнитель название клип / official music video»; если ничего похожего — ещё раз без этих слов.
    pub async fn search(&self, key: &str, track: &Value) -> ApiResult<Vec<Value>> {
        let artist = track.pointer("/artists/0").and_then(Value::as_str).unwrap_or("");
        let title = short_title(track);
        let cyr = format!("{title}{artist}").to_lowercase().chars().any(|c| ('а'..='я').contains(&c) || c == 'ё');
        let q = format!("{artist} {title} {}", if cyr { "клип" } else { "official music video" }).trim().to_string();
        let mut ids = self.search_ids(key, &q).await?;
        let mut cands = self.rate(key, &ids, track).await?;
        let good = cands.first().is_some_and(|x| x["ok"].as_bool().unwrap_or(false) && x["score"].as_i64().unwrap_or(-99) >= 7);
        if !good {
            let q2 = format!("{artist} {title}").trim().to_string();
            for id in self.search_ids(key, &q2).await? {
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
            cands = self.rate(key, &ids, track).await?;
        }
        cands.truncate(12);
        Ok(cands)
    }

    // ---------- Кэш: { trackId: { cands, pick, manual, offset, at, v } } ----------
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

#[cfg(test)]
mod tests {
    use super::*;

    fn rank(track: Value, vids: &[(&str, &str, i64, u64)]) -> Vec<(String, i64, bool)> {
        let max = vids.iter().map(|v| v.3).max().unwrap_or(0);
        let mut r: Vec<(String, i64, bool)> = vids
            .iter()
            .map(|(t, c, d, v)| {
                let (s, ok) = score(t, c, *d, *v, max, &track);
                (t.to_string(), s, ok)
            })
            .collect();
        r.sort_by(|a, b| b.2.cmp(&a.2).then(b.1.cmp(&a.1)));
        r
    }

    #[test]
    fn let_you_down_prefers_official_mv_over_translation() {
        let track = json!({ "title": "Let You Down", "artists": ["Dawid Podsiadło"], "duration": 227 });
        let r = rank(track, &[
            ("Dawid Podsiadło - Let You Down (tradução)", "Insight Lyrics", 226, 2_000_000),
            ("Cyberpunk: Edgerunners — Ending Theme | Let You Down by Dawid Podsiadło | Netflix", "Cyberpunk 2077", 284, 40_000_000),
            ("Cyberpunk: Edgerunners AMV - Ending Theme | Let You Down by Dawid Podsiadło | Netflix", "AKANE.e_x", 248, 300_000),
            ("Cyberpunk: Edgerunners | Ending Theme | Let You Down by Dawid Podsiadło | Netflix | 4K", "The Alomix", 284, 3_000_000),
            ("Dawid Podsiadło - Let You Down (Lyrics)", "BangersOnly", 227, 5_000_000),
            ("Let You Down", "Dawid Podsiadlo - Topic", 227, 8_000_000),
        ]);
        assert!(r[0].0.contains("Cyberpunk: Edgerunners — Ending Theme"), "{r:?}");
    }

    #[test]
    fn firestarter_prefers_music_video_over_choreography() {
        let track = json!({ "title": "FIRESTARTER", "artists": ["K/DA"], "duration": 200 });
        let r = rank(track, &[
            ("K/DA – FIRESTARTER – Official Choreography Video | League of Legends", "League of Legends", 196, 6_000_000),
            ("K/DA - FIRESTARTER ft. MIYEON and SOYEON of i-dle, Sophie Powers, Mimi Webb (Official Music Video)", "League of Legends", 207, 20_000_000),
            ("[KPOP IN PUBLIC | ONE TAKE] K/DA - 'FIRESTARTER' | dance cover by CDLteam", "CDL_TEAMdance", 191, 200_000),
            ("K/DA - POP/STARS (ft. Madison Beer, (G)I-DLE, Jaira Burns) | Music Video - League of Legends", "League of Legends", 203, 600_000_000),
        ]);
        assert!(r[0].0.contains("Official Music Video"), "{r:?}");
    }

    #[test]
    fn cyrillic_title_matches_latin_video() {
        let track = json!({ "title": "Темнота", "artists": ["aikko"], "duration": 180 });
        let r = rank(track, &[("aikko - temnota (mood video)", "aikko", 182, 100_000), ("Pyrokinesis - В городе где гаснут фонари (2019)", "x", 209, 1_000_000)]);
        assert!(r[0].2 && r[0].0.contains("temnota"), "{r:?}");
        assert!(pick_index(&[json!({ "ok": r[0].2, "score": r[0].1 })]).is_number(), "{r:?}");
    }

    #[test]
    fn title_tail_is_dropped() {
        assert_eq!(short_title(&json!({ "title": "Song (feat. Someone)" })), "Song");
        assert_eq!(short_title(&json!({ "title": "Song ft. Someone" })), "Song");
        assert_eq!(short_title(&json!({ "title": "(Intro)" })), "(Intro)");
    }
}
