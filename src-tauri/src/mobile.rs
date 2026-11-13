//! Android: связь с Kotlin-частью (gen/android/.../ZgPlugin.kt, MediaService.kt) — уведомление
//! «Сейчас играет» с кнопками, фоновое воспроизведение, установка обновления.
//! Кнопки уведомления, экрана блокировки и гарнитуры приходят обратно через JNI и превращаются в то же
//! событие `media:command`, что и кнопки на миниатюре в Windows, — интерфейсу всё равно, откуда нажали.

use std::sync::OnceLock;

use serde_json::{json, Value};
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Emitter, Manager, Wry};

static APP: OnceLock<AppHandle> = OnceLock::new();

struct Zg(PluginHandle<Wry>);

pub fn plugin() -> TauriPlugin<Wry> {
    Builder::new("zg")
        .setup(|app, api| {
            let h = api.register_android_plugin("com.zvukglass.app", "ZgPlugin")?;
            app.manage(Zg(h));
            let _ = APP.set(app.clone());
            Ok(())
        })
        .build()
}

/// Вызов метода Kotlin-плагина. Блокирует поток до ответа — не вызывать из главного потока.
pub fn call(app: &AppHandle, method: &str, payload: Value) -> Result<Value, String> {
    let z = app.try_state::<Zg>().ok_or("плагин не готов")?;
    z.0.run_mobile_plugin::<Value>(method, payload).map_err(|e| e.to_string())
}

/// То же в фоне: ответ не нужен.
pub fn call_bg(app: &AppHandle, method: &'static str, payload: Value) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = call(&app, method, payload);
    });
}

pub fn install_apk(app: &AppHandle, path: &std::path::Path) -> bool {
    call(app, "installApk", json!({ "path": path.to_string_lossy() })).is_ok()
}

/// Kotlin: `ZgNative.command("toggle" | "next" | "prev" | "play" | "pause" | "seek:<сек>")`.
#[no_mangle]
pub extern "system" fn Java_com_zvukglass_app_ZgNative_command(mut env: jni::JNIEnv, _cls: jni::objects::JClass, cmd: jni::objects::JString) {
    let cmd: String = env.get_string(&cmd).map(|s| s.into()).unwrap_or_default();
    if let Some(app) = APP.get() {
        let _ = app.emit("media:command", cmd);
    }
}
