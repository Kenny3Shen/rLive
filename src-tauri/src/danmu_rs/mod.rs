pub mod bilibili;
pub mod douyin;
pub mod douyin_sign;
pub mod douyu;
pub mod huya;
pub mod reconnect;
pub mod tars;
pub mod twitch;

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
#[cfg(not(target_os = "android"))]
use tauri::Manager;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot};
use tokio::time::{self, MissedTickBehavior};

use crate::error::{AppError, AppResult};
use crate::models::live::{DanmakuEvent, DanmakuKind, SiteId};

/// 前端每 50ms 最多收到一个弹幕事件负载。有界的入队队列可避免在 webview
/// 忙于渲染上一批时，繁忙房间的突发流量无限增长。
const DANMAKU_EVENT_CHANNEL_CAPACITY: usize = 2_048;
const DANMAKU_BATCH_MAX_EVENTS: usize = 512;
const DANMAKU_BATCH_INTERVAL: Duration = Duration::from_millis(50);
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
const DANMAKU_FINAL_FLUSH_TIMEOUT: Duration = Duration::from_secs(1);
const MAX_ACCOUNT_ID_CHARS: usize = 128;
const MAX_ACCOUNT_NAME_CHARS: usize = 128;

/// 某个活动站点连接的、由 Cookie 派生的身份。
///
/// 这里刻意只保留在后端：事件分发器会把它转换成布尔的 `is_self` 标记，
/// 而账号 ID、用户名和 Cookie 值都不会跨越 Tauri IPC 边界。
#[derive(Clone, Default)]
struct SelfDanmakuIdentity {
    user_ids: HashSet<String>,
    user_names: HashSet<String>,
}

impl SelfDanmakuIdentity {
    fn from_cookie(site_id: &SiteId, cookie: &str) -> Self {
        let (id_keys, site_name_keys): (&[&str], &[&str]) = match site_id {
            // Bilibili 的浏览器 Cookie 有稳定的账号 mid，
            // 但通常不包含显示名。
            SiteId::Bilibili => (&["DedeUserID"], &["DedeUserName"]),
            // 斗鱼的扫码／浏览器 Cookie 同时携带账号 uid 与显示名，
            // 因此当中继省略 uid 时名称仍然有用。
            SiteId::Douyu => (&["acf_uid", "uid"], &["acf_username"]),
            // 虎牙会根据认证流程使用两种 uid 字段之一；
            // `udb_n` 是其浏览器账号名字段。
            SiteId::Huya => (&["yyuid", "udb_uid"], &["udb_n"]),
            // 不要从抖音／Twitch 的不透明会话 token 推断身份。
            // 可读的显式名称仍是安全的兜底。
            SiteId::Douyin | SiteId::Twitch => (&[], &[]),
        };
        const GENERIC_NAME_KEYS: &[&str] =
            &["username", "user_name", "nickname", "nick", "display_name"];

        let mut identity = Self::default();
        for value in cookie_values(cookie, id_keys) {
            if let Some(user_id) = normalize_user_id(&value) {
                identity.user_ids.insert(user_id);
            }
        }
        for value in cookie_values(cookie, site_name_keys)
            .into_iter()
            .chain(cookie_values(cookie, GENERIC_NAME_KEYS))
        {
            if let Some(user_name) = normalize_user_name(&value) {
                identity.user_names.insert(user_name);
            }
        }
        identity
    }

    fn matches(&self, event: &DanmakuEvent) -> bool {
        if matches!(&event.kind, DanmakuKind::System) {
            return false;
        }

        // 当 Cookie 也给出了 ID 时，事件中的 ID 具有权威性。此时若回退到显示名，
        // 可能会高亮另一位昵称恰好与我们相同的用户。
        if let Some(event_id) = event.user_id.as_deref().and_then(normalize_user_id)
            && !self.user_ids.is_empty()
        {
            return self.user_ids.contains(&event_id);
        }

        normalize_user_name(&event.user).is_some_and(|name| self.user_names.contains(&name))
    }

