//! Клиент неофициального API Zvuk (zvuk.com): тот же GraphQL-эндпоинт, что у веб-плеера, и пара REST-методов «tiny».

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};

use futures::future::try_join_all;
use reqwest::header::{HeaderMap, HeaderValue, LOCATION, SET_COOKIE};
use serde::Serialize;
use serde_json::{json, Map, Value};

const GRAPHQL_URL: &str = "https://zvuk.com/api/v1/graphql";
const TINY_URL: &str = "https://zvuk.com/api/tiny";
#[cfg(not(target_os = "android"))]
const DEFAULT_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0";
/// На телефоне — как мобильный браузер на движке Chromium (тот же, что у Android WebView)
#[cfg(target_os = "android")]
const DEFAULT_UA: &str = "Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36";
static UA: OnceLock<String> = OnceLock::new();

/// User-Agent по версии встроенного в Windows движка WebView2 (это Edge той же версии): приложение
/// представляется тем, чем и является, а строка не устаревает — движок обновляется вместе с Windows.
pub fn set_engine_version(version: &str) {
    if let Some(major) = version.split('.').next().filter(|m| !m.is_empty() && m.chars().all(|c| c.is_ascii_digit())) {
        let _ = UA.set(format!(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{major}.0.0.0 Safari/537.36 Edg/{major}.0.0.0"
        ));
    }
}

pub fn user_agent() -> &'static str {
    UA.get().map(String::as_str).unwrap_or(DEFAULT_UA)
}

// ---------- Бережный режим: без всплесков запросов, с паузой после предупреждения защиты Zvuk ----------
/// Сколько запросов к API может идти одновременно.
const MAX_PARALLEL: usize = 4;
/// Минимальный промежуток между началами запросов (не чаще ~11 в секунду, как при быстрой работе в веб-плеере).
const GAP: Duration = Duration::from_millis(90);

struct Pace {
    slots: tokio::sync::Semaphore,
    next: Mutex<Instant>,
    blocked_until: Mutex<Option<Instant>>,
    strikes: AtomicU32,
}

impl Pace {
    fn new() -> Self {
        Self { slots: tokio::sync::Semaphore::new(MAX_PARALLEL), next: Mutex::new(Instant::now()), blocked_until: Mutex::new(None), strikes: AtomicU32::new(0) }
    }

    fn check(&self) -> ApiResult<()> {
        let until = *self.blocked_until.lock().unwrap();
        match until {
            Some(t) if t > Instant::now() => {
                let secs = (t - Instant::now()).as_secs().max(1);
                Err(ApiError::new("BLOCKED", format!("Zvuk попросил сделать паузу (защита от ботов). Приложение не обращается к нему ещё {secs} с — так безопаснее для аккаунта.")))
            }
            _ => Ok(()),
        }
    }

    /// Дождаться своей очереди: свободного слота и промежутка после предыдущего запроса.
    async fn turn(&self) -> ApiResult<tokio::sync::SemaphorePermit<'_>> {
        self.check()?;
        let permit = self.slots.acquire().await.map_err(|_| ApiError::new("NETWORK", "Клиент Zvuk остановлен"))?;
        self.gap().await;
        self.check()?;
        Ok(permit)
    }

    async fn gap(&self) {
        let wait = {
            let mut next = self.next.lock().unwrap();
            let now = Instant::now();
            let start = (*next).max(now);
            *next = start + GAP;
            start - now
        };
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
    }

    /// Ответ защиты от ботов (418/429/страница проверки): замолкаем для всех запросов.
    /// 30 с → 1 → 2 → 4 → 8 → 15 мин при повторах подряд; Retry-After от сервера важнее.
    fn blocked(&self, retry_after: Option<u64>) {
        let n = self.strikes.fetch_add(1, Ordering::SeqCst).min(5);
        let secs = retry_after.unwrap_or(30u64 << n).clamp(15, 900);
        *self.blocked_until.lock().unwrap() = Some(Instant::now() + Duration::from_secs(secs));
    }

    fn passed(&self) {
        self.strikes.store(0, Ordering::SeqCst);
    }
}

// ---------- Кэш ответов: повторные заходы на те же страницы не стучатся в Zvuk ----------
const CACHE_MAX: usize = 240;

/// Сколько секунд можно отдавать ответ метода из памяти (None — метод не кэшируется: волны, радио,
/// коллекция, история и все изменения всегда идут в Zvuk).
fn cache_ttl(method: &str) -> Option<u64> {
    Some(match method {
        "getRelease" | "getReleasesShort" | "getArtistsShort" | "getLyrics" | "getWaves" => 3600,
        "getArtist" | "getArtistTracks" | "getTracks" | "getRelatedTracks" | "recommendations" | "synthesisPlaylists" | "popular" => 600,
        "getPlaylist" | "getPlaylistsShort" | "search" | "quickSearch" | "autocomplete" => 180,
        // ссылка на поток живёт сутки — держим её 30 минут, чтобы повтор и перемотка не запрашивали её заново
        "getStream" => 1800,
        _ => return None,
    })
}

/// Изменения плейлистов сбрасывают их копии в кэше.
fn drops_playlists(method: &str) -> bool {
    matches!(method, "createPlaylist" | "addTracksToPlaylist" | "updatePlaylist" | "renamePlaylist" | "deletePlaylist")
}

// ---------- Фрагменты полей ----------
const IMG: &str = "image { src palette }";
fn artist_short() -> String {
    format!("id title {IMG}")
}
fn release_short() -> String {
    format!("id title date type explicit {IMG} artists {{ id title }}")
}
fn track() -> String {
    format!(
        "id title duration explicit hasFlac lyrics availability
  artists {{ id title {IMG} }}
  release {{ id title date type {IMG} }}"
    )
}
const PLAYLIST_SHORT: &str = "id title description duration isPublic userId image { src palette } coverV1 { src }";

/// ID «Плейлистов для вас» (синтезированные под пользователя), стабильны для аккаунта.
pub const SYNTHESIS_PLAYLIST_IDS: [&str; 8] = ["3", "4", "6", "11", "12", "13", "14", "15"];

