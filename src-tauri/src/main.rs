// Без окна консоли в собранной версии
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod clips;
mod crypt;
mod media;
mod store;
mod sync;
mod updates;
mod winx;
mod zvuk;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, RunEvent, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tokio::sync::watch;

use crate::store::Store;
use crate::zvuk::{ApiError, Profile, ZvukClient};

// ---------- Аргументы запуска ----------
#[derive(Default, Clone)]
struct Args {
    /// путь к PNG — служебный режим проверки интерфейса (анонимный вход, временные настройки)
    screenshot: Option<PathBuf>,
    route: Option<String>,
    extra: Option<String>,
    vizstyle: Option<String>,
    login_preview: bool,
    updtest: bool,
}

impl Args {
    fn parse() -> Self {
        let mut a = Args::default();
        for x in std::env::args().skip(1) {
            let (k, v) = match x.split_once('=') {
                Some((k, v)) => (k.to_string(), Some(v.to_string())),
                None => (x.clone(), None),
            };
            match k.as_str() {
                "--screenshot" => a.screenshot = Some(v.map(PathBuf::from).unwrap_or_else(|| PathBuf::from("screenshot.png"))),
                "--route" => a.route = v,
                "--extra" => a.extra = v,
                "--vizstyle" => a.vizstyle = v,
                "--login-preview" => a.login_preview = true,
                "--updtest" => a.updtest = true,
                _ => {}
            }
        }
        a
    }
    fn demo(&self) -> bool {
        self.screenshot.is_some()
    }
}

// ---------- Состояние ----------
struct App {
    args: Args,
    store: Store,
    client: ZvukClient,
    profile: Mutex<Option<Profile>>,
    auth_ready: watch::Receiver<bool>,
    clips: clips::Clips,
    sync: sync::Sync,
    streams: media::Streams,
    updates: Arc<updates::Updates>,
    shot_taken: AtomicBool,
}

type S<'a> = State<'a, Arc<App>>;

fn err(code: &str, msg: impl Into<String>) -> ApiError {
    ApiError::new(code, msg)
}

// ---------- Вход ----------
async fn init_auth(app: &App) {
    if app.args.login_preview {
        return;
    }
    if app.args.demo() {
        if let Ok(Some(t)) = app.client.anonymous_token().await {
            app.client.set_token(Some(t));
            if let Ok(p) = app.client.profile_with(app.client.token().as_deref()).await {
                *app.profile.lock().unwrap() = Some(p);
            }
        }
        return;
    }
    let Some(token) = app.store.read_secret("token") else { return };
    app.client.set_token(Some(token.clone()));
    match app.client.profile_with(Some(&token)).await {
        Ok(p) if p.is_anonymous => {
            app.client.set_token(None);
        }
        Ok(p) => *app.profile.lock().unwrap() = Some(p),
        // Нет сети или временная блокировка — работаем с сохранённым токеном, профиль подтянем позже
        Err(_) => {
            *app.profile.lock().unwrap() =
                Some(Profile { id: String::new(), name: None, image: None, is_anonymous: false, token: None, offline: true })
        }
    }
}

fn auth_json(app: &App) -> Value {
    let demo = app.args.demo();
    let p = app.profile.lock().unwrap();
    match (app.client.token(), p.as_ref()) {
        (Some(_), Some(p)) => json!({
            "authorized": true, "demo": demo,
            "profile": { "id": p.id, "name": p.name, "image": p.image, "isAnonymous": p.is_anonymous, "offline": p.offline }
        }),
        _ => json!({ "authorized": false, "demo": demo }),
    }
}

#[tauri::command]
async fn auth_state(app: S<'_>) -> Result<Value, ApiError> {
    let mut rx = app.auth_ready.clone();
    let _ = rx.wait_for(|r| *r).await;
    Ok(auth_json(&app))
}

#[tauri::command]
async fn auth_token(app: S<'_>, token: String) -> Result<Value, ApiError> {
    let token = token.trim().to_string();
    let ok = token.len() >= 16 && token.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if !ok {
        return Err(err("BAD_TOKEN", "Похоже, это не токен Zvuk"));
    }
    let p = app.client.profile_with(Some(&token)).await?;
    if p.is_anonymous {
        return Err(err("ANON", "Этот токен анонимный — войдите в аккаунт на zvuk.com и скопируйте токен заново"));
    }
    app.client.set_token(Some(token.clone()));
    *app.profile.lock().unwrap() = Some(p);
    if !app.args.demo() {
        app.store.write_secret("token", Some(&token));
    }
    Ok(auth_json(&app))
}

