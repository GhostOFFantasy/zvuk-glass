//! Настройки приложения: тот же файл и формат, что у Electron-версии (%APPDATA%\Zvuk Glass\settings.json),
//! поэтому после обновления всё сохраняется — оформление, эквалайзер, свои обои, вход.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::crypt;

// seenVersion — версия, о новинках которой пользователь уже знает (плашка «Что нового» после обновления)
pub const PUBLIC_KEYS: [&str; 14] = [
    "quality",
    "volume",
    "shuffle",
    "repeat",
    "liquidGlass",
    "performanceMode",
    "wave",
    "custom",
    "eq",
    "viz",
    "profileLocal",
    "lyrics",
    "seenVersion",
    "clipLat",
];

fn defaults() -> Map<String, Value> {
    let v = json!({
        "quality": "flac",
        "volume": 0.8,
        "shuffle": false,
        "repeat": "off",
        "liquidGlass": false,
        "performanceMode": "auto",
        "wave": { "energy": null, "fun": null, "language": null, "instrumental": false, "genres": [], "popularity": null },
        "custom": {},
        "eq": null,
        "viz": {},
        "profileLocal": {},
        "lyrics": { "external": true },
        "media": {},
        "bounds": null,
    });
    v.as_object().cloned().unwrap()
}

pub struct Store {
    pub dir: PathBuf,
    file: PathBuf,
    data: Arc<Mutex<Map<String, Value>>>,
    tx: Mutex<Sender<()>>,
    /// settings.json не было до этого запуска — приложение только что установлено
    pub fresh: bool,
}

impl Store {
    pub fn open(dir: &Path) -> Self {
        let file = dir.join("settings.json");
        let mut data = defaults();
        let fresh = !file.exists();
        if let Ok(text) = std::fs::read_to_string(&file) {
            if let Ok(Value::Object(saved)) = serde_json::from_str::<Value>(&text) {
                for (k, v) in saved {
                    data.insert(k, v);
                }
            }
        }
        let data = Arc::new(Mutex::new(data));
        // Запись на диск — отдельным потоком и не чаще раза в 300 мс
        let (tx, rx) = channel::<()>();
        {
            let data = data.clone();
            let file = file.clone();
            std::thread::spawn(move || {
                while rx.recv().is_ok() {
                    std::thread::sleep(Duration::from_millis(300));
                    while rx.try_recv().is_ok() {}
                    write_file(&file, &data.lock().unwrap());
                }
            });
        }
        let store = Self {
            dir: dir.to_path_buf(),
            file,
            data,
            tx: Mutex::new(tx),
            fresh,
        };
        // 1.4: тяжёлый эффект преломления выключен по умолчанию
        store.update(|d| {
            if !d.get("migr14").and_then(Value::as_bool).unwrap_or(false) {
                d.insert("liquidGlass".into(), json!(false));
                d.insert("migr14".into(), json!(true));
                true
            } else {
                false
            }
        });
        store
    }

    pub fn get(&self, key: &str) -> Value {
        self.data
            .lock()
            .unwrap()
            .get(key)
            .cloned()
            .unwrap_or(Value::Null)
    }

    pub fn set(&self, key: &str, v: Value) {
        self.data.lock().unwrap().insert(key.to_string(), v);
        self.save();
    }

    /// Изменение под замком; сохраняется, если функция вернула true.
    pub fn update(&self, f: impl FnOnce(&mut Map<String, Value>) -> bool) {
        let changed = f(&mut self.data.lock().unwrap());
        if changed {
            self.save();
        }
    }

    pub fn public(&self) -> Map<String, Value> {
        let d = self.data.lock().unwrap();
        PUBLIC_KEYS
            .iter()
            .map(|k| (k.to_string(), d.get(*k).cloned().unwrap_or(Value::Null)))
            .collect()
    }

    pub fn save(&self) {
        let _ = self.tx.lock().unwrap().send(());
    }

    pub fn flush(&self) {
        write_file(&self.file, &self.data.lock().unwrap());
    }

