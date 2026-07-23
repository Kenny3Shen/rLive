pub mod bilibili;

use std::sync::Mutex;

use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};
use crate::models::live::{DanmakuEvent, SiteId};

/// Manages a single active danmaku connection for the app.
pub struct DanmakuManager {
    handle: Mutex<Option<JoinHandle<()>>>,
}

impl Default for DanmakuManager {
    fn default() -> Self {
        Self {
            handle: Mutex::new(None),
        }
    }
}

impl DanmakuManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn disconnect(&self) {
        if let Ok(mut guard) = self.handle.lock() {
            if let Some(h) = guard.take() {
                h.abort();
            }
        }
    }

    pub fn set_task(&self, task: JoinHandle<()>) {
        self.disconnect();
        if let Ok(mut guard) = self.handle.lock() {
            *guard = Some(task);
        }
    }
}

pub async fn connect(
    app: AppHandle,
    manager: &DanmakuManager,
    site_id: SiteId,
    room_id: &str,
    detail_raw: &serde_json::Value,
) -> AppResult<()> {
    manager.disconnect();

    match site_id {
        SiteId::Bilibili => {
            let args = bilibili::args_from_raw(room_id, detail_raw)?;
            if args.token.is_empty() {
                return Err(AppError::new(
                    "danmaku_missing_token",
                    "弹幕 token 缺失，无法连接",
                )
                .with_site("bilibili"));
            }
            let app2 = app.clone();
            let task = tauri::async_runtime::spawn(async move {
                if let Err(e) = bilibili::run_loop(app2.clone(), args).await {
                    tracing::warn!("bilibili danmaku ended: {}", e);
                    let _ = app2.emit(
                        "danmaku",
                        DanmakuEvent {
                            kind: crate::models::live::DanmakuKind::System,
                            user: "system".into(),
                            content: format!("danmaku disconnected: {e}"),
                            color: None,
                            ts: chrono::Utc::now().timestamp_millis(),
                        },
                    );
                }
            });
            manager.set_task(task);
            Ok(())
        }
        other => Err(AppError::new(
            "not_implemented",
            format!("danmaku not implemented for {}", other.as_str()),
        )
        .with_site(other.as_str())),
    }
}

pub fn emit_event(app: &AppHandle, event: DanmakuEvent) {
    let _ = app.emit("danmaku", event);
}
