//! Обновления «по воздуху» через GitHub Releases (tauri-plugin-updater, подпись minisign).
//! При запуске и каждые 4 часа проверяем релиз, тихо скачиваем его и ставим при выходе
//! или сразу — по кнопке «Перезапустить».

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};

const FIRST_CHECK: Duration = Duration::from_secs(8);
const EVERY: Duration = Duration::from_secs(4 * 3600);

pub struct Updates {
    status: Mutex<Value>,
    ready: Mutex<Option<(Update, Vec<u8>)>>,
    busy: Mutex<bool>,
    pub test: bool,
}

pub fn packaged() -> bool {
    !cfg!(debug_assertions)
}

impl Updates {
    pub fn new(test: bool) -> Self {
        Self { status: Mutex::new(json!({ "state": "idle" })), ready: Mutex::new(None), busy: Mutex::new(false), test }
    }

    pub fn state(&self, app: &AppHandle) -> Value {
        let mut s = self.status.lock().unwrap().clone();
        s["current"] = json!(app.package_info().version.to_string());
        s["packaged"] = json!(packaged());
        s
    }

    fn send(&self, app: &AppHandle, patch: Value) {
        let mut st = patch;
        st["current"] = json!(app.package_info().version.to_string());
        st["packaged"] = json!(packaged());
        if self.test {
            let pct = st.get("percent").and_then(Value::as_i64).unwrap_or(0);
            if st["state"] != "downloading" || pct % 25 == 0 {
                println!("UPDATE {st}");
            }
        }
        *self.status.lock().unwrap() = st.clone();
        let _ = app.emit("update:status", st);
    }

    pub async fn check(self: &Arc<Self>, app: &AppHandle) -> Value {
        if !packaged() {
            self.send(app, json!({ "state": "dev" }));
            return self.state(app);
        }
        {
            let mut busy = self.busy.lock().unwrap();
            let st = self.status.lock().unwrap()["state"].as_str().unwrap_or("").to_string();
            if *busy || st == "ready" {
                return self.state(app);
            }
            *busy = true;
        }
        self.send(app, json!({ "state": "checking" }));
        let result = self.run(app).await;
        if let Err(msg) = result {
            self.send(app, json!({ "state": "error", "message": msg }));
        }
        *self.busy.lock().unwrap() = false;
        self.state(app)
    }

    async fn run(self: &Arc<Self>, app: &AppHandle) -> Result<(), String> {
        let updater = app.updater().map_err(|e| friendly(&e.to_string()))?;
        let Some(update) = updater.check().await.map_err(|e| friendly(&e.to_string()))? else {
            self.send(app, json!({ "state": "none", "checkedAt": crate::clips::now_ms() }));
            return Ok(());
        };
        let version = update.version.clone();
        self.send(app, json!({ "state": "downloading", "version": version, "percent": 0 }));
        let mut got: u64 = 0;
        let mut last = -1i64;
        let me = self.clone();
        let app2 = app.clone();
        let v2 = version.clone();
        let bytes = update
            .download(
                move |chunk, total| {
                    got += chunk as u64;
                    if let Some(t) = total.filter(|t| *t > 0) {
                        let pct = (got * 100 / t) as i64;
                        if pct != last {
                            last = pct;
                            me.send(&app2, json!({ "state": "downloading", "version": v2, "percent": pct }));
                        }
                    }
                },
                || {},
            )
            .await
            .map_err(|e| friendly(&e.to_string()))?;
        let notes = update.body.clone().unwrap_or_default();
        *self.ready.lock().unwrap() = Some((update, bytes));
        self.send(app, json!({ "state": "ready", "version": version, "notes": notes }));
        Ok(())
    }

    /// Установка скачанного обновления. Процесс завершается внутри (так устроены установщики Windows).
    pub fn install(&self, restart: bool) -> bool {
        if self.test {
            return false;
        }
        let Some((update, bytes)) = self.ready.lock().unwrap().take() else { return false };
        let update = update.restart_after_install(restart);
        update.install(bytes).is_ok()
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

pub fn first_check(screenshot: bool) -> Duration {
    if screenshot {
        Duration::from_millis(500)
    } else {
        FIRST_CHECK
    }
}

fn friendly(m: &str) -> String {
    let l = m.to_lowercase();
    if ["dns", "connect", "timed out", "timeout", "unreachable", "network"].iter().any(|w| l.contains(w)) {
        return "Нет связи с GitHub".into();
    }
    if l.contains("404") || l.contains("not found") || l.contains("could not fetch a valid release json") {
        return "На GitHub пока нет опубликованных версий".into();
    }
    if l.contains("rate limit") || l.contains("403") {
        return "GitHub временно ограничил запросы, попробуем позже".into();
    }
    if l.contains("signature") {
        return "Подпись обновления не совпала — оно не будет установлено".into();
    }
    m.lines().next().unwrap_or("Неизвестная ошибка").chars().take(160).collect()
}