    fn mark(&self, event: &mut DanmakuEvent) {
        event.is_self = self.matches(event);
    }
}

fn cookie_values(cookie: &str, names: &[&str]) -> Vec<String> {
    if names.is_empty() {
        return Vec::new();
    }
    let cookie = cookie.trim();
    let cookie = cookie
        .strip_prefix("Cookie:")
        .or_else(|| cookie.strip_prefix("cookie:"))
        .unwrap_or(cookie);

    cookie
        .split(';')
        .filter_map(|pair| pair.trim().split_once('='))
        .filter(|(name, _)| {
            names
                .iter()
                .any(|expected| name.trim().eq_ignore_ascii_case(expected))
        })
        .filter_map(|(_, value)| {
            let value = value.trim().trim_matches('"');
            (value.len() <= MAX_ACCOUNT_NAME_CHARS * 4).then(|| percent_decode_cookie_value(value))
        })
        .collect()
}

/// 在多个 Web 登录流程中，Cookie 值会用百分号转义编码显示名。
/// 与 URL 表单不同，Cookie 编码把 `+` 当作字面字符。
fn percent_decode_cookie_value(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let high = (bytes[index + 1] as char).to_digit(16);
            let low = (bytes[index + 2] as char).to_digit(16);
            if let (Some(high), Some(low)) = (high, low) {
                decoded.push((high * 16 + low) as u8);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(decoded).unwrap_or_else(|_| value.to_owned())
}

fn normalize_user_id(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && value != "0" && value.chars().count() <= MAX_ACCOUNT_ID_CHARS)
        .then(|| value.to_owned())
}

fn normalize_user_name(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && value.chars().count() <= MAX_ACCOUNT_NAME_CHARS)
        .then(|| value.to_lowercase())
}

/// 供站点 websocket 循环使用的非阻塞句柄，
/// 用于把解码后的弹幕转发给批量 Tauri 事件分发器。
#[derive(Clone)]
pub struct DanmakuEventSender {
    sender: mpsc::Sender<DanmakuEvent>,
    identity: SelfDanmakuIdentity,
}

#[derive(Clone, Serialize)]
struct DanmakuBatch<'a> {
    connection_epoch: u64,
    events: &'a [DanmakuEvent],
}

impl DanmakuEventSender {
    fn new(sender: mpsc::Sender<DanmakuEvent>, identity: SelfDanmakuIdentity) -> Self {
        Self { sender, identity }
    }

    fn send(&self, mut event: DanmakuEvent) {
        self.identity.mark(&mut event);
        // 接收绝不能等待 webview。当异常突发填满有界队列时，
        // 保持实时连接健康比留住每条已经过时的聊天消息更重要。
        let _ = self.sender.try_send(event);
    }
}

/// 管理房间页当前的弹幕连接，以及被后台录制保留的连接。后台批次仍携带其
/// 原始 generation，因此前端会忽略它们，而录制伴生任务继续按
/// `source_key` 接收事件。
pub struct DanmakuManager {
    inner: Mutex<DanmakuConnectionState>,
}

#[derive(Default)]
struct DanmakuTasks {
    connection_handle: Option<JoinHandle<()>>,
    batch_handle: Option<JoinHandle<()>>,
    // 只有桌面端的 flush 路径会回读这个 sender，但所有平台都必须让它存活：
    // 丢弃它会关闭控制通道，从而让 `dispatch_batches` 观察到 `None`
    // 并立即停止投递弹幕。
    #[cfg_attr(
        not(any(target_os = "windows", target_os = "linux", target_os = "macos")),
        expect(dead_code)
    )]
    batch_control: Option<mpsc::UnboundedSender<DanmakuBatchControl>>,
}

impl DanmakuTasks {
    fn abort(mut self) {
        if let Some(handle) = self.connection_handle.take() {
            handle.abort();
        }
        if let Some(handle) = self.batch_handle.take() {
            handle.abort();
        }
    }

