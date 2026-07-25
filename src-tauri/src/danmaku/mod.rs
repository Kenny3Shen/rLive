pub mod bilibili;
pub mod douyin;
pub mod douyu;
pub mod huya;
pub mod tars;

use std::sync::Mutex;

use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};
use crate::models::live::{DanmakuEvent, SiteId};

/// Manages a single active danmaku connection for the app.
pub struct DanmakuManager {
    inner: Mutex<DanmakuConnectionState>,
}

struct DanmakuConnectionState {
    /// The newest route-level connection request accepted by the backend.
    generation: u64,
    handle: Option<JoinHandle<()>>,
}

impl Default for DanmakuManager {
    fn default() -> Self {
        Self {
            inner: Mutex::new(DanmakuConnectionState {
                generation: 0,
                handle: None,
            }),
        }
    }
}

impl DanmakuManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn abort_active(state: &mut DanmakuConnectionState) {
        if let Some(handle) = state.handle.take() {
            handle.abort();
        }
    }

    /// Marks a route request as the only connection allowed to install a task.
    ///
    /// `danmaku_connect` has to fetch room metadata before it can open the
    /// websocket. A slow request from a room that was already left must not
    /// install itself after a newer route is active, hence the caller-provided
    /// monotonically increasing generation.
    pub fn begin_connect(&self, generation: u64) -> bool {
        let Ok(mut state) = self.inner.lock() else {
            return false;
        };
        if generation < state.generation {
            return false;
        }
        state.generation = generation;
        Self::abort_active(&mut state);
        true
    }

    pub fn is_current(&self, generation: u64) -> bool {
        self.inner
            .lock()
            .map(|state| state.generation == generation)
            .unwrap_or(false)
    }

    /// Stops only requests at or before `generation`; an older frontend
    /// cleanup therefore cannot terminate a newer room's connection.
    pub fn disconnect_for_generation(&self, generation: u64) -> bool {
        let Ok(mut state) = self.inner.lock() else {
            return false;
        };
        if generation < state.generation {
            return false;
        }
        state.generation = generation;
        Self::abort_active(&mut state);
        true
    }

    pub fn disconnect(&self) {
        if let Ok(mut state) = self.inner.lock() {
            state.generation = state.generation.saturating_add(1);
            Self::abort_active(&mut state);
        }
    }

    /// Installs the task only when the request is still current. Returns false
    /// and aborts the task if another room superseded it while its metadata was
    /// loading.
    pub fn set_task_if_current(&self, generation: u64, task: JoinHandle<()>) -> bool {
        let Ok(mut state) = self.inner.lock() else {
            task.abort();
            return false;
        };
        if state.generation != generation {
            task.abort();
            return false;
        }
        Self::abort_active(&mut state);
        state.handle = Some(task);
        true
    }
}

fn spawn_loop<F>(
    app: AppHandle,
    manager: &DanmakuManager,
    generation: u64,
    site: &'static str,
    fut: F,
) where
    F: std::future::Future<Output = AppResult<()>> + Send + 'static,
{
    let app2 = app.clone();
    // Do not let the task run until its generation is installed. Without this
    // gate a route switch in the tiny window between `spawn` and manager
    // registration could still emit a stale room's first event.
    let (start_tx, start_rx) = tokio::sync::oneshot::channel::<()>();
    let task = tauri::async_runtime::spawn(async move {
        if start_rx.await.is_err() {
            return;
        }
        if let Err(e) = fut.await {
            tracing::warn!("{site} danmaku ended: {e}");
            let _ = app2.emit(
                "danmaku",
                DanmakuEvent {
                    kind: crate::models::live::DanmakuKind::System,
                    user: "system".into(),
                    content: format!("弹幕连接断开: {e}"),
                    color: None,
                    super_chat: None,
                    ts: chrono::Utc::now().timestamp_millis(),
                },
            );
        }
    });
    if manager.set_task_if_current(generation, task) {
        let _ = start_tx.send(());
    }
}

pub async fn connect(
    app: AppHandle,
    manager: &DanmakuManager,
    generation: u64,
    site_id: SiteId,
    room_id: &str,
    detail_raw: &serde_json::Value,
    douyin_sign_service: Option<&str>,
    cookie: &str,
    proxy: Option<&str>,
) -> AppResult<()> {
    if !manager.is_current(generation) {
        return Ok(());
    }

    match site_id {
        SiteId::Bilibili => {
            let args = bilibili::args_from_raw(room_id, detail_raw)?;
            if args.token.is_empty() {
                return Err(
                    AppError::new("danmaku_missing_token", "弹幕 token 缺失，无法连接")
                        .with_site("bilibili"),
                );
            }
            spawn_loop(
                app.clone(),
                manager,
                generation,
                "bilibili",
                bilibili::run_loop(app, args),
            );
            Ok(())
        }
        SiteId::Douyu => {
            let args = douyu::args_from_raw(room_id, detail_raw)?;
            spawn_loop(
                app.clone(),
                manager,
                generation,
                "douyu",
                douyu::run_loop(app, args),
            );
            Ok(())
        }
        SiteId::Huya => {
            let args = huya::args_from_raw(room_id, detail_raw)?;
            spawn_loop(
                app.clone(),
                manager,
                generation,
                "huya",
                huya::run_loop(app, args),
            );
            Ok(())
        }
        SiteId::Douyin => {
            let args = douyin::request_signed_connection(
                douyin_sign_service,
                room_id,
                detail_raw,
                cookie,
                proxy,
            )
            .await?;
            // The signing request may take longer than a room transition.
            // Do not let a stale result install itself after a new route won.
            if !manager.is_current(generation) {
                return Ok(());
            }
            spawn_loop(
                app.clone(),
                manager,
                generation,
                "douyin",
                douyin::run_loop(app, args),
            );
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

#[cfg(test)]
mod tests {
    use super::DanmakuManager;

    #[test]
    fn newer_connection_epochs_fence_stale_connects_and_cleanups() {
        let manager = DanmakuManager::new();

        assert!(manager.begin_connect(100));
        assert!(manager.begin_connect(101));
        assert!(!manager.begin_connect(100));
        assert!(manager.is_current(101));

        // A delayed cleanup from the old room must leave the newer room alive.
        assert!(!manager.disconnect_for_generation(100));
        assert!(manager.is_current(101));

        assert!(manager.disconnect_for_generation(102));
        assert!(manager.is_current(102));
    }
}