#[tauri::command]
fn auth_logout(app: S<'_>) -> Value {
    app.client.set_token(None);
    *app.profile.lock().unwrap() = None;
    app.store.write_secret("token", None);
    auth_json(&app)
}

// ---------- API Zvuk ----------
#[tauri::command]
async fn zvuk_call(app: S<'_>, method: String, args: Vec<Value>) -> Result<Value, ApiError> {
    let mut r = app.client.call(&method, &args).await?;
    // Поток идёт через свой протокол: так Web Audio может его анализировать
    if method == "getStream" {
        if let Some(url) = r.get("url").and_then(Value::as_str).map(String::from) {
            r["url"] = json!(app.streams.register(&url));
        }
    }
    Ok(r)
}

// ---------- Настройки ----------
#[tauri::command]
fn settings_get(app: S<'_>) -> Value {
    let mut p = app.store.public();
    p.insert("mediaUrls".into(), media::media_urls(&app.store));
    Value::Object(p)
}

#[tauri::command]
fn settings_set(app: S<'_>, patch: Value) -> bool {
    if let Some(o) = patch.as_object() {
        app.store.update(|d| {
            for k in store::PUBLIC_KEYS {
                if let Some(v) = o.get(k) {
                    d.insert(k.to_string(), v.clone());
                }
            }
            true
        });
    }
    true
}

// ---------- Свои файлы ----------
#[tauri::command]
async fn media_pick(app: S<'_>, window: WebviewWindow, key: String, kind: String) -> Result<Value, ApiError> {
    if !media::MEDIA_KEYS.contains(&key.as_str()) {
        return Err(err("BAD_KEY", "bad key"));
    }
    let video = kind == "video";
    let mut dlg = rfd::AsyncFileDialog::new().set_title(if video { "Выберите видео" } else { "Выберите изображение" });
    dlg = if video {
        dlg.add_filter("Видео", &["mp4", "webm", "m4v", "mkv", "mov"])
    } else {
        dlg.add_filter("Изображения", &["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif"])
    };
    dlg = dlg.set_parent(&window);
    let Some(file) = dlg.pick_file().await else { return Ok(Value::Null) };
    media::adopt_media(&app.store, &key, file.path()).map_err(|m| err("MEDIA", m))
}

#[tauri::command]
fn media_clear(app: S<'_>, key: String) -> bool {
    if media::MEDIA_KEYS.contains(&key.as_str()) {
        media::drop_media(&app.store, &key);
    }
    true
}

// ---------- Плеер и окно ----------
#[tauri::command]
fn player_state(window: WebviewWindow, st: Value) {
    let playing = st.get("playing").and_then(Value::as_bool).unwrap_or(false);
    winx::update_thumbar(&window, playing);
    let title = match st.get("title").and_then(Value::as_str).filter(|t| !t.is_empty()) {
        Some(t) => format!("{t} — {} · Zvuk Glass", st.get("artist").and_then(Value::as_str).unwrap_or("")),
        None => "Zvuk Glass".into(),
    };
    let _ = window.set_title(&title);
}

#[tauri::command]
fn thumbar_icons(window: WebviewWindow, icons: Value) {
    winx::set_thumb_icons(&window, &icons);
}

#[tauri::command]
fn win_action(window: WebviewWindow, action: String) -> bool {
    match action.as_str() {
        "minimize" => {
            let _ = window.minimize();
        }
        "toggleMaximize" => {
            if window.is_maximized().unwrap_or(false) {
                let _ = window.unmaximize();
            } else {
                let _ = window.maximize();
            }
        }
        "close" => {
            let _ = window.close();
        }
        "drag" => {
            let _ = window.start_dragging();
        }
        _ => {}
    }
    window.is_maximized().unwrap_or(false)
}

#[tauri::command]
fn win_state(window: WebviewWindow) -> Value {
    json!({ "maximized": window.is_maximized().unwrap_or(false) })
}

#[tauri::command]
fn set_zoom(window: WebviewWindow, factor: f64) {
    let f = if factor.is_finite() { factor.clamp(0.75, 1.4) } else { 1.0 };
    let _ = window.set_zoom(f);
}

