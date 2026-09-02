//! 抖音直播弹幕传输。
//!
//! 抖音的 Web IM 接口要求一个短时效的带签名 WSS URL。rLive 在本地构造该 URL：
//! 房间元数据 + 匿名用户 id，经 X-Bogus 算法（纯 Rust）生成签名，然后建立采用
//! gzip / protobuf 分帧、带心跳与 ACK 的直连 WebSocket。拨号会在多个 webcast
//! 边缘主机之间轮换，读循环则按状态感知的指数退避重连。

use std::collections::HashMap;
use std::io::Read;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use flate2::read::GzDecoder;
use futures_util::{SinkExt, StreamExt};
use reqwest::Url;
use tokio::time;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        Error as WsError, Message,
        client::IntoClientRequest,
        http::{HeaderName, HeaderValue},
    },
};

use crate::danmu_rs::douyin_sign;
use crate::danmu_rs::reconnect::{Decision, DisconnectReason, ReconnectPolicy};
use crate::danmu_rs::{DanmakuEventSender, emit_event, emit_system};
use crate::error::{AppError, AppResult};
use crate::models::live::{DanmakuEvent, DanmakuKind};
use crate::sites::douyin::DEFAULT_USER_AGENT;

const DEFAULT_HEARTBEAT_MS: u64 = 10_000;
const MAX_DECOMPRESSED_FRAME_BYTES: u64 = 8 * 1024 * 1024;
const MAX_EVENT_TEXT_CHARS: usize = 500;
const MAX_USER_NAME_CHARS: usize = 128;
/// 这是一个包含 protobuf 字段 7 = "hb" 的合法 `PushFrame`。
const HEARTBEAT: &[u8] = &[0x3a, 0x02, b'h', b'b'];
/// 单个边缘主机 WSS 握手在轮换前的最长等待时间。
const CONNECT_TIMEOUT_SECS: u64 = 12;

/// 抖音 webcast 推送边缘节点，按优先级排列。第一个主机对应 Web 客户端的
/// 主用节点；其余作为主用节点不可达或被限流时的轮换候选。
const DOUYIN_WS_HOSTS: &[&str] = &[
    "webcast3-ws-web-lq.douyin.com",
    "webcast5-ws-web-lf.douyin.com",
    "webcast5-ws-web-hl.douyin.com",
    "webcast3-ws-web-hl.douyin.com",
    "webcast3-ws-web-lf.douyin.com",
];

/// 交给共享策略的分类重连上限。握手被以 429/403 拒绝意味着该边缘节点正在限流
/// 本客户端，因此要显著加大退避，而不是反复冲击同一个出口 IP；
/// 504 则提示网关的偶发问题，通常恢复更快。
const RECONNECT_BACKOFF_GATEWAY_FLOOR_SECS: u64 = 10;
const RECONNECT_BACKOFF_GATEWAY_MAX_SECS: u64 = 120;
const RECONNECT_BACKOFF_BLOCKED_FLOOR_SECS: u64 = 60;
const RECONNECT_BACKOFF_BLOCKED_MAX_SECS: u64 = 300;

#[derive(Debug, Clone)]
pub struct DouyinDanmakuArgs {
    /// WSS query string 使用的内部（数字）房间 id。
    pub room_id: String,
    /// 绑定到签名 URL 的匿名 Web uid。
    pub user_unique_id: String,
    /// 短时效的 X-Bogus WSS 签名。
    pub signature: String,
    /// 浏览器风格的 `internal_ext` query 取值（参见 [`build_internal_ext`]）。
    pub internal_ext: String,
    pub headers: HashMap<String, String>,
    pub heartbeat_interval: Duration,
}

fn douyin_ws_hosts() -> Vec<String> {
    DOUYIN_WS_HOSTS
        .iter()
        .map(|host| (*host).to_string())
        .collect()
}

/// 把房间元数据解析为一次短时效的带签名 WSS 连接。
///
/// 流程为：内部房间 id + 匿名用户 id → 本地 X-Bogus 签名 →
/// WSS query string，然后为直连 WebSocket 准备 Cookie / Origin 请求头。
/// 边缘主机由 [`run_loop`] 在每次拨号时选择，
/// 因此签名与 `internal_ext` 在这里计算一次并在各主机间共用。
pub fn build_connection(
    room_id: &str,
    raw: &serde_json::Value,
    cookie: &str,
) -> AppResult<DouyinDanmakuArgs> {
    let actual_room_id = numeric_field(raw.get("room_id")).unwrap_or_else(|| room_id.to_string());
    validate_numeric_id(&actual_room_id, "房间号")?;
    // 优先使用从 SSR 房间页捕获的会话 web id；
    // 本地生成的匿名 id 只是兜底。
    let user_unique_id =
        web_id_field(raw.get("user_unique_id")).unwrap_or_else(generate_user_unique_id);
    let signature = douyin_sign::get_signature(&actual_room_id, &user_unique_id)?;
    let ts_ms = now_ms();
    let internal_ext = build_internal_ext(&actual_room_id, &user_unique_id, ts_ms);

    let mut headers = HashMap::new();
    headers.insert("User-Agent".into(), DEFAULT_USER_AGENT.into());
    headers.insert("Origin".into(), "https://live.douyin.com".into());
    let cookie = cookie.trim();
    if !cookie.is_empty() {
        headers.insert("Cookie".into(), cookie.to_string());
    }

    Ok(DouyinDanmakuArgs {
        room_id: actual_room_id,
        user_unique_id,
        signature,
        internal_ext,
        headers,
        heartbeat_interval: Duration::from_millis(DEFAULT_HEARTBEAT_MS),
    })
}