// ---------- Вкладка «Популярное»: плейлисты редакции Звука, которые она регулярно обновляет ----------
/// «Топ 100» — самые прослушиваемые треки дня.
pub const CHART_PLAYLIST_ID: &str = "1062105";
/// Чарты и хиты: «Топ 100», «Сейчас в тренде», «Актуальные хиты», «Вирусные хиты», «ХИТЫ: русская музыка», «Русские хиты | Свежее».
pub const CHART_PLAYLIST_IDS: [&str; 6] = ["1062105", "12223715", "5607924", "6836834", "7843601", "8404351"];
/// «Главные хиты» 2010-х, 2000-х, 90-х и 80-х.
pub const DECADE_PLAYLIST_IDS: [&str; 4] = ["14613629", "14613627", "14613624", "14613623"];

#[derive(Debug, Clone, Serialize)]
pub struct ApiError {
    pub code: String,
    pub message: String,
}

impl ApiError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

pub type ApiResult<T = Value> = Result<T, ApiError>;

/// Zvuk иногда присылает null внутри списков (например, среди релизов) — вычищаем их везде.
fn drop_nulls(v: Value) -> Value {
    match v {
        Value::Array(a) => Value::Array(a.into_iter().filter(|x| !x.is_null()).map(drop_nulls).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (k, drop_nulls(v))).collect()),
        x => x,
    }
}

/// Строковый id из числа или строки (как `String(id)` в JS).
/// Вместо JSON пришла веб-страница — это проверка защиты от ботов.
fn looks_like_html(text: &str) -> bool {
    let head = text.trim_start().get(..15).unwrap_or("").to_ascii_lowercase();
    head.starts_with("<!doctype html") || head.starts_with("<html")
}

pub fn id_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Null => String::new(),
        x => x.to_string(),
    }
}

fn ids_of(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().map(id_str).filter(|s| !s.is_empty()).collect()).unwrap_or_default()
}

fn arr(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}

/// Число в записи JS (0.5 → "0.5", 1 → "1").
fn js_num(v: &Value, dflt: f64) -> String {
    let f = v.as_f64().unwrap_or(dflt);
    if f.fract() == 0.0 && f.abs() < 1e15 {
        format!("{}", f as i64)
    } else {
        format!("{f}")
    }
}

pub struct ZvukClient {
    http: reqwest::Client,
    token: RwLock<Option<String>>,
    jar: Mutex<BTreeMap<String, String>>,
    pace: Pace,
    cache: Mutex<HashMap<String, (Instant, Value)>>,
}

pub struct Profile {
    pub id: String,
    pub name: Option<String>,
    pub image: Option<String>,
    pub is_anonymous: bool,
    #[allow(dead_code)]
    pub token: Option<String>,
    pub offline: bool,
}