#[tauri::command]
fn clipboard_write(text: String) -> bool {
    arboard::Clipboard::new().and_then(|mut c| c.set_text(text)).is_ok()
}

/// Буфер обмена читается только по кнопке «Вставить» на экране входа.
#[tauri::command]
fn clipboard_read(app: S<'_>) -> String {
    if app.profile.lock().unwrap().is_some() {
        return String::new();
    }
    arboard::Clipboard::new().and_then(|mut c| c.get_text()).unwrap_or_default()
}

/// Какие адреса можно открыть в обычном браузере: Zvuk, YouTube, GitHub (обновления) и консоль Google (ключ YouTube).
/// Всё остальное — даже если страница (или клип) попробует перейти по ссылке — не открывается.
fn external_ok(url: &str) -> bool {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"^https://((www\.)?zvuk\.com|console\.cloud\.google\.com|(www\.|m\.)?youtube\.com|youtu\.be|github\.com)/").unwrap()).is_match(url)
}

#[tauri::command]
fn shell_open(url: String) -> bool {
    let ok = external_ok(&url);
    if ok {
        let _ = open::that_detached(&url);
    }
    ok
}

// ---------- Клипы ----------
#[tauri::command]
fn yt_state(app: S<'_>) -> Value {
    json!({ "hasKey": app.store.read_secret("ytKey").is_some(), "cached": app.clips.size() })
}

#[tauri::command]
async fn yt_set_key(app: S<'_>, key: String) -> Result<bool, ApiError> {
    let key = key.trim().to_string();
    if key.len() < 20 || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err(err("BAD_KEY", "Похоже, это не ключ API"));
    }
    app.clips.check_key(&key).await?;
    app.store.write_secret("ytKey", Some(&key));
    Ok(true)
}

#[tauri::command]
fn yt_clear_key(app: S<'_>) -> bool {
    app.store.write_secret("ytKey", None);
    true
}

/// track: { id, title, artists: [названия], duration }. force — искать заново.
#[tauri::command]
async fn yt_find(app: S<'_>, track: Value, force: Option<bool>) -> Result<Value, ApiError> {
    let id = zvuk::id_str(&track["id"]);
    let prev = app.clips.get(&id);
    if let Some(p) = &prev {
        if !force.unwrap_or(false) {
            return Ok(p.clone());
        }
    }
    let Some(key) = app.store.read_secret("ytKey") else {
        let mut r = prev.unwrap_or(json!({}));
        r["error"] = json!("NO_KEY");
        return Ok(r);
    };
    let cands = app.clips.search(&key, &track).await?;
    let pick = if cands.first().and_then(|c| c["score"].as_i64()).unwrap_or(-99) >= 4 { json!(0) } else { Value::Null };
    let prev = prev.unwrap_or(json!({}));
    let entry = json!({
        "cands": cands, "pick": pick,
        "manual": prev.get("manual").cloned().unwrap_or(Value::Null),
        "offset": prev.get("offset").cloned().unwrap_or(json!(0)),
        "at": clips::now_ms(),
    });
    Ok(app.clips.set(&id, entry))
}

#[tauri::command]
fn yt_update(app: S<'_>, track_id: Value, patch: Value) -> Value {
    let id = zvuk::id_str(&track_id);
    let mut e = app.clips.get(&id).unwrap_or_else(|| json!({ "cands": [], "pick": null, "manual": null, "offset": 0, "at": clips::now_ms() }));
    for k in ["pick", "manual", "offset", "auto"] {
        if let Some(v) = patch.get(k) {
            e[k] = v.clone();
        }
    }
    app.clips.set(&id, e)
}

// ---------- Автосинхронизация клипа ----------
#[tauri::command]
async fn sync_prepare(app: S<'_>, track_id: Value) -> Result<Value, ApiError> {
    app.sync.prepare(&app.client, &zvuk::id_str(&track_id)).await
}

#[tauri::command]
async fn sync_measure(app: S<'_>, track_id: Value, seconds: f64, lo: f64, hi: f64) -> Result<Value, ApiError> {
    app.sync.measure(&zvuk::id_str(&track_id), seconds, lo, hi).await
}

#[tauri::command]
fn yt_clear_cache(app: S<'_>) -> bool {
    app.clips.clear();
    true
}

#[tauri::command]
fn yt_parse(text: String) -> Option<String> {
    clips::parse_video_id(&text)
}

// ---------- Обновления ----------
#[tauri::command]
fn update_state(app: S<'_>, handle: AppHandle) -> Value {
    app.updates.state(&handle)
}