fn build_wss_url(host: &str, args: &DouyinDanmakuArgs) -> AppResult<String> {
    let ts_ms = now_ms();
    let browser_version = DEFAULT_USER_AGENT
        .strip_prefix("Mozilla/")
        .unwrap_or(DEFAULT_USER_AGENT);

    let mut url = Url::parse(&format!("wss://{host}/webcast/im/push/v2/")).map_err(|_| {
        AppError::new("douyin_wss_build_failed", "抖音弹幕连接地址构建失败").with_site("douyin")
    })?;
    {
        let mut query = url.query_pairs_mut();
        query.clear();
        query.append_pair("app_name", "douyin_web");
        query.append_pair("version_code", "180800");
        query.append_pair("webcast_sdk_version", "1.3.0");
        query.append_pair("update_version_code", "1.3.0");
        query.append_pair("compress", "gzip");
        query.append_pair("cursor", &format!("h-1_t-{ts_ms}_r-1_d-1_u-1"));
        query.append_pair("host", "https://live.douyin.com");
        query.append_pair("aid", "6383");
        query.append_pair("live_id", "1");
        query.append_pair("did_rule", "3");
        query.append_pair("debug", "false");
        query.append_pair("maxCacheMessageNumber", "20");
        query.append_pair("endpoint", "live_pc");
        query.append_pair("support_wrds", "1");
        query.append_pair("im_path", "/webcast/im/fetch/");
        query.append_pair("user_unique_id", &args.user_unique_id);
        query.append_pair("device_platform", "web");
        query.append_pair("cookie_enabled", "true");
        query.append_pair("screen_width", "1920");
        query.append_pair("screen_height", "1080");
        query.append_pair("browser_language", "zh-CN");
        query.append_pair("browser_platform", "Win32");
        query.append_pair("browser_name", "Mozilla");
        query.append_pair("browser_version", browser_version);
        query.append_pair("browser_online", "true");
        query.append_pair("tz_name", "Asia/Shanghai");
        query.append_pair("identity", "audience");
        query.append_pair("room_id", &args.room_id);
        query.append_pair("heartbeatDuration", "0");
        query.append_pair("internal_ext", &args.internal_ext);
        query.append_pair("signature", &args.signature);
    }
    Ok(url.to_string())
}

/// 从 Web 客户端捕获的浏览器风格 `internal_ext`。该值把 WSS 请求绑定到
/// 房间／web id 这一对上，且*不*属于签名的输入，
/// 因此可以在不重新签名的情况下添加。
fn build_internal_ext(room_id: &str, user_unique_id: &str, ts_ms: u64) -> String {
    let first_req_ms = ts_ms.saturating_sub(100);
    format!(
        "internal_src:dim|wss_push_room_id:{room_id}|wss_push_did:{user_unique_id}|first_req_ms:{first_req_ms}|fetch_time:{ts_ms}|seq:1|wss_info:0-{ts_ms}-0-0|wrds_v:7392094459690748497"
    )
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// 把一次失败的握手映射为重连原因。
///
/// 403/429 表示这个出口 IP 被拒绝或被限流，504 是网关的偶发故障；两者都仍可
/// 重试，但节奏要慢得多。401 表示凭据被拒，重试无法解决。
fn connect_failure_reason(failure: ConnectFailure) -> DisconnectReason {
    match failure.http_status {
        Some(401) => DisconnectReason::fatal(format!(
            "{}（登录状态已失效，请重新保存 Cookie）",
            failure.message
        )),
        Some(403 | 429) => DisconnectReason::Throttled {
            message: failure.message,
            floor: Duration::from_secs(RECONNECT_BACKOFF_BLOCKED_FLOOR_SECS),
            max: Duration::from_secs(RECONNECT_BACKOFF_BLOCKED_MAX_SECS),
        },
        Some(504) => DisconnectReason::Throttled {
            message: failure.message,
            floor: Duration::from_secs(RECONNECT_BACKOFF_GATEWAY_FLOOR_SECS),
            max: Duration::from_secs(RECONNECT_BACKOFF_GATEWAY_MAX_SECS),
        },
        _ => DisconnectReason::Transient {
            message: failure.message,
        },
    }
}

/// 匿名的 12 位 Web uid。
fn generate_user_unique_id() -> String {
    let bytes = uuid::Uuid::new_v4().into_bytes();
    let mut value = 0u128;
    for byte in bytes {
        value = (value << 8) | u128::from(byte);
    }
    // 生成 12 位十进制数字，且不会因前导零而缩短。
    format!("{:012}", value % 1_000_000_000_000)
}

fn numeric_field(value: Option<&serde_json::Value>) -> Option<String> {
    let value = value?;
    let number = match value {
        serde_json::Value::String(value) => value.trim().to_string(),
        serde_json::Value::Number(value) => value.to_string(),
        _ => return None,
    };
    (!number.is_empty()).then_some(number)
}

/// SSR 房间页会暴露会话自己的 web id（数字字符串或数字）。
/// 与 [`numeric_field`] 不同，它不要求全是数字，
/// 因为字母数字混合的 id 同样可以参与签名。
///
/// 无法用于签名的 id —— 例如 `s_v_web_id` cookie 值，它过长且带有 `_`/`-`/`%`
/// —— 会在这里被丢弃，使调用方回退到 [`generate_user_unique_id`]。
/// 用它们签名是不可能的（会在带分隔符的签名 stub 中伪造出额外字段），
/// 而让握手失败又会导致该房间完全没有弹幕。
fn web_id_field(value: Option<&serde_json::Value>) -> Option<String> {
    let value = value?;
    let id = match value {
        serde_json::Value::String(value) => value.trim().to_string(),
        serde_json::Value::Number(value) => value.to_string(),
        _ => return None,
    };
    if !douyin_sign::is_valid_web_id(&id) {
        tracing::debug!(
            length = id.len(),
            "抖音会话 web id 无法用于弹幕签名，改用本地匿名标识"
        );
        return None;
    }
    Some(id)
}

fn validate_numeric_id(value: &str, label: &str) -> AppResult<()> {
    if value.is_empty() || value.len() > 32 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(
            AppError::new("douyin_invalid_room", format!("无效的抖音{label}")).with_site("douyin"),
        );
    }
    Ok(())
}

