//! Не-Windows: кнопок на миниатюре, снимков WebView2 и записи установщика нет.

use tauri::{AppHandle, Manager, WebviewWindow};

pub fn installed_copy() -> Option<(std::path::PathBuf, String)> {
    None
}

pub fn webview_version() -> Option<String> {
    None
}

pub fn set_thumb_icons(_win: &WebviewWindow, _icons: &serde_json::Value) {}

pub fn update_thumbar(_win: &WebviewWindow, _playing: bool) {}

pub fn install_hooks(_app: &AppHandle, _win: &WebviewWindow) {}

pub fn make_invisible(_win: &WebviewWindow) {}

pub fn capture_png(_win: &WebviewWindow, _out: std::path::PathBuf, done: impl FnOnce(Result<(), String>) + Send + 'static) {
    done(Err("недоступно".into()))
}

pub fn capture_jpeg(_win: &WebviewWindow) -> tokio::sync::oneshot::Receiver<Option<Vec<u8>>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let _ = tx.send(None);
    rx
}

pub fn gray_thumb(_img: &[u8], _max_w: u32) -> Option<(u32, u32, Vec<u8>)> {
    None
}

pub fn cdp(_win: &WebviewWindow, _method: &'static str, _params: String) {}

#[allow(dead_code)]
pub fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}