    /// 在拆除之前先 flush 批处理任务，使录制伴生任务能拿到最后排队的事件。
    /// 只有桌面端录制路径需要这一步。
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    async fn stop_and_flush(mut self) {
        if let Some(handle) = self.connection_handle.take() {
            handle.abort();
            let _ = handle.await;
        }
        if let Some(control) = self.batch_control.take() {
            let _ = control.send(DanmakuBatchControl::StopAndFlush);
        }
        if let Some(mut handle) = self.batch_handle.take()
            && time::timeout(DANMAKU_FINAL_FLUSH_TIMEOUT, &mut handle)
                .await
                .is_err()
        {
            handle.abort();
            let _ = handle.await;
        }
    }
}

// `dispatch_batches` 在所有平台上都匹配这两个变体；只有桌面端录制路径会构造
// 它们，因此移动端构建保留该结构却不会产生死代码警告。
#[cfg_attr(
    not(any(target_os = "windows", target_os = "linux", target_os = "macos")),
    expect(dead_code)
)]
enum DanmakuBatchControl {
    Flush(oneshot::Sender<()>),
    StopAndFlush,
}

struct BackgroundDanmakuConnection {
    generation: u64,
    tasks: DanmakuTasks,
}

struct DanmakuConnectionState {
    /// 后端已接受的、最新的路由级连接请求。
    generation: u64,
    active_source_key: Option<String>,
    active_tasks: DanmakuTasks,
    background_tasks: HashMap<String, BackgroundDanmakuConnection>,
}

impl Default for DanmakuManager {
    fn default() -> Self {
        Self {
            inner: Mutex::new(DanmakuConnectionState {
                generation: 0,
                active_source_key: None,
                active_tasks: DanmakuTasks::default(),
                background_tasks: HashMap::new(),
            }),
        }
    }
}