pub async fn run_loop(events: DanmakuEventSender, args: DouyinDanmakuArgs) -> AppResult<()> {
    let mut policy = ReconnectPolicy::with_defaults("douyin");
    loop {
        let reason = run_connection_once(&events, &args).await;
        match policy.on_disconnect(reason) {
            Decision::Retry { delay, notice } => {
                emit_system(&events, notice);
                time::sleep(delay).await;
            }
            Decision::Stop { notice, .. } => {
                emit_system(&events, notice);
                return Ok(());
            }
        }
    }
}

#[derive(Debug)]
struct ConnectFailure {
    /// 边缘节点有应答时，失败 WSS 握手的 HTTP 状态码。
    http_status: Option<u16>,
    message: String,
}

async fn run_connection_once(
    events: &DanmakuEventSender,
    args: &DouyinDanmakuArgs,
) -> DisconnectReason {
    emit_system(events, "正在连接抖音弹幕服务器…");

    let hosts = douyin_ws_hosts();
    let mut last_failure: Option<ConnectFailure> = None;
    let mut connected = None;
    for host in hosts {
        let url = match build_wss_url(&host, args) {
            Ok(url) => url,
            Err(_) => continue,
        };
        let mut request = match url.into_client_request() {
            Ok(request) => request,
            Err(_) => continue,
        };
        for (name, value) in &args.headers {
            let Ok(name) = HeaderName::from_bytes(name.trim().as_bytes()) else {
                continue;
            };
            let Ok(value) = HeaderValue::from_str(value.trim()) else {
                continue;
            };
            request.headers_mut().insert(name, value);
        }

        let outcome = tokio::time::timeout(
            Duration::from_secs(CONNECT_TIMEOUT_SECS),
            connect_async(request),
        )
        .await;
        match outcome {
            Ok(Ok((ws, _))) => {
                connected = Some(ws);
                break;
            }
            Ok(Err(error)) => {
                let failure = connect_failure(&error);
                tracing::warn!(
                    host,
                    http_status = failure.http_status,
                    "douyin danmaku handshake failed: {error}"
                );
                last_failure = Some(failure);
            }
            Err(_) => {
                tracing::warn!(host, "douyin danmaku handshake timed out");
                last_failure = Some(ConnectFailure {
                    http_status: None,
                    message: format!("连接超时（{host}）"),
                });
            }
        }
    }

    let Some(ws) = connected else {
        let failure = last_failure.unwrap_or_else(|| ConnectFailure {
            http_status: None,
            message: "所有弹幕服务器均连接失败".into(),
        });
        return connect_failure_reason(failure);
    };
    tracing::info!(site = "douyin", "danmaku websocket connected");

    let connected_at = Instant::now();
    let (mut write, mut read) = ws.split();
    if write
        .send(Message::Binary(HEARTBEAT.to_vec().into()))
        .await
        .is_err()
    {
        return DisconnectReason::transient("心跳发送失败");
    }

    emit_system(events, "抖音弹幕服务器连接成功");
    let mut heartbeat = time::interval(args.heartbeat_interval);
    // `interval` 会立即触发一次；把那一次 tick 消费掉，
    // 因为上面开场的心跳已经发送过了。
    heartbeat.tick().await;

    let mut msg_count: u64 = 0;
    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                if write.send(Message::Binary(HEARTBEAT.to_vec().into())).await.is_err() {
                    break;
                }
            }
            incoming = read.next() => match incoming {
                Some(Ok(Message::Binary(bytes))) => {
                    match decode_push_frame(&bytes)
                        .and_then(|decoded| {
                            let payload = maybe_gunzip(decoded.payload)?;
                            let ack = decode_response(&payload, &mut |event| {
                                msg_count += 1;
                                emit_event(events, event);
                            })?;
                            Ok((decoded, ack))
                        }) {
                        Ok((decoded, ack)) => {
                            if ack.need_ack {
                                let frame = encode_ack(decoded.log_id, ack.internal_ext.as_bytes());
                                if write.send(Message::Binary(frame.into())).await.is_err() {
                                    break;
                                }
                            }
                        }
                        Err(error) => {
                            tracing::warn!(site = "douyin", "danmaku frame dropped: {error}");
                        }
                    }
                }
                Some(Ok(Message::Ping(payload))) => {
                    let _ = write.send(Message::Pong(payload)).await;
                }
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {}
                Some(Err(_)) => break,
            }
        }
    }
    DisconnectReason::Dropped {
        messages: msg_count,
        connected_for: connected_at.elapsed(),
        // 这个循环退出时不保留传输层原因；策略会退回到其稳定的概要描述。
        detail: None,
    }
}