impl ZvukClient {
    pub fn new() -> Self {
        let http = crate::net::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(20))
            .build()
            .expect("http client");
        Self { http, token: RwLock::new(None), jar: Mutex::new(BTreeMap::new()), pace: Pace::new(), cache: Mutex::new(HashMap::new()) }
    }

    pub fn token(&self) -> Option<String> {
        self.token.read().unwrap().clone()
    }

    pub fn set_token(&self, token: Option<String>) {
        let token = token.filter(|t| !t.is_empty());
        let mut cur = self.token.write().unwrap();
        if *cur != token {
            // ответы другого аккаунта (или гостя) не должны попасть в новый
            self.cache.lock().unwrap().clear();
        }
        *cur = token;
    }

    fn cache_get(&self, key: &str) -> Option<Value> {
        let mut c = self.cache.lock().unwrap();
        match c.get(key) {
            Some((until, v)) if *until > Instant::now() => Some(v.clone()),
            Some(_) => {
                c.remove(key);
                None
            }
            None => None,
        }
    }

    fn cache_put(&self, key: String, v: &Value, ttl: u64) {
        let mut c = self.cache.lock().unwrap();
        if c.len() >= CACHE_MAX {
            let now = Instant::now();
            c.retain(|_, (until, _)| *until > now);
            if c.len() >= CACHE_MAX {
                // всё ещё полон — выкидываем то, что истечёт раньше всего
                if let Some(k) = c.iter().min_by_key(|(_, (u, _))| *u).map(|(k, _)| k.clone()) {
                    c.remove(&k);
                }
            }
        }
        c.insert(key, (Instant::now() + Duration::from_secs(ttl), v.clone()));
    }

    // ---------- HTTP ----------
    fn store_cookies(&self, headers: &HeaderMap) {
        let mut jar = self.jar.lock().unwrap();
        for c in headers.get_all(SET_COOKIE) {
            let Ok(c) = c.to_str() else { continue };
            let pair = c.split(';').next().unwrap_or("");
            if let Some(i) = pair.find('=') {
                if i > 0 {
                    jar.insert(pair[..i].trim().to_string(), pair[i + 1..].trim().to_string());
                }
            }
        }
    }

    /// Запрос с повтором при перенаправлении: защита сайта ставит cookie и отправляет на тот же адрес.
    async fn fetch(&self, method: &str, url: &str, body: Option<&str>, token: Option<&str>) -> ApiResult<(u16, String)> {
        let mut url = url.to_string();
        let _slot = self.pace.turn().await?;
        for step in 0..6 {
            if step > 0 {
                self.pace.gap().await;
            }
            let mut rq = if method == "POST" { self.http.post(&url) } else { self.http.get(&url) };
            rq = rq
                .header("User-Agent", user_agent())
                .header("Accept", "application/json, text/plain, */*")
                .header("Accept-Language", "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7")
                .header("Referer", "https://zvuk.com/")
                .header("Origin", "https://zvuk.com");
            if let Some(t) = token {
                rq = rq.header("X-Auth-Token", t);
            }
            let cookie = {
                let jar = self.jar.lock().unwrap();
                jar.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("; ")
            };
            if !cookie.is_empty() {
                if let Ok(h) = HeaderValue::from_str(&cookie) {
                    rq = rq.header("Cookie", h);
                }
            }
            if let Some(b) = body {
                rq = rq.header("Content-Type", "application/json").body(b.to_string());
            }
            let res = rq.send().await.map_err(|e| ApiError::new("NETWORK", format!("Нет связи с Zvuk: {}", short_err(&e))))?;
            self.store_cookies(res.headers());
            let status = res.status().as_u16();
            if matches!(status, 301 | 302 | 303 | 307 | 308) {
                if let Some(loc) = res.headers().get(LOCATION).and_then(|l| l.to_str().ok()) {
                    url = reqwest::Url::parse(&url).and_then(|b| b.join(loc)).map(|u| u.to_string()).unwrap_or_else(|_| loc.to_string());
                    continue;
                }
            }
            let retry_after = res.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|s| s.trim().parse::<u64>().ok());
            let text = res.text().await.map_err(|e| ApiError::new("NETWORK", format!("Нет связи с Zvuk: {}", short_err(&e))))?;
            if status == 418 || status == 429 || looks_like_html(&text) {
                self.pace.blocked(retry_after);
            } else if status < 400 {
                self.pace.passed();
            }
            return Ok((status, text));
        }
        Err(ApiError::new("NETWORK", "Слишком много перенаправлений"))
    }

    fn parse_json(status: u16, text: &str) -> ApiResult<Value> {
        if status == 418 || status == 429 || looks_like_html(text) {
            return Err(ApiError::new("BLOCKED", "Zvuk временно ограничил доступ (защита от ботов). Приложение сделает паузу — попробуйте через минуту."));
        }
        if status == 401 || status == 403 {
            return Err(ApiError::new("UNAUTHORIZED", "Сессия Zvuk недействительна — войдите заново."));
        }
        let data: Value = serde_json::from_str(text).map_err(|_| ApiError::new("BAD_RESPONSE", format!("Неожиданный ответ Zvuk (HTTP {status})")))?;
        if status >= 400 && data.get("errors").is_none() {
            let msg = data.get("message").and_then(Value::as_str).map(String::from).unwrap_or_else(|| format!("Ошибка Zvuk (HTTP {status})"));
            return Err(ApiError::new(&format!("HTTP_{status}"), msg));
        }
        Ok(data)
    }

    pub async fn gql(&self, operation: &str, query: &str, variables: Value) -> ApiResult<Value> {
        let body = json!({ "operationName": operation, "query": query, "variables": variables }).to_string();
        let token = self.token();
        let (status, text) = self.fetch("POST", GRAPHQL_URL, Some(&body), token.as_deref()).await?;
        let mut data = Self::parse_json(status, &text)?;
        if let Some(errs) = data.get("errors").and_then(Value::as_array).filter(|e| !e.is_empty()) {
            let msg = errs.iter().filter_map(|e| e.get("message").and_then(Value::as_str)).collect::<Vec<_>>().join("; ");
            let unauth = errs.iter().any(|e| {
                let m = e.get("message").and_then(Value::as_str).unwrap_or("").to_lowercase();
                m.contains("unauth") || m.contains("forbidden") || m.contains("not authorized") || m.contains("auth")
                    || e.pointer("/extensions/code").and_then(Value::as_str) == Some("UNAUTHENTICATED")
            });
            let has_data = data.get("data").map(|d| !d.is_null()).unwrap_or(false);
            if !has_data || unauth {
                return Err(ApiError::new(if unauth { "UNAUTHORIZED" } else { "GRAPHQL" }, msg));
            }
        }
        let d = data.get_mut("data").map(Value::take).unwrap_or(Value::Null);
        Ok(drop_nulls(if d.is_null() { json!({}) } else { d }))
    }

    async fn tiny_with(&self, path: &str, params: &[(&str, &str)], token: Option<&str>) -> ApiResult<Value> {
        let mut url = format!("{TINY_URL}{path}");
        if !params.is_empty() {
            let qs = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(params).finish();
            url.push('?');
            url.push_str(&qs);
        }
        let (status, text) = self.fetch("GET", &url, None, token).await?;
        let mut data = Self::parse_json(status, &text)?;
        match data.get_mut("result") {
            Some(r) => Ok(r.take()),
            None => Ok(data),
        }
    }

    async fn tiny(&self, path: &str, params: &[(&str, &str)]) -> ApiResult<Value> {
        let token = self.token();
        self.tiny_with(path, params, token.as_deref()).await
    }

    // ---------- Профиль и подписка ----------
    pub async fn anonymous_token(&self) -> ApiResult<Option<String>> {
        let r = self.tiny_with("/profile", &[], None).await?;
        Ok(r.get("token").or_else(|| r.pointer("/profile/token")).and_then(Value::as_str).map(String::from))
    }

    pub async fn profile_with(&self, token: Option<&str>) -> ApiResult<Profile> {
        let r = self.tiny_with("/profile", &[], token).await?;
        let p = r.get("profile").filter(|p| p.is_object()).unwrap_or(&r);
        let s = |v: Option<&Value>| v.and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from);
        let id = p.get("id").filter(|v| !v.is_null()).or_else(|| r.get("id")).map(id_str).unwrap_or_default();
        let image = match p.get("image") {
            Some(Value::Object(o)) => o.get("src").and_then(Value::as_str).map(String::from),
            Some(Value::String(x)) => Some(x.clone()),
            _ => None,
        };
        let anon = r.get("is_anonymous").or_else(|| p.get("is_anonymous")).and_then(Value::as_bool).unwrap_or(false);
        Ok(Profile {
            id,
            name: s(p.get("name")).or_else(|| s(p.get("username"))),
            image,
            is_anonymous: anon,
            token: s(r.get("token")).or_else(|| s(p.get("token"))),
            offline: false,
        })
    }

    pub async fn get_subscription(&self) -> ApiResult {
        match self
            .gql("getSubscriptions", "query getSubscriptions { subscriptions { mainSubscription { id name status expirationDate isTrial } } }", json!({}))
            .await
        {
            Ok(d) => Ok(d.pointer("/subscriptions/mainSubscription").cloned().unwrap_or(Value::Null)),
            Err(_) => Ok(Value::Null),
        }
    }

    // ---------- Поиск ----------
    pub async fn quick_search(&self, query: &str, limit: i64) -> ApiResult {
        let q = format!(
            "query quickSearch($query: String, $limit: Int) {{
        quickSearch(query: $query, limit: $limit) {{
          content {{ __typename
            ... on Track {{ {t} }}
            ... on Artist {{ {a} }}
            ... on Release {{ {r} }}
            ... on Playlist {{ {PLAYLIST_SHORT} }}
          }}
        }}
      }}",
            t = track(),
            a = artist_short(),
            r = release_short()
        );
        let d = self.gql("quickSearch", &q, json!({ "query": query, "limit": limit })).await?;
        let items: Vec<Value> = arr(d.pointer("/quickSearch/content").unwrap_or(&Value::Null))
            .into_iter()
            .filter(|x| matches!(x.get("__typename").and_then(Value::as_str), Some("Track" | "Artist" | "Release" | "Playlist")))
            .collect();
        Ok(Value::Array(items))
    }

    pub async fn search(&self, query: &str, limit: i64) -> ApiResult {
        let q = format!(
            "query search($query: String, $limit: Int) {{
        search(query: $query) {{
          tracks(limit: $limit) {{ items {{ {t} }} }}
          artists(limit: $limit) {{ items {{ {a} }} }}
          releases(limit: $limit) {{ items {{ {r} }} }}
          playlists(limit: $limit) {{ items {{ {PLAYLIST_SHORT} }} }}
        }}
      }}",
            t = track(),
            a = artist_short(),
            r = release_short()
        );
        let d = self.gql("search", &q, json!({ "query": query, "limit": limit })).await?;
        let s = d.get("search").cloned().unwrap_or(Value::Null);
        let items = |k: &str| Value::Array(arr(s.pointer(&format!("/{k}/items")).unwrap_or(&Value::Null)));
        Ok(json!({ "tracks": items("tracks"), "artists": items("artists"), "releases": items("releases"), "playlists": items("playlists") }))
    }

    pub async fn autocomplete(&self, query: &str) -> ApiResult {
        let d = self
            .gql(
                "getSearchAutocomplete",
                "query getSearchAutocomplete($query: String!, $limit: Int = 6) { searchAutocomplete(limit: $limit, query: $query) { content } }",
                json!({ "query": query }),
            )
            .await?;
        Ok(Value::Array(arr(d.pointer("/searchAutocomplete/content").unwrap_or(&Value::Null))))
    }

    // ---------- Треки ----------
    pub async fn get_tracks(&self, ids: &[String]) -> ApiResult<Vec<Value>> {
        let list: Vec<String> = ids.iter().filter(|s| !s.is_empty()).cloned().collect();
        if list.is_empty() {
            return Ok(vec![]);
        }
        let q = format!("query getTracks($ids: [ID!]!) {{ getTracks(ids: $ids) {{ {} }} }}", track());
        let parts = try_join_all(list.chunks(100).map(|part| self.gql("getTracks", &q, json!({ "ids": part })))).await?;
        let mut by_id: HashMap<String, Value> = HashMap::new();
        for p in parts {
            for t in arr(p.get("getTracks").unwrap_or(&Value::Null)) {
                by_id.insert(id_str(&t["id"]), t);
            }
        }
        Ok(list.iter().filter_map(|id| by_id.get(id).cloned()).collect())
    }

    /// Ссылка на поток. quality: flac | high | mid. Возвращает лучшее доступное не выше запрошенного.
    pub async fn get_stream(&self, track_id: &str, quality: &str) -> ApiResult {
        let d = self
            .gql(
                "getStream",
                "query getStream($ids: [ID!]!) { mediaContents(ids: $ids) { __typename ... on Track { stream { expire flac high mid } } } }",
                json!({ "ids": [track_id] }),
            )
            .await?;
        let st = d.pointer("/mediaContents/0/stream").filter(|s| s.is_object()).ok_or_else(|| ApiError::new("NO_STREAM", "Трек недоступен для воспроизведения"))?;
        let order: &[&str] = match quality {
            "flac" => &["flac", "high", "mid"],
            "high" => &["high", "mid"],
            _ => &["mid"],
        };
        for q in order {
            if let Some(url) = st.get(*q).and_then(Value::as_str).filter(|s| !s.is_empty()) {
                let path = url.split('?').next().unwrap_or("");
                let preview = path.ends_with("/preview");
                return Ok(json!({ "url": url, "quality": q, "expire": st.get("expire").cloned().unwrap_or(Value::Null), "preview": preview }));
            }
        }
        Err(ApiError::new("NO_STREAM", "Для этого трека нет доступного потока"))
    }

    pub async fn get_lyrics(&self, track_id: &str) -> ApiResult {
        match self.tiny("/lyrics", &[("track_id", track_id)]).await {
            Ok(r) => {
                let text = r.get("lyrics").filter(|l| !l.is_null() && l.as_str() != Some(""));
                match text {
                    None => Ok(Value::Null),
                    Some(t) => Ok(json!({
                        "type": r.get("type").cloned().unwrap_or(Value::Null),
                        "text": t,
                        "translation": r.get("translation").filter(|x| !x.is_null()).cloned().unwrap_or(Value::Null),
                    })),
                }
            }
            Err(e) if e.code == "HTTP_404" => Ok(Value::Null),
            Err(e) => Err(e),
        }
    }

    pub async fn get_related_tracks(&self, id: &str, limit: i64) -> ApiResult {
        let q = format!("query getRelatedTracks($id: ID!, $limit: Int) {{ relatedTracks(track_id: $id, limit: $limit) {{ {} }} }}", track());
        let d = self.gql("getRelatedTracks", &q, json!({ "id": id, "limit": limit })).await?;
        Ok(Value::Array(arr(d.get("relatedTracks").unwrap_or(&Value::Null))))
    }

    // ---------- Релизы и исполнители ----------
    pub async fn get_release(&self, id: &str) -> ApiResult {
        let q = format!(
            "query getReleases($ids: [ID!]!) {{ getReleases(ids: $ids) {{
        {r}
        genres {{ id name }}
        label {{ id title }}
        tracks {{ {t} }}
        related(limit: 12) {{ {r} }}
      }} }}",
            r = release_short(),
            t = track()
        );
        let d = self.gql("getReleases", &q, json!({ "ids": [id] })).await?;
        Ok(d.pointer("/getReleases/0").cloned().unwrap_or(Value::Null))
    }

    pub async fn get_artist(&self, id: &str) -> ApiResult {
        let q = format!(
            "query getArtists($ids: [ID!]!) {{ getArtists(ids: $ids) {{
        {a}
        secondImage {{ src }}
        description
        collectionItemData {{ likesCount }}
        popularTracks(limit: 20) {{ {t} }}
        releases(limit: 100) {{ {r} }}
        relatedArtists(limit: 14) {{ {a} }}
      }} }}",
            a = artist_short(),
            r = release_short(),
            t = track()
        );
        let d = self.gql("getArtists", &q, json!({ "ids": [id] })).await?;
        Ok(d.pointer("/getArtists/0").cloned().unwrap_or(Value::Null))
    }

    /// Все популярные треки исполнителя одним запросом. Постранично (offset) Zvuk отдаёт их нестабильно:
    /// на стыке страниц треки повторяются, а часть пропадает.
    pub async fn get_artist_tracks(&self, id: &str, limit: i64) -> ApiResult {
        let q = format!("query getArtists($ids: [ID!]!, $limit: Int) {{ getArtists(ids: $ids) {{ id popularTracks(limit: $limit) {{ {} }} }} }}", track());
        let d = self.gql("getArtists", &q, json!({ "ids": [id], "limit": limit.clamp(1, 500) })).await?;
        let mut seen = HashSet::new();
        let list = arr(d.pointer("/getArtists/0/popularTracks").unwrap_or(&Value::Null)).into_iter().filter(|t| seen.insert(id_str(&t["id"]))).collect();
        Ok(Value::Array(list))
    }

    async fn short_list(&self, op: &str, field: &str, fields: &str, ids: &[String], size: usize) -> ApiResult<Vec<Value>> {
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let q = format!("query {op}($ids: [ID!]!) {{ {field}(ids: $ids) {{ {fields} }} }}");
        let parts = try_join_all(ids.chunks(size).map(|part| self.gql(op, &q, json!({ "ids": part })))).await?;
        let mut by_id: HashMap<String, Value> = HashMap::new();
        for p in parts {
            for r in arr(p.get(field).unwrap_or(&Value::Null)) {
                by_id.insert(id_str(&r["id"]), r);
            }
        }
        Ok(ids.iter().filter_map(|x| by_id.get(x).cloned()).collect())
    }

    pub async fn get_releases_short(&self, ids: &[String]) -> ApiResult {
        Ok(Value::Array(self.short_list("getReleases", "getReleases", &release_short(), ids, 100).await?))
    }

    pub async fn get_artists_short(&self, ids: &[String]) -> ApiResult {
        Ok(Value::Array(self.short_list("getArtists", "getArtists", &artist_short(), ids, 100).await?))
    }

    // ---------- Плейлисты ----------
    pub async fn get_playlists_short(&self, ids: &[String]) -> ApiResult {
        let fields = format!("{PLAYLIST_SHORT} tracks {{ id }}");
        let raw = self.short_list("getPlaylists", "getPlaylists", &fields, ids, 50).await?;
        let mut out: Vec<Value> = Vec::with_capacity(raw.len());
        let mut need: Vec<(usize, Vec<String>)> = vec![]; // плейлист без обложки → id первых треков
        for mut r in raw {
            let tids: Vec<String> = arr(r.get("tracks").unwrap_or(&Value::Null)).iter().map(|t| id_str(&t["id"])).collect();
            let has_cover = r.pointer("/coverV1/src").and_then(Value::as_str).map(|s| !s.is_empty()).unwrap_or(false);
            if let Some(o) = r.as_object_mut() {
                o.remove("tracks");
                o.insert("trackCount".into(), json!(tids.len()));
            }
            if !has_cover && !tids.is_empty() {
                need.push((out.len(), tids.into_iter().take(8).collect()));
            }
            out.push(r);
        }
        // Обложка-мозаика из альбомов первых треков (у своих плейлистов Zvuk обложку не хранит)
        if !need.is_empty() {
            let mut all: Vec<String> = vec![];
            let mut seen = HashSet::new();
            for (_, t) in &need {
                for id in t {
                    if seen.insert(id.clone()) {
                        all.push(id.clone());
                    }
                }
            }
            if let Ok(tracks) = self.get_tracks(&all).await {
                let by_id: HashMap<String, &Value> = tracks.iter().map(|t| (id_str(&t["id"]), t)).collect();
                for (i, tids) in need {
                    let mut srcs: Vec<String> = vec![];
                    for id in tids {
                        if let Some(s) = by_id.get(&id).and_then(|t| t.pointer("/release/image/src")).and_then(Value::as_str) {
                            if !srcs.iter().any(|x| x == s) {
                                srcs.push(s.to_string());
                            }
                        }
                        if srcs.len() == 4 {
                            break;
                        }
                    }
                    if let Some(o) = out[i].as_object_mut() {
                        o.insert("mosaic".into(), json!(srcs));
                    }
                }
            }
        }
        Ok(Value::Array(out))
    }

    pub async fn get_playlist(&self, id: &str) -> ApiResult {
        let q = format!("query getPlaylists($ids: [ID!]!) {{ getPlaylists(ids: $ids) {{ {PLAYLIST_SHORT} updated tracks {{ id }} }} }}");
        let d = self.gql("getPlaylists", &q, json!({ "ids": [id] })).await?;
        let Some(mut pl) = d.pointer("/getPlaylists/0").cloned() else { return Ok(Value::Null) };
        let ids: Vec<String> = arr(pl.get("tracks").unwrap_or(&Value::Null)).iter().map(|t| id_str(&t["id"])).collect();
        let tracks = self.get_tracks(&ids).await?;
        let mut mosaic: Vec<String> = vec![];
        for t in &tracks {
            if let Some(s) = t.pointer("/release/image/src").and_then(Value::as_str) {
                if !mosaic.iter().any(|x| x == s) {
                    mosaic.push(s.to_string());
                }
            }
            if mosaic.len() == 4 {
                break;
            }
        }
        if let Some(o) = pl.as_object_mut() {
            o.insert("trackIds".into(), json!(ids));
            o.insert("tracks".into(), Value::Array(tracks));
            o.insert("mosaic".into(), json!(mosaic));
        }
        Ok(pl)
    }

    fn items(track_ids: &[String]) -> Value {
        Value::Array(track_ids.iter().map(|id| json!({ "type": "track", "item_id": id })).collect())
    }

    pub async fn create_playlist(&self, name: &str, track_ids: &[String]) -> ApiResult {
        let d = self
            .gql(
                "createPlayList",
                "mutation createPlayList($items: [PlaylistItem!]!, $name: String!) { playlist { create(items: $items, name: $name) } }",
                json!({ "name": name, "items": Self::items(track_ids) }),
            )
            .await?;
        Ok(json!(d.pointer("/playlist/create").map(id_str).unwrap_or_default()))
    }

    pub async fn add_tracks_to_playlist(&self, pid: &str, track_ids: &[String]) -> ApiResult {
        self.gql(
            "addTracksToPlaylist",
            "mutation addTracksToPlaylist($id: ID!, $items: [PlaylistItem!]!) { playlist { addItems(id: $id, items: $items) } }",
            json!({ "id": pid, "items": Self::items(track_ids) }),
        )
        .await?;
        Ok(json!(true))
    }

    /// Перезаписывает состав плейлиста (используется для удаления треков).
    pub async fn update_playlist(&self, pid: &str, opts: &Value) -> ApiResult {
        let ids = ids_of(opts.get("trackIds").unwrap_or(&Value::Null));
        let name = opts.get("name").and_then(Value::as_str).unwrap_or("");
        let is_public = opts.get("isPublic").map(|v| v.as_bool().unwrap_or(!v.is_null() && v != &json!(0))).unwrap_or(false);
        self.gql(
            "updataPlaylist",
            "mutation updataPlaylist($id: ID!, $items: [PlaylistItem!]!, $isPublic: Boolean!, $name: String!) {
        playlist { update(id: $id, items: $items, isPublic: $isPublic, name: $name) } }",
            json!({ "id": pid, "items": Self::items(&ids), "isPublic": is_public, "name": name }),
        )
        .await?;
        Ok(json!(true))
    }

    pub async fn rename_playlist(&self, pid: &str, name: &str) -> ApiResult {
        self.gql(
            "renamePlaylist",
            "mutation renamePlaylist($id: ID!, $name: String!) { playlist { rename(id: $id, name: $name) } }",
            json!({ "id": pid, "name": name }),
        )
        .await?;
        Ok(json!(true))
    }

    pub async fn delete_playlist(&self, pid: &str) -> ApiResult {
        self.gql("deletePlaylist", "mutation deletePlaylist($id: ID!) { playlist { delete(id: $id) } }", json!({ "id": pid }))
            .await?;
        Ok(json!(true))
    }

    // ---------- Коллекция («Любимое») ----------
    pub async fn get_collection_ids(&self) -> ApiResult {
        let d = self
            .gql(
                "userCollection",
                "query userCollection { collection {
        tracks { id } releases { id } artists { id } playlists { id }
      } }",
                json!({}),
            )
            .await?;
        let c = d.get("collection").cloned().unwrap_or(Value::Null);
        let ids = |k: &str| json!(arr(c.get(k).unwrap_or(&Value::Null)).iter().map(|x| id_str(&x["id"])).collect::<Vec<_>>());
        Ok(json!({ "tracks": ids("tracks"), "releases": ids("releases"), "artists": ids("artists"), "playlists": ids("playlists") }))
    }

    pub async fn get_liked_track_ids(&self) -> ApiResult {
        let d = self
            .gql(
                "userTracks",
                "query userTracks($orderBy: TrackOrderByType, $orderDirection: OrderDirectionType) {
        collection { tracks(orderBy: $orderBy, orderDirection: $orderDirection) { id } } }",
                json!({ "orderBy": "dateAdded", "orderDirection": "desc" }),
            )
            .await?;
        Ok(json!(arr(d.pointer("/collection/tracks").unwrap_or(&Value::Null)).iter().map(|t| id_str(&t["id"])).collect::<Vec<_>>()))
    }

    pub async fn like(&self, kind: &Value, id: &str, add: bool) -> ApiResult {
        let (op, q) = if add {
            ("addItemToCollection", "mutation addItemToCollection($id: ID, $type: CollectionItemType) { collection { addItem(id: $id, type: $type) } }")
        } else {
            (
                "removeItemFromCollection",
                "mutation removeItemFromCollection($id: ID, $type: CollectionItemType) { collection { removeItem(id: $id, type: $type) } }",
            )
        };
        self.gql(op, q, json!({ "id": id, "type": kind })).await?;
        Ok(json!(true))
    }

    pub async fn hide_track(&self, id: &str) -> ApiResult {
        self.gql(
            "addItemToHidden",
            "mutation addItemToHidden($id: ID!, $type: CollectionItemType!) { hidden_collection { addItem(id: $id, type: $type) } }",
            json!({ "id": id, "type": "track" }),
        )
        .await?;
        Ok(json!(true))
    }

    // ---------- Рекомендации, волны, радио ----------
    /// «Моя волна». opts: { energy, fun (0..1), genres: [..], language, instrumental, popularity }
    pub async fn personal_wave(&self, count: i64, opts: &Value) -> ApiResult {
        let mut options = Map::new();
        let energy = opts.get("energy").filter(|v| !v.is_null());
        let fun = opts.get("fun").filter(|v| !v.is_null());
        if energy.is_some() || fun.is_some() {
            options.insert(
                "mood".into(),
                json!(format!("energy:{},fun:{}", js_num(energy.unwrap_or(&Value::Null), 0.5), js_num(fun.unwrap_or(&Value::Null), 0.5))),
            );
        }
        let genres = arr(opts.get("genres").unwrap_or(&Value::Null));
        if !genres.is_empty() {
            options.insert("genre".into(), Value::Array(genres.into_iter().map(|name| json!({ "name": name, "type": "LVL1" })).collect()));
        }
        if let Some(p) = opts.get("popularity").filter(|v| !v.is_null()) {
            options.insert("popular".into(), p.clone());
        }
        let truthy = |v: Option<&Value>| match v {
            Some(Value::Bool(b)) => *b,
            Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0) != 0.0,
            Some(Value::String(s)) => !s.is_empty(),
            Some(Value::Null) | None => false,
            Some(_) => true,
        };
        if truthy(opts.get("instrumental")) {
            options.insert("vocal".into(), json!(0));
        } else if truthy(opts.get("language")) {
            options.insert("language".into(), opts["language"].clone());
            options.insert("vocal".into(), json!(1));
        }
        let q = format!(
            "query getPersonalWave($first: PositiveInt!, $options: PersonalWaveOptions, $waveSrc: MagicSource) {{
        personalWaveContent(first: $first, options: $options, waveSrc: $waveSrc) {{ {} }} }}",
            track()
        );
        let d = self.gql("getPersonalWave", &q, json!({ "first": count, "options": options, "waveSrc": "AMAZME" })).await?;
        Ok(Value::Array(arr(d.get("personalWaveContent").unwrap_or(&Value::Null))))
    }

    pub async fn get_waves(&self, ids: &[String]) -> ApiResult {
        let d = self
            .gql(
                "getWavesShortInfo",
                "query getWavesShortInfo($ids: [ID!]!) { wave { waves(ids: $ids) { id title description image { src } } } }",
                json!({ "ids": ids }),
            )
            .await?;
        Ok(Value::Array(arr(d.pointer("/wave/waves").unwrap_or(&Value::Null))))
    }

    pub async fn wave_content(&self, wave_id: &str) -> ApiResult {
        let q = format!(
            "query waveContent($contentInput: WaveContentInput!) {{ wave {{ waveContent(contentInput: $contentInput) {{
        itemId itemType content {{ __typename ... on Track {{ {} }} }} }} }} }}",
            track()
        );
        let localtime = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let d = self.gql("waveContent", &q, json!({ "contentInput": { "waveId": wave_id, "localtime": localtime } })).await?;
        Ok(Value::Array(
            arr(d.pointer("/wave/waveContent").unwrap_or(&Value::Null))
                .into_iter()
                .filter_map(|x| x.get("content").cloned())
                .filter(|c| c.get("__typename").and_then(Value::as_str) == Some("Track"))
                .collect(),
        ))
    }

    /// Радио по сущности: type = ARTIST | TRACK | RELEASE
    pub async fn radio(&self, kind: &Value, id: &str, cursor: i64, limit: i64) -> ApiResult {
        let q = format!(
            "query getRadioByEntity($id: ID!, $type: RecommenderRadioEntityType!, $limit: NonNegativeInt!, $cursor: NonNegativeInt) {{
        recommenderRadio(onEntity: {{ id: $id, type: $type }}, first: $limit, cursor: $cursor) {{ cursor tracks {{ {} }} }} }}",
            track()
        );
        let d = self.gql("getRadioByEntity", &q, json!({ "id": id, "type": kind, "limit": limit, "cursor": cursor })).await?;
        Ok(json!({
            "cursor": d.pointer("/recommenderRadio/cursor").filter(|c| !c.is_null()).cloned().unwrap_or(json!(0)),
            "tracks": arr(d.pointer("/recommenderRadio/tracks").unwrap_or(&Value::Null)),
        }))
    }

    pub async fn recommendations(&self, pages: &Value) -> ApiResult {
        let q = format!(
            "query getMusicRecommendations($contentType: DynamicBlockContentType!, $itemType: [DynamicBlockItemType!], $pages: [Int!]!) {{
        dynamicBlock(contentType: $contentType, itemType: $itemType, pages: $pages) {{
          totalPages
          pages {{ page items {{
            ... on Artist {{ __typename {a} }}
            ... on Release {{ __typename {r} }}
            ... on Playlist {{ __typename id title duration trackCount image {{ src palette }} coverV1 {{ src }} }}
          }} }}
        }} }}",
            a = artist_short(),
            r = release_short()
        );
        let pages = if pages.is_array() { pages.clone() } else { json!([1]) };
        let d = self
            .gql("getMusicRecommendations", &q, json!({ "contentType": "Music", "itemType": ["Artist", "Release", "Playlist"], "pages": pages }))
            .await?;
        let mut items = vec![];
        for p in arr(d.pointer("/dynamicBlock/pages").unwrap_or(&Value::Null)) {
            for it in arr(p.get("items").unwrap_or(&Value::Null)) {
                if it.get("__typename").and_then(Value::as_str).is_some() {
                    items.push(it);
                }
            }
        }
        Ok(Value::Array(items))
    }

    pub async fn synthesis_playlists(&self) -> ApiResult {
        let ids: Vec<String> = SYNTHESIS_PLAYLIST_IDS.iter().map(|s| s.to_string()).collect();
        Ok(self.get_playlists_short(&ids).await.unwrap_or(json!([])))
    }

    /// Подборки редакции (тот же список, что в разделе «Подборки» веб-плеера).
    async fn editorial_playlists(&self) -> ApiResult {
        let r = self.tiny("/grid/content", &[("name", "editorial_playlist"), ("ranker_enabled", "true")]).await?;
        let ids: Vec<String> = arr(r.pointer("/page/data").unwrap_or(&Value::Null))
            .iter()
            .filter(|x| x.get("type").and_then(Value::as_str) == Some("playlist"))
            .map(|x| id_str(&x["id"]))
            .filter(|s| !s.is_empty())
            .take(40)
            .collect();
        self.get_playlists_short(&ids).await
    }

    /// Всё для вкладки «Популярное» одним вызовом: треки «Топ 100», чарты, хиты по десятилетиям и подборки.
    pub async fn popular(&self) -> ApiResult {
        let shelf_ids: Vec<String> = CHART_PLAYLIST_IDS.iter().chain(DECADE_PLAYLIST_IDS.iter()).map(|s| s.to_string()).collect();
        let (top, shelves, editorial) = futures::join!(self.get_playlist(CHART_PLAYLIST_ID), self.get_playlists_short(&shelf_ids), self.editorial_playlists());
        let shelves = arr(&shelves?);
        let pick = |ids: &[&str]| -> Vec<Value> { ids.iter().filter_map(|id| shelves.iter().find(|p| id_str(&p["id"]) == *id).cloned()).collect() };
        let top = top?;
        Ok(json!({
            "top": {
                "id": CHART_PLAYLIST_ID,
                "title": top.get("title").cloned().unwrap_or(json!("Топ 100")),
                "description": top.get("description").cloned().unwrap_or(Value::Null),
                "updated": top.get("updated").cloned().unwrap_or(Value::Null),
                "tracks": top.get("tracks").cloned().unwrap_or(json!([])),
            },
            "charts": pick(&CHART_PLAYLIST_IDS),
            "decades": pick(&DECADE_PLAYLIST_IDS),
            "editorial": editorial.unwrap_or(json!([])),
        }))
    }

    pub async fn listening_history(&self, limit: i64) -> ApiResult {
        let q = format!(
            "query listeningHistory($limit: Int, $offset: Int) {{ listeningHistory(limit: $limit, offset: $offset) {{
        lastListeningDttm mediaContent {{ __typename ... on Track {{ {} }} }} }} }}",
            track()
        );
        let d = self.gql("listeningHistory", &q, json!({ "limit": limit, "offset": 0 })).await?;
        Ok(Value::Array(
            arr(d.get("listeningHistory").unwrap_or(&Value::Null))
                .into_iter()
                .filter_map(|x| x.get("mediaContent").cloned())
                .filter(|c| c.get("__typename").and_then(Value::as_str) == Some("Track"))
                .collect(),
        ))
    }

    pub async fn recently_played(&self, limit: i64) -> ApiResult {
        let q = format!(
            "query getListeningRecent($limit: Int, $offset: Int, $itemType: [RecentItemType!]) {{
        listeningRecentV1(limit: $limit, offset: $offset, itemType: $itemType) {{
          mediaContent {{ __typename
            ... on Artist {{ {a} }}
            ... on Release {{ {r} }}
            ... on Playlist {{ id title description image {{ src palette }} coverV1 {{ src }} }}
          }} }} }}",
            a = artist_short(),
            r = release_short()
        );
        let d = self.gql("getListeningRecent", &q, json!({ "limit": limit, "offset": 0, "itemType": ["Artist", "Release", "Playlist"] })).await?;
        Ok(Value::Array(
            arr(d.get("listeningRecentV1").unwrap_or(&Value::Null))
                .into_iter()
                .filter_map(|x| x.get("mediaContent").cloned())
                .filter(|c| c.get("__typename").and_then(Value::as_str).is_some() && c.get("id").map(|i| !i.is_null()).unwrap_or(false))
                .collect(),
        ))
    }

    /// Вызов метода по имени — так же, как его вызывает интерфейс (`zvuk.call('getTracks', ids)`).
    /// Ответы справочных методов какое-то время берутся из памяти (см. `cache_ttl`).
    pub async fn call(&self, method: &str, args: &[Value]) -> ApiResult {
        let ttl = cache_ttl(method);
        let key = ttl.map(|_| format!("{method}\u{1}{}", Value::Array(args.to_vec())));
        if let Some(v) = key.as_deref().and_then(|k| self.cache_get(k)) {
            return Ok(v);
        }
        let r = self.call_api(method, args).await?;
        if let (Some(k), Some(ttl)) = (key, ttl) {
            // превью (30 с без подписки) не кэшируем: после входа должен прийти полный трек
            let preview = method == "getStream" && r.get("preview").and_then(Value::as_bool).unwrap_or(false);
            if !preview && !r.is_null() {
                self.cache_put(k, &r, ttl);
            }
        }
        if drops_playlists(method) {
            self.cache.lock().unwrap().retain(|k, _| !k.starts_with("getPlaylist"));
        }
        Ok(r)
    }

    async fn call_api(&self, method: &str, args: &[Value]) -> ApiResult {
        let a = |i: usize| args.get(i).cloned().unwrap_or(Value::Null);
        let s = |i: usize| id_str(&a(i));
        let n = |i: usize, d: i64| a(i).as_f64().map(|f| f as i64).unwrap_or(d);
        match method {
            "quickSearch" => self.quick_search(&s(0), n(1, 10)).await,
            "search" => self.search(&s(0), n(1, 30)).await,
            "autocomplete" => self.autocomplete(&s(0)).await,
            "getTracks" => Ok(Value::Array(self.get_tracks(&ids_of(&a(0))).await?)),
            "getStream" => {
                let q = a(1).as_str().unwrap_or("high").to_string();
                self.get_stream(&s(0), &q).await
            }
            "getLyrics" => self.get_lyrics(&s(0)).await,
            "getRelatedTracks" => self.get_related_tracks(&s(0), n(1, 30)).await,
            "getRelease" => self.get_release(&s(0)).await,
            "getArtist" => self.get_artist(&s(0)).await,
            "getArtistTracks" => self.get_artist_tracks(&s(0), n(1, 100)).await,
            "getReleasesShort" => self.get_releases_short(&ids_of(&a(0))).await,
            "getArtistsShort" => self.get_artists_short(&ids_of(&a(0))).await,
            "getPlaylistsShort" => self.get_playlists_short(&ids_of(&a(0))).await,
            "getPlaylist" => self.get_playlist(&s(0)).await,
            "createPlaylist" => self.create_playlist(&s(0), &ids_of(&a(1))).await,
            "addTracksToPlaylist" => self.add_tracks_to_playlist(&s(0), &ids_of(&a(1))).await,
            "updatePlaylist" => self.update_playlist(&s(0), &a(1)).await,
            "renamePlaylist" => self.rename_playlist(&s(0), &s(1)).await,
            "deletePlaylist" => self.delete_playlist(&s(0)).await,
            "getCollectionIds" => self.get_collection_ids().await,
            "getLikedTrackIds" => self.get_liked_track_ids().await,
            "like" => self.like(&a(0), &s(1), true).await,
            "unlike" => self.like(&a(0), &s(1), false).await,
            "hideTrack" => self.hide_track(&s(0)).await,
            "personalWave" => self.personal_wave(n(0, 10), &a(1)).await,
            "getWaves" => self.get_waves(&ids_of(&a(0))).await,
            "waveContent" => self.wave_content(&s(0)).await,
            "radio" => self.radio(&a(0), &s(1), n(2, 0), n(3, 25)).await,
            "recommendations" => self.recommendations(&a(0)).await,
            "synthesisPlaylists" => self.synthesis_playlists().await,
            "popular" => self.popular().await,
            "listeningHistory" => self.listening_history(n(0, 50)).await,
            "recentlyPlayed" => self.recently_played(n(0, 20)).await,
            "getSubscription" => self.get_subscription().await,
            _ => Err(ApiError::new("BAD_METHOD", method.to_string())),
        }
    }
}

pub fn short_err(e: &reqwest::Error) -> String {
    use std::error::Error;
    let mut msg = e.to_string();
    let mut src = e.source();
    while let Some(s) = src {
        msg = s.to_string();
        src = s.source();
    }
    msg
}