impl DanmakuManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn abort_active_tasks(state: &mut DanmakuConnectionState) {
        std::mem::take(&mut state.active_tasks).abort();
    }

    fn clear_active(state: &mut DanmakuConnectionState) {
        Self::abort_active_tasks(state);
        state.active_source_key = None;
    }

    fn move_active_to_background(state: &mut DanmakuConnectionState) -> Option<String> {
        let source_key = state.active_source_key.take()?;
        let tasks = std::mem::take(&mut state.active_tasks);
        let connection = BackgroundDanmakuConnection {
            generation: state.generation,
            tasks,
        };
        if let Some(previous) = state
            .background_tasks
            .insert(source_key.clone(), connection)
        {
            previous.tasks.abort();
        }
        Some(source_key)
    }

    /// 把某个路由请求标记为唯一允许安装任务的连接。
    ///
    /// `danmaku_connect` 必须先获取房间元数据才能打开 websocket。已经离开的房间
    /// 发出的慢请求不得在更新的路由生效之后再安装自己，
    /// 因此需要调用方提供单调递增的 generation。
    pub fn begin_connect(
        &self,
        generation: u64,
        source_key: String,
        preserve_active: bool,
    ) -> bool {
        let Ok(mut state) = self.inner.lock() else {
            return false;
        };
        if generation < state.generation {
            return false;
        }
        if preserve_active {
            Self::move_active_to_background(&mut state);
        } else {
            Self::clear_active(&mut state);
        }
        state.generation = generation;
        // 重新进入某房间会替换它保留的连接，
        // 而不是把重复的 websocket 批次投递给同一个伴生任务。
        if let Some(previous) = state.background_tasks.remove(&source_key) {
            previous.tasks.abort();
        }
        state.active_source_key = Some(source_key);
        true
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    pub fn active_source_key(&self) -> Option<String> {
        self.inner
            .lock()
            .ok()
            .and_then(|state| state.active_source_key.clone())
    }

    /// 只有当本次清理足够新、确实会影响活动源时才返回它。
    /// 随后由调用方决定是停止还是保留。
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    pub fn source_key_for_generation(&self, generation: u64) -> Option<String> {
        self.inner.lock().ok().and_then(|state| {
            (generation >= state.generation)
                .then(|| state.active_source_key.clone())
                .flatten()
        })
    }

    #[cfg(test)]
    pub fn is_current(&self, generation: u64) -> bool {
        self.inner
            .lock()
            .map(|state| state.generation == generation)
            .unwrap_or(false)
    }

    fn accepts_connection_generation(&self, generation: u64) -> bool {
        self.inner
            .lock()
            .map(|state| {
                (state.generation == generation && state.active_source_key.is_some())
                    || state
                        .background_tasks
                        .values()
                        .any(|connection| connection.generation == generation)
            })
            .unwrap_or(false)
    }

    /// 分离当前页面但不停止其 websocket。这些任务会继续以录制源为键保留，
    /// 直到该录制结束。
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos", test))]
    pub fn detach_for_generation(&self, generation: u64) -> bool {
        let Ok(mut state) = self.inner.lock() else {
            return false;
        };
        if generation < state.generation {
            return false;
        }
        let detached = Self::move_active_to_background(&mut state).is_some();
        state.generation = generation;
        detached
    }

    /// 只停止 generation 小于或等于给定值的请求；因此较旧的前端清理
    /// 无法终止更新房间的连接。
    pub fn disconnect_for_generation(&self, generation: u64) -> bool {
        let Ok(mut state) = self.inner.lock() else {
            return false;
        };
        if generation < state.generation {
            return false;
        }
        state.generation = generation;
        Self::clear_active(&mut state);
        true
    }

    /// 只停止被保留的连接。当前已打开的同一房间持有活动连接，
    /// 它必须在录制停止后继续存活。
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos", test))]
    pub fn disconnect_background_for_source(&self, source_key: &str) -> bool {
        let Ok(mut state) = self.inner.lock() else {
            return false;
        };
        let Some(connection) = state.background_tasks.remove(source_key) else {
            return false;
        };
        connection.tasks.abort();
        true
    }

    /// 在接收方发出最后一批排队事件之后，停止由录制持有的连接。待处理的连接槽位
    /// 也会被移除，因此在途的元数据请求无法在录制结束后再安装自己。
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    pub(crate) async fn finish_recording_source(&self, source_key: &str) -> bool {
        let background = self
            .inner
            .lock()
            .ok()
            .and_then(|mut state| state.background_tasks.remove(source_key));
        if let Some(connection) = background {
            connection.tasks.stop_and_flush().await;
            return true;
        }

        let control = self.inner.lock().ok().and_then(|state| {
            (state.active_source_key.as_deref() == Some(source_key))
                .then(|| state.active_tasks.batch_control.clone())
                .flatten()
        });
        let flushed = if let Some(control) = control {
            request_batch_flush(control).await
        } else {
            false
        };

        // 在活动 flush 进行期间，页面可能已经分离。
        let background = self
            .inner
            .lock()
            .ok()
            .and_then(|mut state| state.background_tasks.remove(source_key));
        if let Some(connection) = background {
            connection.tasks.stop_and_flush().await;
            return true;
        }
        flushed
    }

    pub fn disconnect(&self) {
        if let Ok(mut state) = self.inner.lock() {
            state.generation = state.generation.saturating_add(1);
            Self::clear_active(&mut state);
            for (_, connection) in state.background_tasks.drain() {
                connection.tasks.abort();
            }
        }
    }

    /// 只有请求仍然是最新时才安装任务。若在其元数据加载期间已被另一个房间取代，
    /// 则返回 false 并中止该任务。
    fn set_tasks_if_current(
        &self,
        generation: u64,
        connection_task: JoinHandle<()>,
        batch_task: JoinHandle<()>,
        batch_control: mpsc::UnboundedSender<DanmakuBatchControl>,
    ) -> bool {
        let Ok(mut state) = self.inner.lock() else {
            connection_task.abort();
            batch_task.abort();
            return false;
        };
        let tasks = DanmakuTasks {
            connection_handle: Some(connection_task),
            batch_handle: Some(batch_task),
            batch_control: Some(batch_control),
        };
        if state.generation == generation && state.active_source_key.is_some() {
            Self::abort_active_tasks(&mut state);
            state.active_tasks = tasks;
            return true;
        }
        if let Some(connection) = state
            .background_tasks
            .values_mut()
            .find(|connection| connection.generation == generation)
        {
            std::mem::replace(&mut connection.tasks, tasks).abort();
            return true;
        }
        tasks.abort();
        false
    }
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
async fn request_batch_flush(control: mpsc::UnboundedSender<DanmakuBatchControl>) -> bool {
    let (ack_tx, ack_rx) = oneshot::channel();
    if control.send(DanmakuBatchControl::Flush(ack_tx)).is_err() {
        return false;
    }
    time::timeout(DANMAKU_FINAL_FLUSH_TIMEOUT, ack_rx)
        .await
        .is_ok()
}

#[allow(clippy::too_many_arguments)]
fn spawn_loop<F, Fut>(
    app: AppHandle,
    manager: &DanmakuManager,
    generation: u64,
    site: &'static str,
    source_key: String,
    identity: SelfDanmakuIdentity,
    notice: Option<String>,
    fut: F,
) where
    F: FnOnce(DanmakuEventSender) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = AppResult<()>> + Send + 'static,
{
    let (event_tx, event_rx) = mpsc::channel(DANMAKU_EVENT_CHANNEL_CAPACITY);
    let (batch_control_tx, batch_control_rx) = mpsc::unbounded_channel();
    let batch_task = tauri::async_runtime::spawn(dispatch_batches(
        app.clone(),
        generation,
        source_key,
        event_rx,
        batch_control_rx,
    ));
    // 在其 generation 被安装之前不要让任务开始运行。没有这道闸门，
    // `spawn` 与 manager 注册之间的极短窗口内发生的路由切换，
    // 仍可能发出过期房间的第一个事件。
    let (start_tx, start_rx) = tokio::sync::oneshot::channel::<()>();
    let sender = DanmakuEventSender::new(event_tx, identity);
    let error_sender = sender.clone();
    let connection_task = tauri::async_runtime::spawn(async move {
        if start_rx.await.is_err() {
            return;
        }
        // 账号级通知（例如"Cookie 已过期，进入匿名模式"）是新房间最先看到的内容，
        // 早于任何来自网络的聊天消息。
        if let Some(content) = notice {
            emit_event(
                &sender,
                DanmakuEvent {
                    kind: crate::models::live::DanmakuKind::System,
                    user: "system".into(),
                    is_self: false,
                    user_id: None,
                    content,
                    color: None,
                    spans: None,
                    super_chat: None,
                    ts: chrono::Utc::now().timestamp_millis(),
                },
            );
        }
        if let Err(e) = fut(sender).await {
            tracing::warn!("{site} danmaku ended: {e}");
            emit_event(
                &error_sender,
                DanmakuEvent {
                    kind: crate::models::live::DanmakuKind::System,
                    user: "system".into(),
                    is_self: false,
                    user_id: None,
                    content: format!("弹幕连接断开: {e}"),
                    color: None,
                    spans: None,
                    super_chat: None,
                    ts: chrono::Utc::now().timestamp_millis(),
                },
            );
        }
    });
    if manager.set_tasks_if_current(generation, connection_task, batch_task, batch_control_tx) {
        let _ = start_tx.send(());
    }
}

async fn dispatch_batches(
    app: AppHandle,
    generation: u64,
    source_key: String,
    mut receiver: mpsc::Receiver<DanmakuEvent>,
    mut control: mpsc::UnboundedReceiver<DanmakuBatchControl>,
) {
    let mut ticker = time::interval(DANMAKU_BATCH_INTERVAL);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    // `interval` 按设计会立即触发一次。这里先等满一个周期再首次投递，
    // 使同一个 websocket 帧中的多个事件也能被合并。
    ticker.tick().await;

    let mut batch = Vec::with_capacity(DANMAKU_BATCH_MAX_EVENTS);
    loop {
        tokio::select! {
            event = receiver.recv() => match event {
                Some(event) => {
                    // 即使遇到极端突发也保持 20fps 的上限。
                    // 多出的聊天会被刻意丢弃，
                    // 而不是造成巨大的序列化／DOM 负担。
                    if batch.len() < DANMAKU_BATCH_MAX_EVENTS {
                        batch.push(event);
                    }
                }
                None => {
                    emit_batch(&app, generation, &source_key, &mut batch);
                    return;
                }
            },
            _ = ticker.tick() => emit_batch(&app, generation, &source_key, &mut batch),
            command = control.recv() => match command {
                Some(DanmakuBatchControl::Flush(ack)) => {
                    drain_ready_events(&mut receiver, &mut batch);
                    emit_batch(&app, generation, &source_key, &mut batch);
                    let _ = ack.send(());
                }
                Some(DanmakuBatchControl::StopAndFlush) | None => {
                    drain_ready_events(&mut receiver, &mut batch);
                    emit_batch(&app, generation, &source_key, &mut batch);
                    return;
                }
            },
        }
    }
}

fn drain_ready_events(receiver: &mut mpsc::Receiver<DanmakuEvent>, batch: &mut Vec<DanmakuEvent>) {
    while let Ok(event) = receiver.try_recv() {
        if batch.len() < DANMAKU_BATCH_MAX_EVENTS {
            batch.push(event);
        }
    }
}

// `source_key` 只服务桌面端录制采集路径，因此移动端构建把它条件编译掉，
// 而不是从共享签名中删掉这个参数。
#[cfg_attr(
    not(any(target_os = "windows", target_os = "linux", target_os = "macos")),
    expect(unused_variables)
)]
fn emit_batch(app: &AppHandle, generation: u64, source_key: &str, batch: &mut Vec<DanmakuEvent>) {
    if batch.is_empty() {
        return;
    }
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    if let Some(state) = app.try_state::<crate::state::AppState>() {
        state.recording.capture_danmaku(source_key, batch);
    }
    // 保留策略与渲染策略由前端负责。这个轻量信封既保留了连接围栏，
    // 又携带本次 tick 的所有事件，因此普通聊天、Super Chat 和悬浮层监听器
    // 各自只处理一次原生回调，而不是每条消息一次回调。
    let _ = app.emit(
        "danmaku-batch",
        DanmakuBatch {
            connection_epoch: generation,
            events: &*batch,
        },
    );
    batch.clear();
}