fn connect_failure(error: &WsError) -> ConnectFailure {
    let http_status = match error {
        WsError::Http(response) => Some(response.status().as_u16()),
        _ => None,
    };
    ConnectFailure {
        http_status,
        message: error.to_string(),
    }
}

#[derive(Debug)]
struct PushFrame<'a> {
    log_id: u64,
    payload: &'a [u8],
}

#[derive(Default)]
struct ResponseAck {
    need_ack: bool,
    internal_ext: String,
}

#[derive(Debug)]
enum ProtoValue<'a> {
    Varint(u64),
    Bytes(&'a [u8]),
    Fixed32,
    Fixed64,
}

struct ProtoReader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> ProtoReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn next_field(&mut self) -> Result<Option<(u32, ProtoValue<'a>)>, &'static str> {
        if self.offset == self.bytes.len() {
            return Ok(None);
        }
        let tag = self.read_varint()?;
        let number = (tag >> 3) as u32;
        if number == 0 {
            return Err("protobuf field number is zero");
        }
        let value = match tag & 0x07 {
            0 => ProtoValue::Varint(self.read_varint()?),
            1 => {
                self.take(8)?;
                ProtoValue::Fixed64
            }
            2 => {
                let len = usize::try_from(self.read_varint()?).map_err(|_| "protobuf length")?;
                ProtoValue::Bytes(self.take(len)?)
            }
            5 => {
                self.take(4)?;
                ProtoValue::Fixed32
            }
            _ => return Err("unsupported protobuf wire type"),
        };
        Ok(Some((number, value)))
    }

    fn read_varint(&mut self) -> Result<u64, &'static str> {
        let mut result = 0u64;
        for shift in (0..64).step_by(7) {
            let byte = *self
                .bytes
                .get(self.offset)
                .ok_or("truncated protobuf varint")?;
            self.offset += 1;
            result |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(result);
            }
            if shift == 63 {
                break;
            }
        }
        Err("protobuf varint overflow")
    }

    fn take(&mut self, len: usize) -> Result<&'a [u8], &'static str> {
        let end = self
            .offset
            .checked_add(len)
            .ok_or("protobuf length overflow")?;
        let value = self
            .bytes
            .get(self.offset..end)
            .ok_or("truncated protobuf field")?;
        self.offset = end;
        Ok(value)
    }
}

fn decode_push_frame(bytes: &[u8]) -> AppResult<PushFrame<'_>> {
    let mut reader = ProtoReader::new(bytes);
    let mut log_id = 0;
    let mut payload = None;
    while let Some((field, value)) = reader.next_field().map_err(proto_error)? {
        match (field, value) {
            (2, ProtoValue::Varint(value)) => log_id = value,
            (8, ProtoValue::Bytes(value)) => payload = Some(value),
            _ => {}
        }
    }
    let payload = payload.ok_or_else(|| {
        AppError::new("douyin_frame_invalid", "抖音弹幕帧缺少内容").with_site("douyin")
    })?;
    Ok(PushFrame { log_id, payload })
}

fn maybe_gunzip(payload: &[u8]) -> AppResult<Vec<u8>> {
    if !payload.starts_with(&[0x1f, 0x8b]) {
        return Ok(payload.to_vec());
    }
    let decoder = GzDecoder::new(payload);
    let mut limited = decoder.take(MAX_DECOMPRESSED_FRAME_BYTES + 1);
    let mut out = Vec::new();
    limited.read_to_end(&mut out).map_err(|error| {
        AppError::new(
            "douyin_payload_decompress_failed",
            format!("抖音弹幕内容解压失败：{error}"),
        )
        .with_site("douyin")
    })?;
    if out.len() as u64 > MAX_DECOMPRESSED_FRAME_BYTES {
        return Err(
            AppError::new("douyin_payload_too_large", "抖音弹幕帧过大，已拒绝处理")
                .with_site("douyin"),
        );
    }
    Ok(out)
}

fn decode_response(payload: &[u8], emit: &mut impl FnMut(DanmakuEvent)) -> AppResult<ResponseAck> {
    let mut reader = ProtoReader::new(payload);
    let mut ack = ResponseAck::default();
    while let Some((field, value)) = reader.next_field().map_err(proto_error)? {
        match (field, value) {
            (1, ProtoValue::Bytes(message)) => {
                if let Some(event) = decode_message(message)? {
                    emit(event);
                }
            }
            (5, ProtoValue::Bytes(value)) => ack.internal_ext = bounded_text(value, 4_096),
            (9, ProtoValue::Varint(value)) => ack.need_ack = value != 0,
            _ => {}
        }
    }
    Ok(ack)
}