#[tauri::command]
async fn update_check(app: S<'_>, handle: AppHandle) -> Result<Value, ApiError> {
    Ok(app.updates.check(&handle).await)
}

#[tauri::command]
fn update_install(app: S<'_>, handle: AppHandle) -> bool {
    if !app.updates.has_ready() || app.updates.test {
        return false;
    }
    app.store.flush();
    let u = app.updates.clone();
    // установщик закрывает приложение сам; отвечаем интерфейсу сразу
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(150));
        let _ = handle;
        u.install(true);
    });
    true
}

// ---------- Служебный режим снимков ----------
#[tauri::command]
fn screenshot_ready(app: S<'_>, window: WebviewWindow, delay: Option<u64>) {
    let Some(out) = app.args.screenshot.clone() else { return };
    if app.shot_taken.swap(true, Ordering::SeqCst) {
        return;
    }
    let handle = window.app_handle().clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(delay.unwrap_or(1200)));
        let h2 = handle.clone();
        let path = out.clone();
        winx::capture_png(&window, out, move |r| {
            match r {
                Ok(()) => println!("SCREENSHOT_SAVED {}", path.display()),
                Err(e) => println!("SCREENSHOT_FAILED {e}"),
            }
            h2.exit(0);
        });
    });
}

/// Служебно: сообщение интерфейса в вывод (только в режиме снимков).
#[tauri::command]
fn debug_log(app: S<'_>, msg: String) {
    if app.args.screenshot.is_some() {
        println!("LOG {msg}");
    }
}

/// Служебно: настоящее движение мыши внутри окна (через DevTools-протокол), чтобы проверять :hover и т. п.
#[tauri::command]
fn debug_mouse(app: S<'_>, window: WebviewWindow, x: f64, y: f64, kind: Option<String>) {
    if app.args.screenshot.is_none() {
        return;
    }
    let kind = kind.unwrap_or_else(|| "mouseMoved".into());
    // «mouseDragged» — движение с зажатой левой кнопкой
    let drag = kind == "mouseDragged";
    let mut p = json!({ "type": if drag { "mouseMoved" } else { kind.as_str() }, "x": x, "y": y, "pointerType": "mouse" });
    if drag {
        p["button"] = json!("left");
        p["buttons"] = json!(1);
    } else if p["type"] != "mouseMoved" {
        p["button"] = json!("left");
        p["buttons"] = json!(if p["type"] == "mousePressed" { 1 } else { 0 });
        p["clickCount"] = json!(1);
    }
    winx::cdp(&window, "Input.dispatchMouseEvent", p.to_string());
}

// ---------- Окно ----------
fn data_dir(args: &Args) -> PathBuf {
    if args.screenshot.is_some() {
        return std::env::temp_dir().join("zvuk-glass-screenshot");
    }
    let base = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("Zvuk Glass")
}

