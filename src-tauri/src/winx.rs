//! Особенности Windows: кнопки на миниатюре в панели задач, снимок содержимого окна (служебный режим проверки),
//! невидимое окно для снимков.

use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use webview2_com::CapturePreviewCompletedHandler;

/// Установленная копия приложения по записи установщика: (папка, версия).
pub fn installed_copy() -> Option<(std::path::PathBuf, String)> {
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
    let key = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Zvuk Glass");
    let read = |name: PCWSTR| -> Option<String> {
        let mut buf = vec![0u16; 1024];
        let mut size = (buf.len() * 2) as u32;
        let r = unsafe { RegGetValueW(HKEY_CURRENT_USER, key, name, RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr().cast()), Some(&mut size)) };
        if r != ERROR_SUCCESS {
            return None;
        }
        let n = (size as usize / 2).saturating_sub(1).min(buf.len());
        Some(String::from_utf16_lossy(&buf[..n]).trim_end_matches('\0').to_string())
    };
    let dir = read(w!("InstallLocation"))?.trim().trim_matches('"').to_string();
    let ver = read(w!("DisplayVersion"))?.trim().to_string();
    (!dir.is_empty() && !ver.is_empty()).then(|| (std::path::PathBuf::from(dir), ver))
}

/// Версия установленного движка WebView2 (это Edge той же версии), например «142.0.3595.80».
pub fn webview_version() -> Option<String> {
    let mut p = windows::core::PWSTR::null();
    unsafe {
        webview2_com::Microsoft::Web::WebView2::Win32::GetAvailableCoreWebView2BrowserVersionString(windows::core::PCWSTR::null(), &mut p).ok()?;
    }
    if p.is_null() {
        return None;
    }
    Some(webview2_com::take_pwstr(p))
}
use webview2_com::Microsoft::Web::WebView2::Win32::{COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_JPEG, COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG};
use windows::core::BOOL;
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::{CreateBitmap, DeleteObject, HGDIOBJ};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER, STATFLAG_NONAME, STREAM_SEEK_SET};
use windows::Win32::UI::Shell::{
    DefSubclassProc, ITaskbarList3, SHCreateMemStream, SetWindowSubclass, TaskbarList, THB_FLAGS, THB_ICON, THB_TOOLTIP, THBF_ENABLED, THBN_CLICKED,
    THUMBBUTTON,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateIconIndirect, DestroyIcon, GetWindowLongPtrW, SetLayeredWindowAttributes, SetWindowLongPtrW, GWL_EXSTYLE, HICON, ICONINFO, LWA_ALPHA,
    WM_COMMAND, WS_EX_LAYERED, WS_EX_TOOLWINDOW,
};

static APP: OnceLock<AppHandle> = OnceLock::new();

struct Icons {
    prev: HICON,
    play: HICON,
    pause: HICON,
    next: HICON,
}
unsafe impl Send for Icons {}

static THUMB: Mutex<Option<Icons>> = Mutex::new(None);
static THUMB_ADDED: Mutex<bool> = Mutex::new(false);
const BTN_PREV: u32 = 1;
const BTN_TOGGLE: u32 = 2;
const BTN_NEXT: u32 = 3;

/// PNG (data:URL) → значок Windows.
fn hicon_from_data_url(url: &str) -> Option<HICON> {
    use base64::Engine;
    let b64 = url.split_once(",")?.1;
    let png = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    let img = tauri::image::Image::from_bytes(&png).ok()?;
    let (w, h) = (img.width() as i32, img.height() as i32);
    // RGBA → BGRA с премультипликацией не нужна: CreateIconIndirect берёт 32-битный DIB с альфой
    let mut bgra = img.rgba().to_vec();
    for px in bgra.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
    unsafe {
        let color = CreateBitmap(w, h, 1, 32, Some(bgra.as_ptr() as *const _));
        let mask_bits = vec![0u8; ((w + 15) / 16 * 2 * h) as usize];
        let mask = CreateBitmap(w, h, 1, 1, Some(mask_bits.as_ptr() as *const _));
        let info = ICONINFO { fIcon: BOOL(1), xHotspot: 0, yHotspot: 0, hbmMask: mask, hbmColor: color };
        let icon = CreateIconIndirect(&info).ok();
        let _ = DeleteObject(HGDIOBJ(color.0));
        let _ = DeleteObject(HGDIOBJ(mask.0));
        icon
    }
}

pub fn set_thumb_icons(win: &WebviewWindow, icons: &serde_json::Value) {
    let get = |k: &str| icons.get(k).and_then(|v| v.as_str()).and_then(hicon_from_data_url);
    let (Some(prev), Some(play), Some(pause), Some(next)) = (get("prev"), get("play"), get("pause"), get("next")) else { return };
    if let Some(old) = THUMB.lock().unwrap().replace(Icons { prev, play, pause, next }) {
        unsafe {
            let _ = DestroyIcon(old.prev);
            let _ = DestroyIcon(old.play);
            let _ = DestroyIcon(old.pause);
            let _ = DestroyIcon(old.next);
        }
    }
    update_thumbar(win, false);
}