fn decode_message(bytes: &[u8]) -> AppResult<Option<DanmakuEvent>> {
    let mut reader = ProtoReader::new(bytes);
    let mut method = String::new();
    let mut payload = None;
    while let Some((field, value)) = reader.next_field().map_err(proto_error)? {
        match (field, value) {
            (1, ProtoValue::Bytes(value)) => method = bounded_text(value, 96),
            (2, ProtoValue::Bytes(value)) => payload = Some(value),
            _ => {}
        }
    }
    let Some(payload) = payload else {
        return Ok(None);
    };
    let event = match method.as_str() {
        "WebcastChatMessage" => decode_chat(payload),
        "WebcastEmojiChatMessage" => decode_emoji_chat(payload),
        "WebcastGiftMessage" => decode_gift(payload),
        "WebcastLikeMessage" => decode_like(payload),
        "WebcastMemberMessage" => decode_member(payload),
        "WebcastSocialMessage" => decode_social(payload),
        _ => Ok(None),
    }?;
    Ok(event)
}

fn decode_chat(bytes: &[u8]) -> AppResult<Option<DanmakuEvent>> {
    let mut reader = ProtoReader::new(bytes);
    let mut user = String::new();
    let mut content = String::new();
    while let Some((field, value)) = reader.next_field().map_err(proto_error)? {
        match (field, value) {
            (2, ProtoValue::Bytes(value)) => user = decode_user_name(value)?,
            (3, ProtoValue::Bytes(value)) => content = bounded_text(value, MAX_EVENT_TEXT_CHARS),
            _ => {}
        }
    }
    event_if_content(DanmakuKind::Chat, user, content, None)
}

fn decode_emoji_chat(bytes: &[u8]) -> AppResult<Option<DanmakuEvent>> {
    let mut reader = ProtoReader::new(bytes);
    let mut user = String::new();
    let mut content = String::new();
    while let Some((field, value)) = reader.next_field().map_err(proto_error)? {
        match (field, value) {
            (2, ProtoValue::Bytes(value)) => user = decode_user_name(value)?,
            (5, ProtoValue::Bytes(value)) => content = bounded_text(value, MAX_EVENT_TEXT_CHARS),
            _ => {}
        }
    }
    event_if_content(DanmakuKind::Chat, user, content, None)
}

fn decode_gift(bytes: &[u8]) -> AppResult<Option<DanmakuEvent>> {
    let mut reader = ProtoReader::new(bytes);
    let mut user = String::new();
    let mut gift = String::new();
    let mut count = 0u64;
    while let Some((field, value)) = reader.next_field().map_err(proto_error)? {
        match (field, value) {
            (6 | 29, ProtoValue::Varint(value)) => count = count.max(value),
            (7, ProtoValue::Bytes(value)) => user = decode_user_name(value)?,
            (15, ProtoValue::Bytes(value)) => gift = decode_gift_name(value)?,
            _ => {}
        }
    }
    if gift.is_empty() {
        return Ok(None);
    }
    let count = count.max(1);
    event_if_content(
        DanmakuKind::Gift,
        user,
        format!("赠送 {gift} × {count}"),
        None,
    )
}

fn decode_like(bytes: &[u8]) -> AppResult<Option<DanmakuEvent>> {
    let mut reader = ProtoReader::new(bytes);
    let mut user = String::new();
    let mut count = 0u64;
    while let Some((field, value)) = reader.next_field().map_err(proto_error)? {
        match (field, value) {
            (2, ProtoValue::Varint(value)) => count = value,
            (5, ProtoValue::Bytes(value)) => user = decode_user_name(value)?,
            _ => {}
        }
    }
    if count == 0 {
        return Ok(None);
    }
    event_if_content(
        // 点赞属于平台互动通知而非用户撰写的聊天内容。把它与礼物归为一类，
        // 可让共享的礼物信息设置一致地隐藏这两类高频事件。
        DanmakuKind::Gift,
        user,
        format!("点赞 × {count}"),
        Some("#ff8bab".into()),
    )
}

fn decode_member(bytes: &[u8]) -> AppResult<Option<DanmakuEvent>> {
    let mut reader = ProtoReader::new(bytes);
    let mut user = String::new();
    while let Some((field, value)) = reader.next_field().map_err(proto_error)? {
        if let (2, ProtoValue::Bytes(value)) = (field, value) {
            user = decode_user_name(value)?;
        }
    }
    event_if_content(
        DanmakuKind::Enter,
        user.clone(),
        if !user.is_empty() {
            format!("{user} 进入直播间")
        } else {
            Default::default()
        },
        None,
    )
}

fn decode_social(bytes: &[u8]) -> AppResult<Option<DanmakuEvent>> {
    let mut reader = ProtoReader::new(bytes);
    let mut user = String::new();
    let mut action = 0u64;
    while let Some((field, value)) = reader.next_field().map_err(proto_error)? {
        match (field, value) {
            (2, ProtoValue::Bytes(value)) => user = decode_user_name(value)?,
            (4, ProtoValue::Varint(value)) => action = value,
            _ => {}
        }
    }
    let content = match action {
        1 => format!("{user} 关注了主播"),
        3 => format!("{user} 分享了直播间"),
        _ => String::new(),
    };
    event_if_content(DanmakuKind::Social, user, content, None)
}

fn decode_user_name(bytes: &[u8]) -> AppResult<String> {
    let mut reader = ProtoReader::new(bytes);
    let mut nickname = String::new();
    while let Some((field, value)) = reader.next_field().map_err(proto_error)? {
        if let (3, ProtoValue::Bytes(value)) = (field, value) {
            nickname = bounded_text(value, MAX_USER_NAME_CHARS);
        }
    }
    Ok(nickname)
}