    // ---------- Секреты: токен Zvuk и ключ YouTube ----------
    /// prefix: "token" или "ytKey". Новое хранилище — `<prefix>Dpapi`; старое Electron — `<prefix>Enc` / `<prefix>Plain`.
    pub fn read_secret(&self, prefix: &str) -> Option<String> {
        let dpapi = self.get(&format!("{prefix}Dpapi"));
        if let Some(v) = dpapi.as_str().and_then(crypt::open) {
            return Some(v);
        }
        // Перенос из Electron-версии: расшифровываем и сохраняем рядом в новом виде
        // (старое значение не трогаем — на случай, если Electron-версия ещё запускается)
        if let Some(enc) = self.get(&format!("{prefix}Enc")).as_str() {
            if let Some(v) = crypt::open_electron(&self.dir, enc) {
                if let Some(s) = crypt::seal(&v) {
                    self.set(&format!("{prefix}Dpapi"), serde_json::json!(s));
                }
                return Some(v);
            }
        }
        // Значение без шифрования (шифрование было недоступно) — зашифруем, как только получится
        let plain = self
            .get(&format!("{prefix}Plain"))
            .as_str()
            .map(String::from)?;
        if let Some(s) = crypt::seal(&plain) {
            self.update(|d| {
                d.insert(format!("{prefix}Dpapi"), serde_json::json!(s));
                d.remove(&format!("{prefix}Plain"));
                true
            });
        }
        Some(plain)
    }

    /// Есть ли сохранённый секрет (без расшифровки).
    pub fn has_secret(&self, prefix: &str) -> bool {
        ["Dpapi", "Enc", "Plain"].iter().any(|s| {
            self.get(&format!("{prefix}{s}"))
                .as_str()
                .is_some_and(|v| !v.is_empty())
        })
    }

    /// Удаление всегда возможно. Новый секрет сохраняется только в защищённом виде:
    /// если шифрование недоступно, прежний секрет остаётся нетронутым.
    pub fn write_secret(&self, prefix: &str, value: Option<&str>) -> Result<(), &'static str> {
        self.write_secret_with(prefix, value, crypt::seal)
    }

    fn write_secret_with(
        &self,
        prefix: &str,
        value: Option<&str>,
        seal: impl FnOnce(&str) -> Option<String>,
    ) -> Result<(), &'static str> {
        let sealed = match value.filter(|v| !v.is_empty()) {
            Some(v) => Some(
                seal(v)
                    .ok_or("Не удалось защитить ключ средствами системы. Секрет не сохранён.")?,
            ),
            None => None,
        };
        self.update(|d| {
            d.remove(&format!("{prefix}Dpapi"));
            d.remove(&format!("{prefix}Enc"));
            d.remove(&format!("{prefix}Plain"));
            if let Some(s) = sealed {
                d.insert(format!("{prefix}Dpapi"), json!(s));
            }
            true
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_encryption_does_not_replace_existing_secret() {
        let dir = std::env::current_dir()
            .unwrap()
            .join("target/test-data")
            .join(format!("store-{}", std::process::id()));
        let store = Store::open(&dir);
        store
            .write_secret_with("token", Some("old-test-value"), |_| {
                Some("sealed-test-value".into())
            })
            .unwrap();
        assert!(store
            .write_secret_with("token", Some("new-test-value"), |_| None)
            .is_err());
        assert_eq!(store.get("tokenDpapi").as_str(), Some("sealed-test-value"));
        assert!(store.get("tokenPlain").is_null());
        store.write_secret_with("token", None, |_| None).unwrap();
        assert!(store.get("tokenDpapi").is_null());
        store.flush();
        drop(store);
        std::thread::sleep(Duration::from_millis(350));
        let _ = std::fs::remove_dir_all(dir);
    }
}

fn write_file(file: &Path, data: &Map<String, Value>) {
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string_pretty(data) {
        // через временный файл, чтобы не потерять настройки при сбое посреди записи
        let tmp = file.with_extension("json.tmp");
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, file);
        }
    }
}
