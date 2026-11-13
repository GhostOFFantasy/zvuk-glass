//! Медиа через свои протоколы WebView:
//! * `zgs` — аудиопотоки Zvuk. Отдаются кусками по Range с заголовком CORS, чтобы Web Audio
//!   (эквалайзер, визуализатор) мог их анализировать. Наружу торчат только номера, выданные getStream.
//! * `zgm` — свои файлы пользователя (аватар, обои, видео) с поддержкой перемотки.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::http::{Request, Response, StatusCode};

use crate::store::Store;

/// Потоки и свои файлы читает только страница приложения: клип YouTube (тоже внутри окна)
/// не сможет прочитать их скриптом.
const APP_ORIGIN: &str = "http://tauri.localhost";

/// Сколько отдаём за один запрос. Плеер сам дозапрашивает следующие куски.
const STREAM_CHUNK: u64 = 2 * 1024 * 1024;
const FILE_CHUNK: u64 = 4 * 1024 * 1024;

pub const MEDIA_KEYS: [&str; 5] = ["avatar", "wallImage", "wallVideo", "vizVideo", "vizImage"];

pub fn mime_of(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        _ => return None,
    })
}

// ---------- Аудиопотоки ----------
pub struct Streams {
    http: reqwest::Client,
    map: Mutex<HashMap<u64, (String, Instant)>>,
    next: Mutex<u64>,
}

impl Streams {
    pub fn new() -> Self {
        let http = reqwest::Client::builder().user_agent(crate::zvuk::user_agent()).connect_timeout(Duration::from_secs(15)).build().expect("http client");
        Self { http, map: Mutex::new(HashMap::new()), next: Mutex::new(1) }
    }

    /// Регистрирует ссылку CDN и возвращает адрес для плеера.
    pub fn register(&self, url: &str) -> String {
        let id = {
            let mut n = self.next.lock().unwrap();
            *n += 1;
            *n
        };
        let mut m = self.map.lock().unwrap();
        // старые ссылки всё равно истекают — не копим их бесконечно
        m.retain(|_, (_, at)| at.elapsed() < Duration::from_secs(6 * 3600));
        m.insert(id, (url.to_string(), Instant::now()));
        format!("http://zgs.localhost/s/{id}")
    }

    pub async fn serve(&self, req: Request<Vec<u8>>) -> Response<Vec<u8>> {
        let id: Option<u64> = req.uri().path().strip_prefix("/s/").and_then(|s| s.parse().ok());
        let url = id.and_then(|id| self.map.lock().unwrap().get(&id).map(|(u, _)| u.clone()));
        let Some(url) = url else { return plain(StatusCode::NOT_FOUND) };
        let (start, end) = parse_range(req.headers().get("range").and_then(|v| v.to_str().ok()));
        let start = start.unwrap_or(0);
        let end = end.map(|e| e.min(start + STREAM_CHUNK - 1)).unwrap_or(start + STREAM_CHUNK - 1);
        let res = match self.http.get(&url).header("Range", format!("bytes={start}-{end}")).send().await {
            Ok(r) => r,
            Err(_) => return plain(StatusCode::BAD_GATEWAY),
        };
        let status = res.status();
        let ctype = res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("audio/mpeg").to_string();
        let crange = res.headers().get("content-range").and_then(|v| v.to_str().ok()).map(String::from);
        let body = match res.bytes().await {
            Ok(b) => b.to_vec(),
            Err(_) => return plain(StatusCode::BAD_GATEWAY),
        };
        let mut b = Response::builder()
            .status(status.as_u16())
            .header("Content-Type", ctype)
            .header("Accept-Ranges", "bytes")
            .header("Access-Control-Allow-Origin", APP_ORIGIN)
            .header("Cache-Control", "no-store")
            .header("Content-Length", body.len().to_string());
        if let Some(cr) = crange {
            b = b.header("Content-Range", cr);
        }
        b.body(body).unwrap_or_else(|_| plain(StatusCode::INTERNAL_SERVER_ERROR))
    }
}

/// "bytes=a-b" → (Some(a), Some(b)); суффиксные диапазоны ("bytes=-500") здесь не нужны плееру.
fn parse_range(h: Option<&str>) -> (Option<u64>, Option<u64>) {
    let Some(r) = h.and_then(|h| h.trim().strip_prefix("bytes=")) else { return (None, None) };
    let r = r.split(',').next().unwrap_or("");
    let mut it = r.splitn(2, '-');
    let a = it.next().and_then(|s| s.trim().parse().ok());
    let b = it.next().and_then(|s| s.trim().parse().ok());
    (a, b)
}