fn decode_gift_name(bytes: &[u8]) -> AppResult<String> {
    let mut reader = ProtoReader::new(bytes);
    let mut name = String::new();
    while let Some((field, value)) = reader.next_field().map_err(proto_error)? {
        if let (16, ProtoValue::Bytes(value)) = (field, value) {
            name = bounded_text(value, MAX_EVENT_TEXT_CHARS);
        }
    }
    Ok(name)
}

fn event_if_content(
    kind: DanmakuKind,
    user: String,
    content: String,
    color: Option<String>,
) -> AppResult<Option<DanmakuEvent>> {
    let content = content.trim().to_string();
    if content.is_empty() {
        return Ok(None);
    }
    Ok(Some(DanmakuEvent {
        kind,
        user: if user.trim().is_empty() {
            "用户".into()
        } else {
            user
        },
        is_self: false,
        user_id: None,
        content,
        color,
        spans: None,
        super_chat: None,
        ts: chrono::Utc::now().timestamp_millis(),
    }))
}

fn bounded_text(bytes: &[u8], max_chars: usize) -> String {
    String::from_utf8_lossy(bytes)
        .trim()
        .chars()
        .take(max_chars)
        .collect()
}

fn proto_error(reason: &'static str) -> AppError {
    AppError::new(
        "douyin_protocol_invalid",
        format!("抖音弹幕协议数据无效：{reason}"),
    )
    .with_site("douyin")
}

