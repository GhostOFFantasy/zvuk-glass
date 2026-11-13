//! Автосинхронизация клипа слушает звук устройства вывода — на телефоне так нельзя (нужно разрешение на
//! запись экрана), поэтому здесь её нет; ручной сдвиг клипа работает как обычно.

use serde_json::Value;

use crate::zvuk::{ApiError, ApiResult, ZvukClient};

pub struct Sync;

fn unavailable() -> ApiError {
    ApiError::new("UNSUPPORTED", "Автосинхронизация по звуку доступна только в версии для Windows")
}

impl Sync {
    pub fn new() -> Self {
        Sync
    }

    pub async fn prepare(&self, _client: &ZvukClient, _track_id: &str) -> ApiResult<Value> {
        Err(unavailable())
    }

    pub async fn measure(&self, _track_id: &str, _seconds: f64, _lo: f64, _hi: f64) -> ApiResult<Value> {
        Err(unavailable())
    }
}
