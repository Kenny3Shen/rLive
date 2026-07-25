pub mod bilibili;
pub mod douyin;
pub mod douyu;
pub mod huya;
pub mod tars;

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio::time::{self, MissedTickBehavior};

use crate::error::{AppError, AppResult};
use crate::models::live::{DanmakuEvent, SiteId};

/// The frontend receives at most one danmaku event payload every 50ms.  A
/// bounded ingress queue keeps a sudden busy-room burst from growing without
/// limit while the webview is busy rendering a previous batch.
const DANMAKU_EVENT_CHANNEL_CAPACITY: usize = 2_048;
const DANMAKU_BATCH_MAX_EVENTS: usize = 512;
const DANMAKU_BATCH_INTERVAL: Duration = Duration::from_millis(50);

/// Non-blocking handle used by site websocket loops to forward decoded
/// danmaku to the batched Tauri event dispatcher.
#[derive(Clone)]
pub struct DanmakuEventSender(mpsc::Sender<DanmakuEvent>);

#[derive(Clone, Serialize)]
struct DanmakuBatch<'a> {
    connection_epoch: u64,
    events: &'a [DanmakuEvent],
}

impl DanmakuEventSender {
    fn new(sender: mpsc::Sender<DanmakuEvent>) -> Self {
        Self(sender)
    }

    fn send(&self, event: DanmakuEvent) {
        // Receiving must never wait on the webview.  When an exceptional
        // burst fills the bounded queue, keeping the live connection healthy
        // matters more than retaining every already-stale chat message.
        let _ = self.0.try_send(event);
    }
}

/// Manages a single active danmaku connection for the app.
pub struct DanmakuManager {
    inner: Mutex<DanmakuConnectionState>,
}

struct DanmakuConnectionState {
    /// The newest route-level connection request accepted by the backend.
    generation: u64,
    connection_handle: Option<JoinHandle<()>>,
    batch_handle: Option<JoinHandle<()>>,
}

impl Default for DanmakuManager {
    fn default() -> Self {
        Self {
            inner: Mutex::new(DanmakuConnectionState {
                generation: 0,
                connection_handle: None,
                batch_handle: None,
            }),
        }
    }
}

impl DanmakuManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn abort_active(state: &mut DanmakuConnectionState) {
        if let Some(handle) = state.connection_handle.take() {
            handle.abort();
        }
        if let Some(handle) = state.batch_handle.take() {
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
    pub fn set_tasks_if_current(
        &self,
        generation: u64,
        connection_task: JoinHandle<()>,
        batch_task: JoinHandle<()>,
    ) -> bool {
        let Ok(mut state) = self.inner.lock() else {
            connection_task.abort();
            batch_task.abort();
            return false;
        };
        if state.generation != generation {
            connection_task.abort();
            batch_task.abort();
            return false;
        }
        Self::abort_active(&mut state);
        state.connection_handle = Some(connection_task);
        state.batch_handle = Some(batch_task);
        true
    }
}

fn spawn_loop<F, Fut>(
    app: AppHandle,
    manager: &DanmakuManager,
    generation: u64,
    site: &'static str,
    fut: F,
) where
    F: FnOnce(DanmakuEventSender) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = AppResult<()>> + Send + 'static,
{
    let (event_tx, event_rx) = mpsc::channel(DANMAKU_EVENT_CHANNEL_CAPACITY);
    let batch_task =
        tauri::async_runtime::spawn(dispatch_batches(app.clone(), generation, event_rx));
    // Do not let the task run until its generation is installed. Without this
    // gate a route switch in the tiny window between `spawn` and manager
    // registration could still emit a stale room's first event.
    let (start_tx, start_rx) = tokio::sync::oneshot::channel::<()>();
    let sender = DanmakuEventSender::new(event_tx);
    let error_sender = sender.clone();
    let connection_task = tauri::async_runtime::spawn(async move {
        if start_rx.await.is_err() {
            return;
        }
        if let Err(e) = fut(sender).await {
            tracing::warn!("{site} danmaku ended: {e}");
            emit_event(
                &error_sender,
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
    if manager.set_tasks_if_current(generation, connection_task, batch_task) {
        let _ = start_tx.send(());
    }
}

async fn dispatch_batches(
    app: AppHandle,
    generation: u64,
    mut receiver: mpsc::Receiver<DanmakuEvent>,
) {
    let mut ticker = time::interval(DANMAKU_BATCH_INTERVAL);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    // `interval` ticks immediately by design.  Wait one full period before
    // the first delivery so several events from the same websocket frame are
    // coalesced too.
    ticker.tick().await;

    let mut batch = Vec::with_capacity(DANMAKU_BATCH_MAX_EVENTS);
    loop {
        tokio::select! {
            event = receiver.recv() => match event {
                Some(event) => {
                    // Preserve the 20fps upper bound even for an extreme
                    // burst.  Additional chat is intentionally shed rather
                    // than creating a giant serialization/DOM workload.
                    if batch.len() < DANMAKU_BATCH_MAX_EVENTS {
                        batch.push(event);
                    }
                }
                None => {
                    emit_batch(&app, generation, &mut batch);
                    return;
                }
            },
            _ = ticker.tick() => emit_batch(&app, generation, &mut batch),
        }
    }
}

fn emit_batch(app: &AppHandle, generation: u64, batch: &mut Vec<DanmakuEvent>) {
    if batch.is_empty() {
        return;
    }
    // The frontend owns retention and rendering policy. The tiny envelope
    // retains the connection fence while carrying all events for this tick,
    // so ordinary chat, Super Chat, and canvas listeners each process one
    // native callback instead of one callback per message.
    let _ = app.emit(
        "danmaku-batch",
        DanmakuBatch {
            connection_epoch: generation,
            events: &*batch,
        },
    );
    batch.clear();
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
                move |events| bilibili::run_loop(events, args),
            );
            Ok(())
        }
        SiteId::Douyu => {
            let args = douyu::args_from_raw(room_id, detail_raw)?;
            spawn_loop(app.clone(), manager, generation, "douyu", move |events| {
                douyu::run_loop(events, args)
            });
            Ok(())
        }
        SiteId::Huya => {
            let args = huya::args_from_raw(room_id, detail_raw)?;
            spawn_loop(app.clone(), manager, generation, "huya", move |events| {
                huya::run_loop(events, args)
            });
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
            spawn_loop(app.clone(), manager, generation, "douyin", move |events| {
                douyin::run_loop(events, args)
            });
            Ok(())
        }
        other => Err(AppError::new(
            "not_implemented",
            format!("danmaku not implemented for {}", other.as_str()),
        )
        .with_site(other.as_str())),
    }
}

pub fn emit_event(sender: &DanmakuEventSender, event: DanmakuEvent) {
    sender.send(event);
}

#[cfg(test)]
mod tests {
    use super::{DanmakuBatch, DanmakuManager};
    use crate::models::live::{DanmakuEvent, DanmakuKind};

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

    #[test]
    fn batch_payload_keeps_the_frontend_transport_contract() {
        let events = [DanmakuEvent {
            kind: DanmakuKind::Chat,
            user: "viewer".into(),
            content: "hello".into(),
            color: None,
            super_chat: None,
            ts: 1,
        }];
        let value = serde_json::to_value(DanmakuBatch {
            connection_epoch: 42,
            events: &events,
        })
        .unwrap();

        assert_eq!(value["connection_epoch"], 42);
        assert_eq!(value["events"].as_array().map(Vec::len), Some(1));
    }
}