fn put_varint(value: u64, out: &mut Vec<u8>) {
    let mut value = value;
    while value >= 0x80 {
        out.push((value as u8 & 0x7f) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

fn put_bytes(field: u32, value: &[u8], out: &mut Vec<u8>) {
    put_varint(u64::from(field << 3 | 2), out);
    put_varint(value.len() as u64, out);
    out.extend_from_slice(value);
}

fn put_uint(field: u32, value: u64, out: &mut Vec<u8>) {
    put_varint(u64::from(field << 3), out);
    put_varint(value, out);
}

fn encode_ack(log_id: u64, internal_ext: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(internal_ext.len() + 20);
    if log_id != 0 {
        put_uint(2, log_id, &mut out);
    }
    put_bytes(7, b"ack", &mut out);
    put_bytes(8, internal_ext, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{Compression, write::GzEncoder};

    /// 直播 WSS 握手冒烟：X-Bogus 签名必须被 webcast 边缘接受。
    /// 覆盖纯 Rust 签名链路：匿名 `ttwid` 引导 → feed 开播房间 →
    /// [`build_connection`] 签名 → 握手 → 收到首帧。
    #[tokio::test]
    #[ignore = "live network smoke — run with --ignored"]
    async fn live_wss_signature_smoke() {
        let client = crate::http_client::default_client();

        // 1) 匿名 ttwid 引导（与 DouyinSite::ensure_web_session 同源）。
        let head = client
            .head("https://live.douyin.com/")
            .header("user-agent", DEFAULT_USER_AGENT)
            .send()
            .await
            .expect("live home head");
        let ttwid = head
            .headers()
            .get_all("set-cookie")
            .iter()
            .filter_map(|value| value.to_str().ok())
            .find_map(|value| {
                value
                    .strip_prefix("ttwid=")
                    .map(|rest| rest.split(';').next().unwrap_or("").to_string())
            })
            .filter(|value| !value.is_empty())
            .expect("ttwid cookie");

        // 2) 从首页信息流取一个开播房间。
        let feed = client
            .get(
                "https://live.douyin.com/webcast/feed/?aid=6383&app_name=douyin_web&need_map=1&is_draw=1&inner_from_drawer=0&enter_source=web_homepage_hot_web_live_card&source_key=web_homepage_hot_web_live_card",
            )
            .header("user-agent", DEFAULT_USER_AGENT)
            .header("referer", "https://live.douyin.com/hot_live")
            .header("cookie", format!("ttwid={ttwid}"))
            .send()
            .await
            .expect("feed request")
            .json::<serde_json::Value>()
            .await
            .expect("feed json");
        let room_id = feed
            .pointer("/data/0/data/id_str")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                feed.pointer("/data/0/data/id")
                    .and_then(serde_json::Value::as_i64)
                    .map(|id| id.to_string())
            })
            .filter(|id| id.bytes().all(|byte| byte.is_ascii_digit()))
            .expect("live room in feed");

        // 3) 纯 Rust X-Bogus 签名 + WSS 握手。
        let args = build_connection(&room_id, &serde_json::json!({ "room_id": room_id }), "")
            .expect("connection args");
        let url = build_wss_url(DOUYIN_WS_HOSTS[0], &args).expect("wss url");
        let mut request = url.into_client_request().expect("request");
        for (name, value) in &args.headers {
            let name = HeaderName::from_bytes(name.trim().as_bytes()).expect("header name");
            let value = HeaderValue::from_str(value.trim()).expect("header value");
            request.headers_mut().insert(name, value);
        }
        request.headers_mut().insert(
            HeaderName::from_bytes(b"Cookie").unwrap(),
            HeaderValue::from_str(&format!("ttwid={ttwid}")).expect("cookie value"),
        );

        let (ws, _response) = tokio::time::timeout(
            Duration::from_secs(CONNECT_TIMEOUT_SECS),
            connect_async(request),
        )
        .await
        .expect("handshake timeout")
        .expect("wss handshake with X-Bogus signature");

        // 4) 发送心跳后等待首帧，确认连接承载真实推送。
        let (mut write, mut read) = ws.split();
        write
            .send(Message::Binary(HEARTBEAT.to_vec().into()))
            .await
            .expect("heartbeat");
        let frame = tokio::time::timeout(Duration::from_secs(15), read.next())
            .await
            .expect("first frame timeout")
            .expect("stream open")
            .expect("first frame");
        assert!(!frame.is_empty(), "first frame should carry data");
    }

    fn field_bytes(field: u32, value: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        put_bytes(field, value, &mut out);
        out
    }

    fn field_uint(field: u32, value: u64) -> Vec<u8> {
        let mut out = Vec::new();
        put_uint(field, value, &mut out);
        out
    }

    #[test]
    fn decodes_gzipped_chat_and_ack_metadata() {
        let user = field_bytes(3, "小明".as_bytes());
        let mut chat = field_bytes(2, &user);
        chat.extend(field_bytes(3, "你好，直播间！".as_bytes()));
        let mut message = field_bytes(1, b"WebcastChatMessage");
        message.extend(field_bytes(2, &chat));
        let mut response = field_bytes(1, &message);
        response.extend(field_bytes(5, b"cursor=abc"));
        response.extend(field_uint(9, 1));

        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        std::io::Write::write_all(&mut encoder, &response).unwrap();
        let compressed = encoder.finish().unwrap();
        let mut frame = field_uint(2, 42);
        frame.extend(field_bytes(8, &compressed));

        let decoded = decode_push_frame(&frame).unwrap();
        assert_eq!(decoded.log_id, 42);
        let payload = maybe_gunzip(decoded.payload).unwrap();
        let mut events = Vec::new();
        let ack = decode_response(&payload, &mut |event| events.push(event)).unwrap();
        assert!(ack.need_ack);
        assert_eq!(ack.internal_ext, "cursor=abc");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].user, "小明");
        assert_eq!(events[0].content, "你好，直播间！");

        let ack_bytes = encode_ack(decoded.log_id, ack.internal_ext.as_bytes());
        let ack_frame = decode_push_frame(&ack_bytes).unwrap();
        assert_eq!(ack_frame.log_id, 42);
    }

    #[test]
    fn decodes_gift_and_member_messages() {
        let user = field_bytes(3, "观众".as_bytes());
        let gift = field_bytes(16, "小心心".as_bytes());
        let mut gift_body = field_bytes(7, &user);
        gift_body.extend(field_uint(29, 3));
        gift_body.extend(field_bytes(15, &gift));
        let mut gift_message = field_bytes(1, b"WebcastGiftMessage");
        gift_message.extend(field_bytes(2, &gift_body));

        let member_body = field_bytes(2, &user);
        let mut member_message = field_bytes(1, b"WebcastMemberMessage");
        member_message.extend(field_bytes(2, &member_body));

        let mut response = field_bytes(1, &gift_message);
        response.extend(field_bytes(1, &member_message));
        let mut events = Vec::new();
        decode_response(&response, &mut |event| events.push(event)).unwrap();

        assert_eq!(events.len(), 2);
        assert!(matches!(events[0].kind, DanmakuKind::Gift));
        assert_eq!(events[0].content, "赠送 小心心 × 3");
        assert!(matches!(events[1].kind, DanmakuKind::Enter));
    }

    #[test]
    fn decodes_likes_as_filterable_gift_messages() {
        let user = field_bytes(3, "观众".as_bytes());
        let mut like_body = field_uint(2, 33);
        like_body.extend(field_bytes(5, &user));
        let mut like_message = field_bytes(1, b"WebcastLikeMessage");
        like_message.extend(field_bytes(2, &like_body));

        let mut events = Vec::new();
        decode_response(&field_bytes(1, &like_message), &mut |event| {
            events.push(event)
        })
        .unwrap();

        assert_eq!(events.len(), 1);
        assert!(matches!(events[0].kind, DanmakuKind::Gift));
        assert_eq!(events[0].user, "观众");
        assert_eq!(events[0].content, "点赞 × 33");
    }

    #[test]
    fn decodes_follow_and_share_notices_as_social_messages() {
        let user = field_bytes(3, "阿森纳".as_bytes());
        let mut follow_body = field_bytes(2, &user);
        follow_body.extend(field_uint(4, 1));
        let mut follow_message = field_bytes(1, b"WebcastSocialMessage");
        follow_message.extend(field_bytes(2, &follow_body));

        let mut share_body = field_bytes(2, &user);
        share_body.extend(field_uint(4, 3));
        let mut share_message = field_bytes(1, b"WebcastSocialMessage");
        share_message.extend(field_bytes(2, &share_body));

        let mut response = field_bytes(1, &follow_message);
        response.extend(field_bytes(1, &share_message));
        let mut events = Vec::new();
        decode_response(&response, &mut |event| events.push(event)).unwrap();

        assert_eq!(events.len(), 2);
        assert!(
            events
                .iter()
                .all(|event| matches!(event.kind, DanmakuKind::Social))
        );
        assert_eq!(events[0].content, "阿森纳 关注了主播");
        assert_eq!(events[1].content, "阿森纳 分享了直播间");
    }

    #[test]
    fn builds_signed_connection_and_per_host_wss_url() {
        let raw = serde_json::json!({
            "room_id": "1234567890123456789",
            "web_rid": "522864404974",
        });
        let args = build_connection("522864404974", &raw, "ttwid=fixture").unwrap();
        assert_eq!(args.room_id, "1234567890123456789");
        assert_eq!(args.user_unique_id.len(), 12);
        assert!(
            args.user_unique_id
                .bytes()
                .all(|byte| byte.is_ascii_digit())
        );
        assert!(!args.signature.is_empty());
        assert!(
            args.internal_ext
                .contains("wss_push_room_id:1234567890123456789")
        );
        assert!(args.internal_ext.contains("wss_push_did:"));
        assert_eq!(
            args.headers.get("Cookie").map(String::as_str),
            Some("ttwid=fixture")
        );
        assert_eq!(
            args.headers.get("Origin").map(String::as_str),
            Some("https://live.douyin.com")
        );

        let url =
            Url::parse(&build_wss_url("webcast3-ws-web-lq.douyin.com", &args).unwrap()).unwrap();
        assert_eq!(url.scheme(), "wss");
        assert!(url.as_str().contains("webcast3-ws-web-lq.douyin.com"));
        let pairs: HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(
            pairs.get("room_id").map(String::as_str),
            Some("1234567890123456789")
        );
        assert_eq!(pairs.get("aid").map(String::as_str), Some("6383"));
        assert!(
            pairs
                .get("signature")
                .is_some_and(|value| !value.is_empty())
        );
        assert_eq!(
            pairs.get("internal_ext").map(String::as_str),
            Some(args.internal_ext.as_str())
        );
        assert!(
            pairs
                .get("user_unique_id")
                .is_some_and(|value| value.len() == 12)
        );
    }

    #[test]
    fn build_connection_prefers_the_render_data_web_id() {
        let raw = serde_json::json!({
            "room_id": "1234567890123456789",
            "user_unique_id": "7392091211001140287",
        });
        let args = build_connection("522864404974", &raw, "").unwrap();
        assert_eq!(args.user_unique_id, "7392091211001140287");
        assert!(
            args.internal_ext
                .contains("wss_push_did:7392091211001140287")
        );

        // 没有会话 web id 时，匿名兜底值是 12 位数字。
        let raw = serde_json::json!({ "room_id": "1234567890123456789" });
        let args = build_connection("522864404974", &raw, "").unwrap();
        assert_eq!(args.user_unique_id.len(), 12);
        assert!(
            args.user_unique_id
                .bytes()
                .all(|byte| byte.is_ascii_digit())
        );
    }

    /// 填入抖音 cookie 曾直接导致弹幕不可用：房间页会把会话的 `s_v_web_id`
    /// 作为 `user_unique_id` 带上，而该值无法用于签名，
    /// 于是握手失败并报「无效的抖音用户标识」。
    /// 它必须降级为匿名 id。
    #[test]
    fn build_connection_falls_back_when_the_session_web_id_is_unsignable() {
        let raw = serde_json::json!({
            "room_id": "1234567890123456789",
            "user_unique_id": "verify_m9x0k1a2_HqLpZzXk_8T1c_4Vd2_Wm5NpQrStUvW",
        });
        let args = build_connection("522864404974", &raw, "").expect("connection");
        assert_eq!(args.user_unique_id.len(), 12);
        assert!(
            args.user_unique_id
                .bytes()
                .all(|byte| byte.is_ascii_digit())
        );
        assert!(!args.signature.is_empty());
        assert!(
            args.internal_ext
                .contains(&format!("wss_push_did:{}", args.user_unique_id))
        );
    }

    /// 握手状态决定重试类别，因此凭据被拒时直接停止，
    /// 而不是为边缘节点已经给出的答复
    /// 再花掉五分钟的退避排程。
    #[test]
    fn handshake_status_selects_the_retry_class() {
        let failure = |status: Option<u16>| ConnectFailure {
            http_status: status,
            message: "handshake".into(),
        };

        assert!(matches!(
            connect_failure_reason(failure(Some(401))),
            DisconnectReason::Fatal { .. }
        ));
        for blocked in [403, 429] {
            match connect_failure_reason(failure(Some(blocked))) {
                DisconnectReason::Throttled { floor, max, .. } => {
                    assert_eq!(floor.as_secs(), RECONNECT_BACKOFF_BLOCKED_FLOOR_SECS);
                    assert_eq!(max.as_secs(), RECONNECT_BACKOFF_BLOCKED_MAX_SECS);
                }
                other => panic!("expected throttling for {blocked}, got {other:?}"),
            }
        }
        match connect_failure_reason(failure(Some(504))) {
            DisconnectReason::Throttled { floor, max, .. } => {
                assert_eq!(floor.as_secs(), RECONNECT_BACKOFF_GATEWAY_FLOOR_SECS);
                assert_eq!(max.as_secs(), RECONNECT_BACKOFF_GATEWAY_MAX_SECS);
            }
            other => panic!("expected gateway throttling, got {other:?}"),
        }
        // 无应答的拨号（DNS、TLS、超时）继续按普通节奏重试。
        assert!(matches!(
            connect_failure_reason(failure(None)),
            DisconnectReason::Transient { .. }
        ));
    }

    #[test]
    fn generate_user_unique_id_is_twelve_digits() {
        let uid = generate_user_unique_id();
        assert_eq!(uid.len(), 12);
        assert!(uid.bytes().all(|byte| byte.is_ascii_digit()));
    }
}