fn plain(code: StatusCode) -> Response<Vec<u8>> {
    Response::builder().status(code).header("Access-Control-Allow-Origin", APP_ORIGIN).body(Vec::new()).unwrap()
}

// ---------- Свои файлы ----------
pub fn media_url(store: &Store, key: &str) -> Value {
    let m = store.get("media");
    let e = &m[key];
    match e.get("path").and_then(Value::as_str) {
        Some(p) if Path::new(p).exists() => json!(format!("http://zgm.localhost/{key}?v={}", e.get("v").map(|v| v.to_string()).unwrap_or_default())),
        _ => Value::Null,
    }
}

pub fn media_urls(store: &Store) -> Value {
    Value::Object(MEDIA_KEYS.iter().map(|k| (k.to_string(), media_url(store, k))).collect())
}

pub fn drop_media(store: &Store, key: &str) {
    store.update(|d| {
        if let Some(Value::Object(m)) = d.get_mut("media") {
            if let Some(old) = m.remove(key) {
                if old.get("copied").and_then(Value::as_bool).unwrap_or(false) {
                    if let Some(p) = old.get("path").and_then(Value::as_str) {
                        let _ = std::fs::remove_file(p);
                    }
                }
            }
        }
        true
    });
}

/// Сохраняет выбранный файл: небольшие копирует к себе (переживут удаление оригинала), большие видео — используем на месте.
pub fn adopt_media(store: &Store, key: &str, src: &Path) -> Result<Value, String> {
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let mime = mime_of(&ext).ok_or("Неподдерживаемый формат файла")?;
    drop_media(store, key);
    let size = std::fs::metadata(src).map_err(|e| e.to_string())?.len();
    let mut file = src.to_path_buf();
    let mut copied = false;
    let now = crate::clips::now_ms();
    if size < 60 * 1024 * 1024 {
        let dir = store.dir.join("media");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        file = dir.join(format!("{key}-{now}.{ext}"));
        std::fs::copy(src, &file).map_err(|e| e.to_string())?;
        copied = true;
    }
    store.update(|d| {
        let m = d.entry("media").or_insert_with(|| json!({}));
        if !m.is_object() {
            *m = json!({});
        }
        m[key] = json!({ "path": file.to_string_lossy(), "mime": mime, "copied": copied, "v": now });
        true
    });
    Ok(media_url(store, key))
}

/// Отдаёт свой файл с поддержкой Range — нужно для перемотки и зацикливания видео.
pub fn serve_file(store: &Store, req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let key = req.uri().path().trim_start_matches('/').to_string();
    if !MEDIA_KEYS.contains(&key.as_str()) {
        return plain(StatusCode::NOT_FOUND);
    }
    let m = store.get("media");
    let (Some(path), mime) = (m[&key].get("path").and_then(Value::as_str), m[&key].get("mime").and_then(Value::as_str).unwrap_or("application/octet-stream"))
    else {
        return plain(StatusCode::NOT_FOUND);
    };
    let Ok(mut f) = std::fs::File::open(path) else { return plain(StatusCode::NOT_FOUND) };
    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
    let range = req.headers().get("range").and_then(|v| v.to_str().ok());
    let base = |code: u16| {
        Response::builder()
            .status(code)
            .header("Content-Type", mime)
            .header("Accept-Ranges", "bytes")
            .header("Cache-Control", "no-cache")
            .header("Access-Control-Allow-Origin", APP_ORIGIN)
    };
    if range.is_none() {
        // картинки и прочее без Range — целиком (видео плеер всегда просит кусками)
        let mut buf = Vec::with_capacity(size as usize);
        if f.read_to_end(&mut buf).is_err() {
            return plain(StatusCode::INTERNAL_SERVER_ERROR);
        }
        return base(200).header("Content-Length", buf.len().to_string()).body(buf).unwrap();
    }
    let (a, b) = parse_range(range);
    let start = a.unwrap_or(0);
    if size == 0 || start >= size {
        return Response::builder().status(416).header("Content-Range", format!("bytes */{size}")).body(Vec::new()).unwrap();
    }
    let end = b.unwrap_or(size - 1).min(size - 1).min(start + FILE_CHUNK - 1);
    let len = (end - start + 1) as usize;
    let mut buf = vec![0u8; len];
    if f.seek(SeekFrom::Start(start)).is_err() || f.read_exact(&mut buf).is_err() {
        return plain(StatusCode::INTERNAL_SERVER_ERROR);
    }
    base(206)
        .header("Content-Range", format!("bytes {start}-{end}/{size}"))
        .header("Content-Length", len.to_string())
        .body(buf)
        .unwrap()
}