fn create_window(handle: &AppHandle, app: &Arc<App>) -> tauri::Result<WebviewWindow> {
    let a = &app.args;
    let shot = a.screenshot.is_some();
    let bounds = app.store.get("bounds");
    let num = |k: &str| bounds.get(k).and_then(Value::as_f64);

    let mut init = serde_json::Map::new();
    if let Some(r) = &a.route {
        init.insert("route".into(), json!(r));
    }
    if shot {
        init.insert("screenshot".into(), json!("1"));
    }
    if let Some(e) = &a.extra {
        init.insert("extra".into(), json!(e));
    }
    if let Some(v) = &a.vizstyle {
        init.insert("vizstyle".into(), json!(v));
    }

    // Аргументы движка: без «засыпания» в фоне (музыка, визуализатор), автозапуск звука и видео
    let mut browser_args = String::from(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion --autoplay-policy=no-user-gesture-required --disable-background-timer-throttling --disable-renderer-backgrounding",
    );
    if shot {
        browser_args.push_str(" --disable-backgrounding-occluded-windows");
    }

    let mut b = WebviewWindowBuilder::new(handle, "main", WebviewUrl::App("index.html".into()))
        .title("Zvuk Glass")
        .inner_size(if shot { 1400.0 } else { num("width").unwrap_or(1360.0) }, if shot { 900.0 } else { num("height").unwrap_or(880.0) })
        .min_inner_size(980.0, 640.0)
        .decorations(false)
        .shadow(true)
        .visible(false)
        .background_color(tauri::window::Color(11, 11, 16, 255))
        .additional_browser_args(&browser_args)
        .disable_drag_drop_handler()
        .zoom_hotkeys_enabled(false)
        .initialization_script(format!("window.__ZG_ARGS__ = {};", Value::Object(init)))
        .on_navigation(|url| {
            let local = url.host_str().map(|h| h == "tauri.localhost" || h.ends_with(".localhost")).unwrap_or(false);
            if !local && external_ok(url.as_str()) {
                let _ = open::that_detached(url.as_str());
            }
            local || url.scheme() == "about" || url.scheme() == "tauri"
        })
        .on_new_window(|url, _| {
            if external_ok(url.as_str()) {
                let _ = open::that_detached(url.as_str());
            }
            tauri::webview::NewWindowResponse::Deny
        });
    if shot {
        b = b.data_directory(data_dir(a).join("webview")).focused(false).skip_taskbar(true);
    } else if let (Some(x), Some(y)) = (num("x"), num("y")) {
        b = b.position(x, y);
    } else {
        b = b.center();
    }
    let win = b.build()?;
    if shot {
        winx::make_invisible(&win);
    } else if bounds.get("maximized").and_then(Value::as_bool).unwrap_or(false) {
        let _ = win.maximize();
    }
    let _ = win.show();
    winx::install_hooks(handle, &win);

    // Положение окна запоминается (как раньше); свёрнутое окно — интерфейс останавливает
    // визуализатор, клип и анимации (музыка играет дальше)
    {
        let app2 = app.clone();
        let w2 = win.clone();
        let hidden = std::sync::atomic::AtomicBool::new(false);
        win.on_window_event(move |e| match e {
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                if !shot {
                    save_bounds(&app2, &w2);
                }
                let min = w2.is_minimized().unwrap_or(false);
                if hidden.swap(min, std::sync::atomic::Ordering::SeqCst) != min {
                    let _ = w2.emit("win:hidden", min);
                }
            }
            _ => {}
        });
    }
    Ok(win)
}

fn save_bounds(app: &App, w: &WebviewWindow) {
    let maximized = w.is_maximized().unwrap_or(false);
    if w.is_minimized().unwrap_or(false) {
        return;
    }
    let scale = w.scale_factor().unwrap_or(1.0);
    let mut b = app.store.get("bounds");
    if !b.is_object() {
        b = json!({});
    }
    if !maximized {
        if let (Ok(p), Ok(s)) = (w.outer_position(), w.inner_size()) {
            let p: LogicalPosition<f64> = p.to_logical(scale);
            let s: LogicalSize<f64> = s.to_logical(scale);
            b["x"] = json!(p.x.round());
            b["y"] = json!(p.y.round());
            b["width"] = json!(s.width.round());
            b["height"] = json!(s.height.round());
        }
    }
    b["maximized"] = json!(maximized);
    app.store.set("bounds", b);
}

/// Служебная проверка переноса из Electron-версии: только сообщает, читаются ли сохранённые секреты.
/// Ничего не меняет и не печатает сами значения.
fn diag(dir: &std::path::Path) {
    let text = std::fs::read_to_string(dir.join("settings.json")).unwrap_or_default();
    let s: Value = serde_json::from_str(&text).unwrap_or(json!({}));
    for p in ["token", "ytKey"] {
        let state = if let Some(v) = s[format!("{p}Dpapi")].as_str() {
            if crypt::open(v).is_some() { "новый формат: читается" } else { "новый формат: НЕ читается" }
        } else if let Some(v) = s[format!("{p}Enc")].as_str() {
            match crypt::open_electron_steps(dir, v) {
                Ok(x) if !x.is_empty() => "из Electron: читается",
                Ok(_) => "из Electron: пусто",
                Err(step) => {
                    println!("{p}: из Electron: НЕ читается ({step})");
                    continue;
                }
            }
        } else {
            "нет"
        };
        println!("{p}: {state}");
    }
}

