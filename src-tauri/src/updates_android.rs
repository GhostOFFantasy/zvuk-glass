//! Обновления Android-версии: проверяем последний релиз на GitHub, тихо скачиваем APK в кэш приложения,
//! а установку подтверждает сам Android. Подменённый файл не встанет: Android ставит обновление, только
//! если APK подписан тем же ключом, что и установленное приложение.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

const LATEST: &str = "https://github.com/GhostOFFantasy/zvuk-glass/releases/latest/download/latest.json";
const APK: &str = "https://github.com/GhostOFFantasy/zvuk-glass/releases/latest/download/Zvuk-Glass-Android.apk";
const FIRST_CHECK: Duration = Duration::from_secs(8);
const EVERY: Duration = Duration::from_secs(4 * 3600);

pub struct Updates {
    status: Mutex<Value>,
    ready: Mutex<Option<PathBuf>>,
    busy: Mutex<bool>,
    pub test: bool,
    http: reqwest::Client,
}

fn version_num(v: &str) -> Vec<u64> {
    v.trim_start_matches('v').split(['.', '-', '+']).take(3).map(|p| p.parse().unwrap_or(0)).collect()
}

impl Updates {
    pub fn new(test: bool) -> Self {
        let http = crate::net::builder().connect_timeout(Duration::from_secs(15)).build().expect("http client");
        Self { status: Mutex::new(json!({ "state": "idle" })), ready: Mutex::new(None), busy: Mutex::new(false), test, http }
    }

    pub fn state(&self, app: &AppHandle) -> Value {
        let mut s = self.status.lock().unwrap().clone();
        s["current"] = json!(app.package_info().version.to_string());
        s["packaged"] = json!(!cfg!(debug_assertions));
        s["platform"] = json!("android");
        s
    }

    fn send(&self, app: &AppHandle, patch: Value) {
        let mut st = patch;
        st["current"] = json!(app.package_info().version.to_string());
        st["packaged"] = json!(!cfg!(debug_assertions));
        st["platform"] = json!("android");
        *self.status.lock().unwrap() = st.clone();
        let _ = app.emit("update:status", st);
    }

    pub async fn check(self: &Arc<Self>, app: &AppHandle) -> Value {
        {
            let mut busy = self.busy.lock().unwrap();
            let st = self.status.lock().unwrap()["state"].as_str().unwrap_or("").to_string();
            if *busy || st == "ready" {
                return self.state(app);
            }
            *busy = true;
        }
        self.send(app, json!({ "state": "checking" }));
        if let Err(msg) = self.run(app).await {
            self.send(app, json!({ "state": "error", "message": msg }));
        }
        *self.busy.lock().unwrap() = false;
        self.state(app)
    }

    async fn run(&self, app: &AppHandle) -> Result<(), String> {
        let net = |e: reqwest::Error| if e.is_connect() || e.is_timeout() { "Нет связи с GitHub".to_string() } else { "Не удалось проверить обновления".to_string() };
        let res = self.http.get(LATEST).send().await.map_err(net)?;
        if !res.status().is_success() {
            return Err("На GitHub пока нет опубликованных версий".into());
        }
        let info: Value = res.json().await.map_err(|_| "Неожиданный ответ GitHub".to_string())?;
        let version = info.get("version").and_then(Value::as_str).unwrap_or("").to_string();
        let current = app.package_info().version.to_string();
        if version.is_empty() || version_num(&version) <= version_num(&current) {
            self.send(app, json!({ "state": "none", "checkedAt": crate::clips::now_ms() }));
            return Ok(());
        }
        // APK качаем во временную папку приложения
        let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("updates");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join(format!("Zvuk-Glass-{version}.apk"));
        self.send(app, json!({ "state": "downloading", "version": version, "percent": 0 }));
        let mut res = self.http.get(APK).send().await.map_err(net)?;
        if !res.status().is_success() {
            return Err("В релизе нет файла для Android".into());
        }
        let total = res.content_length().unwrap_or(0);
        let mut got: u64 = 0;
        let mut last = -1i64;
        let mut buf: Vec<u8> = Vec::with_capacity(total as usize);
        while let Some(chunk) = res.chunk().await.map_err(net)? {
            got += chunk.len() as u64;
            buf.extend_from_slice(&chunk);
            if total > 0 {
                let pct = (got * 100 / total) as i64;
                if pct != last {
                    last = pct;
                    self.send(app, json!({ "state": "downloading", "version": version, "percent": pct }));
                }
            }
        }
        std::fs::write(&path, &buf).map_err(|e| e.to_string())?;
        *self.ready.lock().unwrap() = Some(path);
        let notes = info.get("notes").cloned().unwrap_or(json!(""));
        self.send(app, json!({ "state": "ready", "version": version, "notes": notes }));
        Ok(())
    }

    /// Путь к скачанному APK (установку запускает mobile::install_apk).
    pub fn ready_path(&self) -> Option<PathBuf> {
        self.ready.lock().unwrap().clone()
    }

    pub fn has_ready(&self) -> bool {
        self.ready.lock().unwrap().is_some()
    }

    pub fn start(self: Arc<Self>, app: AppHandle, first: Duration) {
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(first).await;
            loop {
                self.check(&app).await;
                tokio::time::sleep(EVERY).await;
            }
        });
    }
}

pub fn first_check(_screenshot: bool) -> Duration {
    FIRST_CHECK
}