pub(crate) struct DanmakuConnectRequest<'a> {
    pub(crate) generation: u64,
    pub(crate) site_id: SiteId,
    pub(crate) room_id: &'a str,
    pub(crate) detail_raw: &'a serde_json::Value,
    pub(crate) cookie: &'a str,
    pub(crate) identity_cookie: &'a str,
    pub(crate) proxy: Option<&'a str>,
    pub(crate) notice: Option<String>,
}

pub async fn connect(
    app: AppHandle,
    manager: &DanmakuManager,
    request: DanmakuConnectRequest<'_>,
) -> AppResult<()> {
    let DanmakuConnectRequest {
        generation,
        site_id,
        room_id,
        detail_raw,
        cookie,
        identity_cookie,
        proxy,
        notice,
    } = request;
    if !manager.accepts_connection_generation(generation) {
        return Ok(());
    }

    let identity = SelfDanmakuIdentity::from_cookie(&site_id, identity_cookie);
    let source_key = format!("live:{}:{}", site_id.as_str(), room_id.trim());

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
                source_key.clone(),
                identity,
                notice,
                move |events| bilibili::run_loop(events, args),
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
                source_key.clone(),
                identity,
                notice,
                move |events| douyu::run_loop(events, args),
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
                source_key.clone(),
                identity,
                notice,
                move |events| huya::run_loop(events, args),
            );
            Ok(())
        }
        SiteId::Twitch => {
            let args = twitch::args_from_raw(room_id, detail_raw)?;
            let proxy = proxy.map(str::to_owned);
            spawn_loop(
                app.clone(),
                manager,
                generation,
                "twitch",
                source_key.clone(),
                identity,
                notice,
                move |events| twitch::run_loop(events, args, proxy),
            );
            Ok(())
        }
        SiteId::Douyin => {
            // 本地 MSSDK 签名是 CPU 密集的 JS 求值；通过在其之后再检查 generation，
            // 把它从房间切换的关键路径上移开。
            let args = douyin::build_connection(room_id, detail_raw, cookie)?;
            if !manager.accepts_connection_generation(generation) {
                return Ok(());
            }
            spawn_loop(
                app.clone(),
                manager,
                generation,
                "douyin",
                source_key,
                identity,
                notice,
                move |events| douyin::run_loop(events, args),
            );
            Ok(())
        }
    }
}