fn main() {
    let args = Args::parse();
    let dir = data_dir(&args);
    // запросы к Zvuk идут с User-Agent установленного движка WebView2 (до создания HTTP-клиентов)
    if let Some(v) = winx::webview_version() {
        zvuk::set_engine_version(&v);
    }
    if std::env::args().any(|a| a == "--diag") {
        diag(&dir);
        return;
    }
    // служебно: проверка захвата звука с устройства вывода (--diag-capture)
    if let Some(d) = std::env::args().find_map(|a| a.strip_prefix("--diag-match=").map(String::from)) {
        println!("{}", sync::diag_match(std::path::Path::new(&d)));
        return;
    }
    if std::env::args().any(|a| a == "--diag-capture") {
        println!("capture: {}", sync::diag_capture(3.0));
        return;
    }
    // служебно: расшифровать строку, зашифрованную Electron safeStorage (из файла), — проверка совместимости
    if let Some(f) = std::env::args().find_map(|a| a.strip_prefix("--diag-probe=").map(String::from)) {
        let b64 = std::fs::read_to_string(f).unwrap_or_default();
        match crypt::open_electron_steps(&dir, b64.trim()) {
            Ok(v) => println!("probe: OK, длина {}", v.len()),
            Err(step) => println!("probe: НЕ читается ({step})"),
        }
        return;
    }
    let _ = std::fs::create_dir_all(&dir);
    let store = Store::open(&dir);
    let (ready_tx, ready_rx) = watch::channel(false);
    let shot = args.screenshot.is_some();
    let app = Arc::new(App {
        updates: Arc::new(updates::Updates::new(shot && args.updtest)),
        clips: clips::Clips::new(&dir),
        sync: sync::Sync::new(),
        streams: media::Streams::new(),
        client: ZvukClient::new(),
        profile: Mutex::new(None),
        auth_ready: ready_rx,
        store,
        args,
        shot_taken: AtomicBool::new(false),
    });

    let mut builder = tauri::Builder::default();
    if !shot {
        // Второй запуск просто показывает уже открытое окно
        builder = builder.plugin(tauri_plugin_single_instance::init(|h, _, _| {
            if let Some(w) = winx::main_window(h) {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
    }
    let a_stream = app.clone();
    let a_file = app.clone();
    let a_setup = app.clone();
    let a_run = app.clone();
    let tauri_app = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(app.clone())
        .register_asynchronous_uri_scheme_protocol("zgs", move |_ctx, req, responder| {
            let a = a_stream.clone();
            tauri::async_runtime::spawn(async move {
                responder.respond(a.streams.serve(req).await);
            });
        })
        .register_asynchronous_uri_scheme_protocol("zgm", move |_ctx, req, responder| {
            let a = a_file.clone();
            std::thread::spawn(move || responder.respond(media::serve_file(&a.store, &req)));
        })
        .invoke_handler(tauri::generate_handler![
            auth_state,
            auth_token,
            auth_logout,
            zvuk_call,
            settings_get,
            settings_set,
            media_pick,
            media_clear,
            player_state,
            thumbar_icons,
            win_action,
            win_state,
            set_zoom,
            clipboard_write,
            clipboard_read,
            shell_open,
            yt_state,
            yt_set_key,
            yt_clear_key,
            yt_find,
            yt_update,
            yt_clear_cache,
            yt_parse,
            sync_prepare,
            sync_measure,
            update_state,
            update_check,
            update_install,
            screenshot_ready,
            debug_log,
            debug_mouse,
        ])
        .setup(move |tapp| {
            let handle = tapp.handle().clone();
            let app = a_setup.clone();
            // Вход проверяется параллельно с открытием окна; интерфейс дождётся результата
            {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    init_auth(&app).await;
                    let _ = ready_tx.send(true);
                });
            }
            create_window(&handle, &app)?;
            if !shot || app.args.updtest {
                app.updates.clone().start(handle.clone(), updates::first_check(shot));
            }
            if shot {
                // страховка: служебный запуск не висит вечно
                let h = handle.clone();
                let long = app.args.updtest || app.args.extra.as_deref().is_some_and(|e| e.starts_with("clipsync"));
                let limit = if long { 300 } else { 60 };
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(limit));
                    println!("SCREENSHOT_TIMEOUT");
                    h.exit(1);
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("не удалось запустить Zvuk Glass");

    tauri_app.run(move |handle, event| {
        if let RunEvent::Exit = event {
            a_run.store.flush();
            // скачанное обновление ставится при выходе, без перезапуска
            if a_run.updates.has_ready() && !a_run.updates.test {
                a_run.updates.install(false);
            }
            let _ = handle;
        }
    });
}

#[allow(dead_code)]
fn emit_all(h: &AppHandle, ev: &str, payload: Value) {
    let _ = h.emit(ev, payload);
}