fn tip(s: &str) -> [u16; 260] {
    let mut t = [0u16; 260];
    for (i, c) in s.encode_utf16().take(259).enumerate() {
        t[i] = c;
    }
    t
}

pub fn update_thumbar(win: &WebviewWindow, playing: bool) {
    let Ok(hwnd) = win.hwnd() else { return };
    let hwnd_raw = hwnd.0 as isize;
    let _ = win.run_on_main_thread(move || {
        let hwnd = HWND(hwnd_raw as *mut _);
        let guard = THUMB.lock().unwrap();
        let Some(ic) = guard.as_ref() else { return };
        let mk = |id: u32, icon: HICON, text: &str| THUMBBUTTON {
            dwMask: THB_ICON | THB_TOOLTIP | THB_FLAGS,
            iId: id,
            iBitmap: 0,
            hIcon: icon,
            szTip: tip(text),
            dwFlags: THBF_ENABLED,
        };
        let buttons = [
            mk(BTN_PREV, ic.prev, "Предыдущий"),
            mk(BTN_TOGGLE, if playing { ic.pause } else { ic.play }, if playing { "Пауза" } else { "Играть" }),
            mk(BTN_NEXT, ic.next, "Следующий"),
        ];
        unsafe {
            let Ok(tb) = CoCreateInstance::<_, ITaskbarList3>(&TaskbarList, None, CLSCTX_INPROC_SERVER) else { return };
            if tb.HrInit().is_err() {
                return;
            }
            let mut added = THUMB_ADDED.lock().unwrap();
            if !*added {
                if tb.ThumbBarAddButtons(hwnd, &buttons).is_ok() {
                    *added = true;
                }
            } else {
                let _ = tb.ThumbBarUpdateButtons(hwnd, &buttons);
            }
        }
    });
}

unsafe extern "system" fn subclass_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, _data: usize) -> LRESULT {
    if msg == WM_COMMAND && ((wparam.0 >> 16) & 0xffff) as u32 == THBN_CLICKED {
        let cmd = match (wparam.0 & 0xffff) as u32 {
            BTN_PREV => Some("prev"),
            BTN_TOGGLE => Some("toggle"),
            BTN_NEXT => Some("next"),
            _ => None,
        };
        if let (Some(cmd), Some(app)) = (cmd, APP.get()) {
            let _ = app.emit("media:command", cmd);
            return LRESULT(0);
        }
    }
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

/// Ловим нажатия кнопок на миниатюре (они приходят окну как WM_COMMAND).
pub fn install_hooks(app: &AppHandle, win: &WebviewWindow) {
    let _ = APP.set(app.clone());
    if let Ok(hwnd) = win.hwnd() {
        let raw = hwnd.0 as isize;
        let _ = win.run_on_main_thread(move || unsafe {
            let _ = SetWindowSubclass(HWND(raw as *mut _), Some(subclass_proc), 0x5A47, 0);
        });
    }
}

/// Служебный режим снимков: окно есть (иначе не идут анимации), но полностью прозрачно и без кнопки в панели задач.
pub fn make_invisible(win: &WebviewWindow) {
    if let Ok(hwnd) = win.hwnd() {
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_LAYERED.0 as isize | WS_EX_TOOLWINDOW.0 as isize);
            let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 0, LWA_ALPHA);
        }
    }
}

/// Снимок содержимого WebView в PNG; по готовности вызывает done(путь сохранён или ошибка).
pub fn capture_png(win: &WebviewWindow, out: std::path::PathBuf, done: impl FnOnce(Result<(), String>) + Send + 'static) {
    let done = std::sync::Arc::new(Mutex::new(Some(Box::new(done) as Box<dyn FnOnce(Result<(), String>) + Send>)));
    let d2 = done.clone();
    let r = win.with_webview(move |wv| unsafe {
        let finish = move |r: Result<(), String>| {
            if let Some(f) = d2.lock().unwrap().take() {
                f(r)
            }
        };
        let core = match wv.controller().CoreWebView2() {
            Ok(c) => c,
            Err(e) => return finish(Err(e.to_string())),
        };
        let Some(stream) = SHCreateMemStream(None) else { return finish(Err("stream".into())) };
        let s2 = stream.clone();
        let handler = CapturePreviewCompletedHandler::create(Box::new(move |res| {
            let r = res
                .map_err(|e| e.to_string())
                .and_then(|_| read_stream(&s2).ok_or_else(|| "stream".to_string()))
                .and_then(|buf| std::fs::write(&out, buf).map_err(|e| e.to_string()));
            finish(r);
            Ok(())
        }));
        if let Err(e) = core.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, &stream, &handler) {
            if let Some(f) = done.lock().unwrap().take() {
                f(Err(e.to_string()))
            }
        }
    });
    if let Err(e) = r {
        eprintln!("capture failed: {e}");
    }
}