pub fn emit_event(sender: &DanmakuEventSender, event: DanmakuEvent) {
    sender.send(event);
}

#[cfg(test)]
mod tests {
    use super::{
        DanmakuBatch, DanmakuBatchControl, DanmakuManager, DanmakuTasks, SelfDanmakuIdentity,
    };
    use crate::models::live::{DanmakuEvent, DanmakuKind};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::sync::mpsc;

    #[test]
    fn newer_connection_epochs_fence_stale_connects_and_cleanups() {
        let manager = DanmakuManager::new();

        assert!(manager.begin_connect(100, "live:bilibili:100".into(), false));
        assert!(manager.begin_connect(101, "live:bilibili:101".into(), false));
        assert!(!manager.begin_connect(100, "live:bilibili:100".into(), false));
        assert!(manager.is_current(101));

        // 来自旧房间的延迟清理必须让更新的房间继续存活。
        assert!(!manager.disconnect_for_generation(100));
        assert!(manager.is_current(101));

        assert!(manager.disconnect_for_generation(102));
        assert!(manager.is_current(102));

        // 前端会先使用较低的 stop 围栏，随后使用更高的 connect epoch。
        // 如果 stop 的 IPC 到达较晚，它不能拆掉已经占据 manager 的
        // 更新连接。
        assert!(manager.begin_connect(103, "live:bilibili:103".into(), false));
        assert!(!manager.disconnect_for_generation(102));
        assert!(manager.is_current(103));
    }

