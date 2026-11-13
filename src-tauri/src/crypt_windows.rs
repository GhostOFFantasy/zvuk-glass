//! Шифрование секретов средствами Windows (DPAPI) и чтение того, что сохранила Electron-версия (safeStorage).

use std::path::Path;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use windows::Win32::Foundation::{HLOCAL, LocalFree};
use windows::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};

fn blob_to_vec(b: &CRYPT_INTEGER_BLOB) -> Vec<u8> {
    if b.pbData.is_null() {
        return vec![];
    }
    let v = unsafe { std::slice::from_raw_parts(b.pbData, b.cbData as usize) }.to_vec();
    unsafe {
        let _ = LocalFree(Some(HLOCAL(b.pbData as *mut _)));
    }
    v
}

pub fn protect(data: &[u8]) -> Option<Vec<u8>> {
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut out = CRYPT_INTEGER_BLOB::default();
    unsafe { CryptProtectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out) }.ok()?;
    Some(blob_to_vec(&out))
}

pub fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut out = CRYPT_INTEGER_BLOB::default();
    unsafe { CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out) }.ok()?;
    Some(blob_to_vec(&out))
}

/// Строка → base64 зашифрованного блока.
pub fn seal(text: &str) -> Option<String> {
    protect(text.as_bytes()).map(|b| B64.encode(b))
}

pub fn open(b64: &str) -> Option<String> {
    let raw = B64.decode(b64).ok()?;
    String::from_utf8(unprotect(&raw)?).ok()
}

/// Расшифровка значения, сохранённого Electron `safeStorage.encryptString` в Windows:
/// "v10" + nonce(12) + AES-256-GCM, ключ лежит в `Local State` (os_crypt.encrypted_key, защищён DPAPI).
pub fn open_electron(data_dir: &Path, b64: &str) -> Option<String> {
    open_electron_steps(data_dir, b64).ok()
}

/// То же, но с указанием шага, на котором не получилось (для служебной проверки).
pub fn open_electron_steps(data_dir: &Path, b64: &str) -> Result<String, &'static str> {
    let text = std::fs::read_to_string(data_dir.join("Local State")).map_err(|_| "нет Local State")?;
    let state: serde_json::Value = serde_json::from_str(&text).map_err(|_| "Local State не JSON")?;
    let enc_key = state.pointer("/os_crypt/encrypted_key").and_then(|v| v.as_str()).ok_or("нет encrypted_key")?;
    let enc_key = B64.decode(enc_key).map_err(|_| "encrypted_key не base64")?;
    let key = unprotect(enc_key.strip_prefix(b"DPAPI").ok_or("ключ без DPAPI")?).ok_or("DPAPI не расшифровал ключ")?;
    let data = B64.decode(b64).map_err(|_| "значение не base64")?;
    if data.len() > 3 + 12 + 16 && data.starts_with(b"v10") {
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| "длина ключа")?;
        let plain = cipher.decrypt(Nonce::from_slice(&data[3..15]), &data[15..]).map_err(|_| "AES-GCM не расшифровал")?;
        return String::from_utf8(plain).map_err(|_| "не UTF-8");
    }
    // очень старый формат: целиком DPAPI
    String::from_utf8(unprotect(&data).ok_or("DPAPI не расшифровал значение")?).map_err(|_| "не UTF-8")
}