unsafe fn read_stream(s: &windows::Win32::System::Com::IStream) -> Option<Vec<u8>> {
    let mut stat = Default::default();
    s.Stat(&mut stat, STATFLAG_NONAME).ok()?;
    s.Seek(0, STREAM_SEEK_SET, None).ok()?;
    let mut buf = vec![0u8; stat.cbSize as usize];
    let mut read = 0u32;
    let _ = s.Read(buf.as_mut_ptr() as *mut _, buf.len() as u32, Some(&mut read));
    buf.truncate(read as usize);
    Some(buf)
}

/// Снимок того, что уже нарисовано в окне (WebView2 CapturePreview, JPEG). Просто копирует готовый кадр —
/// в отличие от снимка через DevTools с масштабом, который на миг перестраивает страницу и заметно «моргает».
pub fn capture_jpeg(win: &WebviewWindow) -> tokio::sync::oneshot::Receiver<Option<Vec<u8>>> {
    type Tx = std::sync::Arc<Mutex<Option<tokio::sync::oneshot::Sender<Option<Vec<u8>>>>>>;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let tx: Tx = std::sync::Arc::new(Mutex::new(Some(tx)));
    let send = |tx: &Tx, v: Option<Vec<u8>>| {
        if let Some(t) = tx.lock().unwrap().take() {
            let _ = t.send(v);
        }
    };
    let tx2 = tx.clone();
    let r = win.with_webview(move |wv| unsafe {
        let Ok(core) = wv.controller().CoreWebView2() else { return send(&tx2, None) };
        let Some(stream) = SHCreateMemStream(None) else { return send(&tx2, None) };
        let s2 = stream.clone();
        let tx3 = tx2.clone();
        let handler = CapturePreviewCompletedHandler::create(Box::new(move |res| {
            send(&tx3, res.ok().and_then(|_| read_stream(&s2)));
            Ok(())
        }));
        if core.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_JPEG, &stream, &handler).is_err() {
            send(&tx2, None);
        }
    });
    if r.is_err() {
        send(&tx, None);
    }
    rx
}

/// Уменьшенная серая копия картинки (средствами Windows, WIC): ширина не больше `max_w`, байт на точку.
pub fn gray_thumb(img: &[u8], max_w: u32) -> Option<(u32, u32, Vec<u8>)> {
    use windows::Win32::Graphics::Imaging::{
        CLSID_WICImagingFactory, GUID_WICPixelFormat8bppGray, IWICImagingFactory, IWICPalette, WICBitmapDitherTypeNone, WICBitmapInterpolationModeFant,
        WICBitmapPaletteTypeCustom, WICDecodeMetadataCacheOnDemand,
    };
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let f: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).ok()?;
        let st = f.CreateStream().ok()?;
        st.InitializeFromMemory(img).ok()?;
        let dec = f.CreateDecoderFromStream(&st, std::ptr::null(), WICDecodeMetadataCacheOnDemand).ok()?;
        let frame = dec.GetFrame(0).ok()?;
        let (mut w, mut h) = (0u32, 0u32);
        frame.GetSize(&mut w, &mut h).ok()?;
        if w == 0 || h == 0 {
            return None;
        }
        let tw = max_w.min(w).max(1);
        let th = ((h as u64 * tw as u64) / w as u64).max(1) as u32;
        let sc = f.CreateBitmapScaler().ok()?;
        sc.Initialize(&frame, tw, th, WICBitmapInterpolationModeFant).ok()?;
        let cv = f.CreateFormatConverter().ok()?;
        cv.Initialize(&sc, &GUID_WICPixelFormat8bppGray, WICBitmapDitherTypeNone, None::<&IWICPalette>, 0.0, WICBitmapPaletteTypeCustom).ok()?;
        let stride = (tw + 3) & !3;
        let mut buf = vec![0u8; (stride * th) as usize];
        cv.CopyPixels(std::ptr::null(), stride, &mut buf).ok()?;
        let mut out = Vec::with_capacity((tw * th) as usize);
        for y in 0..th as usize {
            let s = y * stride as usize;
            out.extend_from_slice(&buf[s..s + tw as usize]);
        }
        Some((tw, th, out))
    }
}

/// Вызов метода DevTools-протокола WebView2 (служебные проверки: настоящие движения мыши и т. п.).
pub fn cdp(win: &WebviewWindow, method: &'static str, params: String) {
    let _ = win.with_webview(move |wv| unsafe {
        let Ok(core) = wv.controller().CoreWebView2() else { return };
        let m = windows::core::HSTRING::from(method);
        let p = windows::core::HSTRING::from(params);
        let handler = webview2_com::CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_res, _json| Ok(())));
        let _ = core.CallDevToolsProtocolMethod(&m, &p, &handler);
    });
}

pub fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}