    #[tokio::test]
    async fn detached_recording_connection_survives_a_new_room_until_released() {
        let manager = DanmakuManager::new();
        let source = "live:bilibili:100";

        assert!(manager.begin_connect(100, source.into(), false));
        let connection = tauri::async_runtime::spawn(std::future::pending::<()>());
        let batch = tauri::async_runtime::spawn(std::future::pending::<()>());
        let (control, _receiver) = mpsc::unbounded_channel();
        assert!(manager.set_tasks_if_current(100, connection, batch, control));
        assert!(manager.detach_for_generation(101));
        assert!(manager.begin_connect(102, "live:huya:200".into(), false));
        assert!(
            manager
                .inner
                .lock()
                .unwrap()
                .background_tasks
                .contains_key(source)
        );

        assert!(manager.disconnect_background_for_source(source));
        assert!(!manager.disconnect_background_for_source(source));
        assert!(manager.is_current(102));

        // 替换性的 connect 可能早于旧页面的清理 IPC 到达。
        // 当录制仍持有旧房间时，它必须原子地保留旧房间。
        let connection = tauri::async_runtime::spawn(std::future::pending::<()>());
        let batch = tauri::async_runtime::spawn(std::future::pending::<()>());
        let (control, _receiver) = mpsc::unbounded_channel();
        assert!(manager.set_tasks_if_current(102, connection, batch, control));
        assert!(manager.begin_connect(103, "live:douyu:300".into(), true));
        assert!(
            manager
                .inner
                .lock()
                .unwrap()
                .background_tasks
                .contains_key("live:huya:200")
        );
        assert!(manager.disconnect_background_for_source("live:huya:200"));
        manager.disconnect();
    }

    #[tokio::test]
    async fn pending_connect_installs_into_background_after_route_detaches() {
        let manager = DanmakuManager::new();
        let source = "live:bilibili:pending";

        assert!(manager.begin_connect(200, source.into(), false));
        assert!(manager.detach_for_generation(201));
        assert!(manager.accepts_connection_generation(200));
        {
            let state = manager.inner.lock().unwrap();
            let pending = state.background_tasks.get(source).unwrap();
            assert_eq!(pending.generation, 200);
            assert!(pending.tasks.connection_handle.is_none());
        }

        let connection = tauri::async_runtime::spawn(std::future::pending::<()>());
        let batch = tauri::async_runtime::spawn(std::future::pending::<()>());
        let (control, _receiver) = mpsc::unbounded_channel();
        assert!(manager.set_tasks_if_current(200, connection, batch, control));
        assert!(
            manager
                .inner
                .lock()
                .unwrap()
                .background_tasks
                .get(source)
                .unwrap()
                .tasks
                .connection_handle
                .is_some()
        );
        assert!(manager.disconnect_background_for_source(source));
    }

    #[tokio::test]
    async fn graceful_background_stop_requests_final_batch_flush() {
        let flushed = Arc::new(AtomicBool::new(false));
        let batch_flushed = flushed.clone();
        let (control, mut commands) = mpsc::unbounded_channel();
        let batch = tauri::async_runtime::spawn(async move {
            if matches!(
                commands.recv().await,
                Some(DanmakuBatchControl::StopAndFlush)
            ) {
                batch_flushed.store(true, Ordering::Release);
            }
        });
        let connection = tauri::async_runtime::spawn(std::future::pending::<()>());
        let tasks = DanmakuTasks {
            connection_handle: Some(connection),
            batch_handle: Some(batch),
            batch_control: Some(control),
        };

        tasks.stop_and_flush().await;
        assert!(flushed.load(Ordering::Acquire));
    }

    #[test]
    fn batch_payload_keeps_the_frontend_transport_contract() {
        let events = [DanmakuEvent {
            kind: DanmakuKind::Chat,
            user: "viewer".into(),
            is_self: false,
            user_id: Some("42".into()),
            content: "hello".into(),
            color: None,
            spans: None,
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
        assert_eq!(value["events"][0]["is_self"], false);
        assert!(value["events"][0].get("user_id").is_none());
    }

    #[test]
    fn cookie_identity_prefers_platform_user_id_and_keeps_name_as_a_fallback() {
        let identity = SelfDanmakuIdentity::from_cookie(
            &crate::models::live::SiteId::Douyu,
            "acf_uid=42; acf_username=%E5%B0%8F%E6%98%8E",
        );
        let mut event = DanmakuEvent {
            kind: DanmakuKind::Chat,
            user: "小明".into(),
            is_self: false,
            user_id: Some("42".into()),
            content: "hello".into(),
            color: None,
            spans: None,
            super_chat: None,
            ts: 1,
        };
        identity.mark(&mut event);
        assert!(event.is_self);

        // 同名但权威 UID 冲突的事件属于另一位观众，而不是本地账号。
        event.user_id = Some("99".into());
        identity.mark(&mut event);
        assert!(!event.is_self);

        // 部分中继负载会省略 uid，因此在那种特定情况下，
        // 解码出的 Cookie 用户名是刻意保留的安全兜底。
        event.user_id = None;
        identity.mark(&mut event);
        assert!(event.is_self);
    }
}
