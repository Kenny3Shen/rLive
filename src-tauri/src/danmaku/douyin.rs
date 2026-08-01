//! Douyin live danmaku transport.
//!
//! Douyin's web IM endpoint requires a short-lived, signed WSS URL. rLive
//! builds that URL locally: room metadata + anonymous user id, MSSDK
//! signature via Boa, then a direct WebSocket with gzip / protobuf framing,
//! heartbeat and ACK.

use std::collections::HashMap;
use std::io::Read;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use flate2::read::GzDecoder;
use futures_util::{SinkExt, StreamExt};
use reqwest::{Client, Url};
use tokio::time;
use tokio_tungstenite::{
    connect_async_tls_with_config,
    tungstenite::{
        Message,
        client::IntoClientRequest,
        http::{HeaderName, HeaderValue},
    },
};

use crate::danmaku::douyin_sign;
use crate::danmaku::tls::rustls_connector;
use crate::danmaku::{DanmakuEventSender, emit_event};
use crate::error::{AppError, AppResult};
use crate::models::live::{DanmakuEvent, DanmakuKind};
use crate::sites::douyin::DEFAULT_USER_AGENT;

const DEFAULT_HEARTBEAT_MS: u64 = 10_000;
const MAX_DECOMPRESSED_FRAME_BYTES: u64 = 8 * 1024 * 1024;
const MAX_EVENT_TEXT_CHARS: usize = 500;
const MAX_USER_NAME_CHARS: usize = 128;
/// Web room chat is shorter than app chat; keep a conservative bound.
const MAX_OUTGOING_CHAT_UTF16_UNITS: usize = 50;
const WSS_PUSH_URL: &str = "wss://webcast3-ws-web-lq.douyin.com/webcast/im/push/v2/";
/// Official web live room chat write endpoint (form POST + Cookie).
const SEND_CHAT_URL: &str = "https://live.douyin.com/webcast/room/chat/";
/// This is a valid `PushFrame` containing protobuf field 7 = "hb".
const HEARTBEAT: &[u8] = &[0x3a, 0x02, b'h', b'b'];

#[derive(Debug, Clone)]
pub struct DouyinDanmakuArgs {
    pub wss_url: String,
    pub headers: HashMap<String, String>,
    pub heartbeat_interval: Duration,
}

/// Resolve room metadata into a short-lived signed WSS connection.
///
/// Flow matches Simple Live: internal room id + anonymous user id → local
/// MSSDK signature → WSS query string, then Cookie / Origin headers for the
/// direct WebSocket.
pub fn build_connection(
    room_id: &str,
    raw: &serde_json::Value,
    cookie: &str,
) -> AppResult<DouyinDanmakuArgs> {
    let actual_room_id = numeric_field(raw.get("room_id")).unwrap_or_else(|| room_id.to_string());
    validate_numeric_id(&actual_room_id, "房间号")?;
    let user_unique_id = generate_user_unique_id();
    let signature = douyin_sign::get_signature(&actual_room_id, &user_unique_id)?;
    let wss_url = build_wss_url(&actual_room_id, &user_unique_id, &signature)?;

    let mut headers = HashMap::new();
    headers.insert("User-Agent".into(), DEFAULT_USER_AGENT.into());
    headers.insert("Origin".into(), "https://live.douyin.com".into());
    let cookie = cookie.trim();
    if !cookie.is_empty() {
        headers.insert("Cookie".into(), cookie.to_string());
    }

    Ok(DouyinDanmakuArgs {
        wss_url,
        headers,
        heartbeat_interval: Duration::from_millis(DEFAULT_HEARTBEAT_MS),
    })
}

fn build_wss_url(room_id: &str, user_unique_id: &str, signature: &str) -> AppResult<String> {
    let ts_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let browser_version = DEFAULT_USER_AGENT
        .strip_prefix("Mozilla/")
        .unwrap_or(DEFAULT_USER_AGENT);

    let mut url = Url::parse(WSS_PUSH_URL).map_err(|_| {
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
        query.append_pair("user_unique_id", user_unique_id);
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
        query.append_pair("room_id", room_id);
        query.append_pair("heartbeatDuration", "0");
        query.append_pair("signature", signature);
    }
    Ok(url.to_string())
}

/// Anonymous 12-digit web uid (Simple Live `generateRandomNumber(12)`).
fn generate_user_unique_id() -> String {
    let bytes = uuid::Uuid::new_v4().into_bytes();
    let mut value = 0u128;
    for byte in bytes {
        value = (value << 8) | u128::from(byte);
    }
    // Produce 12 decimal digits without leading-zero collapse.
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

fn validate_numeric_id(value: &str, label: &str) -> AppResult<()> {
    if value.is_empty() || value.len() > 32 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(
            AppError::new("douyin_invalid_room", format!("无效的抖音{label}")).with_site("douyin"),
        );
    }
    Ok(())
}

pub async fn run_loop(events: DanmakuEventSender, args: DouyinDanmakuArgs) -> AppResult<()> {
    let mut request = args.wss_url.clone().into_client_request().map_err(|_| {
        AppError::new("douyin_ws_request_invalid", "抖音弹幕连接地址无效").with_site("douyin")
    })?;
    for (name, value) in args.headers {
        let Ok(name) = HeaderName::from_bytes(name.trim().as_bytes()) else {
            continue;
        };
        let Ok(value) = HeaderValue::from_str(value.trim()) else {
            continue;
        };
        request.headers_mut().insert(name, value);
    }

    emit_system(&events, "正在连接抖音弹幕服务器…");
    let (ws, _) = connect_async_tls_with_config(request, None, false, Some(rustls_connector()?))
        .await
        .map_err(|_| {
            AppError::new(
                "douyin_ws_connect_failed",
                "抖音弹幕服务器连接失败，请稍后重试",
            )
            .with_site("douyin")
            .retryable()
        })?;
    let (mut write, mut read) = ws.split();
    write
        .send(Message::Binary(HEARTBEAT.to_vec().into()))
        .await
        .map_err(|_| {
            AppError::new("douyin_ws_heartbeat_failed", "抖音弹幕心跳发送失败")
                .with_site("douyin")
                .retryable()
        })?;

    emit_system(&events, "抖音弹幕服务器连接成功");
    let mut heartbeat = time::interval(args.heartbeat_interval);
    // `interval` ticks immediately; consume that tick because the opening
    // heartbeat above has already been sent.
    heartbeat.tick().await;

    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                if write.send(Message::Binary(HEARTBEAT.to_vec().into())).await.is_err() {
                    break;
                }
            }
            incoming = read.next() => match incoming {
                Some(Ok(Message::Binary(bytes))) => {
                    let decoded = decode_push_frame(&bytes)?;
                    let payload = maybe_gunzip(decoded.payload)?;
                    let ack = decode_response(&payload, &mut |event| emit_event(&events, event))?;
                    if ack.need_ack {
                        let frame = encode_ack(decoded.log_id, ack.internal_ext.as_bytes());
                        if write.send(Message::Binary(frame.into())).await.is_err() {
                            break;
                        }
                    }
                }
                Some(Ok(Message::Ping(payload))) => {
                    let _ = write.send(Message::Pong(payload)).await;
                }
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {}
                Some(Err(_)) => {
                    return Err(
                        AppError::new("douyin_ws_read_failed", "抖音弹幕连接中断")
                            .with_site("douyin")
                            .retryable(),
                    );
                }
            }
        }
    }

    Err(AppError::new("douyin_ws_closed", "抖音弹幕连接已断开")
        .with_site("douyin")
        .retryable())
}

fn emit_system(events: &DanmakuEventSender, content: &str) {
    emit_event(
        events,
        DanmakuEvent {
            kind: DanmakuKind::System,
            user: "system".into(),
            is_self: false,
            user_id: None,
            content: content.into(),
            color: None,
            spans: None,
            super_chat: None,
            ts: chrono::Utc::now().timestamp_millis(),
        },
    );
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
        // Likes are platform interaction notices rather than user-authored
        // chat. Classifying them with gifts lets the shared gift-information
        // setting hide both high-frequency event types consistently.
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
        (!user.is_empty())
            .then(|| format!("{user} 进入直播间"))
            .unwrap_or_default(),
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
    event_if_content(DanmakuKind::Chat, user, content, None)
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

pub(crate) fn normalize_outgoing_message(value: &str) -> AppResult<String> {
    let message = value.trim();
    if message.is_empty() {
        return Err(
            AppError::new("douyin_send_empty", "请输入要发送的弹幕内容").with_site("douyin"),
        );
    }
    if message.encode_utf16().count() > MAX_OUTGOING_CHAT_UTF16_UNITS {
        return Err(AppError::new(
            "douyin_send_too_long",
            format!("单条弹幕最多 {MAX_OUTGOING_CHAT_UTF16_UNITS} 个字符"),
        )
        .with_site("douyin"));
    }
    if message.chars().any(char::is_control) {
        return Err(
            AppError::new("douyin_send_invalid_text", "弹幕不能包含换行或控制字符")
                .with_site("douyin"),
        );
    }
    Ok(message.to_string())
}

/// Send one ordinary text danmaku through Douyin's web room chat endpoint.
///
/// The write reuses the same local MSSDK signature parameters used for the
/// receive WSS handshake, then posts to the official live chat HTTP API with
/// the user-saved Cookie. Cookie-bearing writes never follow redirects.
pub async fn send_chat(
    client: &Client,
    cookie: &str,
    room_id: &str,
    message: &str,
) -> AppResult<()> {
    let room_id = room_id.trim();
    if room_id.is_empty()
        || room_id.len() > 32
        || !room_id.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(
            AppError::new("douyin_send_invalid_room", "抖音直播间号无效").with_site("douyin"),
        );
    }
    let cookie = cookie.trim();
    if cookie.is_empty() {
        return Err(AppError::new(
            "douyin_send_cookie_missing",
            "请先在设置中扫码登录，或保存抖音 Cookie",
        )
        .with_site("douyin"));
    }
    let message = normalize_outgoing_message(message)?;
    let user_unique_id = generate_user_unique_id();
    let signature = douyin_sign::get_signature(room_id, &user_unique_id)?;
    // Web live room chat accepts form fields; the signature pair is the same
    // short-lived pair used by the receive WSS URL builder.
    let form = [
        ("content", message.as_str()),
        ("room_id", room_id),
        ("aid", "6383"),
        ("app_name", "douyin_web"),
        ("live_id", "1"),
        ("device_platform", "web"),
        ("language", "zh-CN"),
        ("enter_source", "web_live"),
        ("user_unique_id", user_unique_id.as_str()),
        ("signature", signature.as_str()),
    ];
    let response = client
        .post(SEND_CHAT_URL)
        .header("user-agent", DEFAULT_USER_AGENT)
        .header("origin", "https://live.douyin.com")
        .header("referer", format!("https://live.douyin.com/{room_id}"))
        .header("cookie", cookie)
        .form(&form)
        .send()
        .await
        .map_err(|_| {
            AppError::new(
                "douyin_send_unknown",
                "发送状态未知，请到直播间确认是否已送达",
            )
            .with_site("douyin")
            .retryable()
        })?;
    let status = response.status();
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(
            AppError::new("douyin_send_rate_limited", "发送过快，请稍后再试")
                .with_site("douyin")
                .retryable(),
        );
    }
    let text = response.text().await.map_err(|_| {
        AppError::new(
            "douyin_send_unknown",
            "发送状态未知，请到直播间确认是否已送达",
        )
        .with_site("douyin")
        .retryable()
    })?;
    parse_send_response(status, &text)
}

fn parse_send_response(status: reqwest::StatusCode, text: &str) -> AppResult<()> {
    let value: serde_json::Value = serde_json::from_str(text).unwrap_or(serde_json::Value::Null);
    // Prefer structured platform codes when present; otherwise fall back to
    // the HTTP status so a non-JSON success page is not treated as acceptance.
    let code = value
        .get("status_code")
        .or_else(|| value.get("code"))
        .or_else(|| value.get("error"))
        .and_then(|value| value.as_i64())
        .or_else(|| value.get("status_code").and_then(|value| value.as_u64()).map(|n| n as i64));
    match code {
        Some(0) => Ok(()),
        Some(code) if matches!(code, 10011 | 10012 | 4003101 | 4003105) => Err(AppError::new(
            "douyin_send_rate_limited",
            "发送过快，请稍后再试",
        )
        .with_site("douyin")
        .retryable()),
        Some(code) if matches!(code, 20003 | 20004 | 8 | 10002) => Err(AppError::new(
            "douyin_send_login_expired",
            "抖音登录状态已失效，请更新 Cookie 后重试",
        )
        .with_site("douyin")),
        Some(_) => Err(AppError::new(
            "douyin_send_rejected",
            "抖音未接受此条弹幕，请检查账号状态或直播间限制",
        )
        .with_site("douyin")),
        None if status.is_success() && !text.trim().is_empty() && value.is_null() => {
            // Empty/non-JSON success bodies are ambiguous: the write may have
            // already landed, so do not encourage automatic retries.
            Err(AppError::new(
                "douyin_send_unknown",
                "发送状态未知，请到直播间确认是否已送达",
            )
            .with_site("douyin")
            .retryable())
        }
        None if status.is_success() => Ok(()),
        None => Err(AppError::new(
            "douyin_send_rejected",
            "抖音未接受此条弹幕，请检查账号状态或直播间限制",
        )
        .with_site("douyin")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{Compression, write::GzEncoder};

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
    fn builds_signed_wss_url_with_room_and_signature() {
        let raw = serde_json::json!({
            "room_id": "1234567890123456789",
            "web_rid": "522864404974",
        });
        let args = build_connection("522864404974", &raw, "ttwid=fixture").unwrap();
        let url = Url::parse(&args.wss_url).unwrap();
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
        assert!(
            pairs
                .get("user_unique_id")
                .is_some_and(|value| value.len() == 12)
        );
        assert_eq!(
            args.headers.get("Cookie").map(String::as_str),
            Some("ttwid=fixture")
        );
        assert_eq!(
            args.headers.get("Origin").map(String::as_str),
            Some("https://live.douyin.com")
        );
    }

    #[test]
    fn generate_user_unique_id_is_twelve_digits() {
        let uid = generate_user_unique_id();
        assert_eq!(uid.len(), 12);
        assert!(uid.bytes().all(|byte| byte.is_ascii_digit()));
    }

    #[test]
    fn outgoing_message_is_single_line_and_bounded() {
        assert_eq!(normalize_outgoing_message("  你好  ").unwrap(), "你好");
        assert!(normalize_outgoing_message("\n").is_err());
        assert!(normalize_outgoing_message("hello\nworld").is_err());
        assert!(normalize_outgoing_message(&"a".repeat(MAX_OUTGOING_CHAT_UTF16_UNITS)).is_ok());
        assert!(
            normalize_outgoing_message(&"a".repeat(MAX_OUTGOING_CHAT_UTF16_UNITS + 1)).is_err()
        );
    }

    #[test]
    fn parse_send_response_accepts_zero_codes() {
        assert!(parse_send_response(
            reqwest::StatusCode::OK,
            r#"{"status_code":0,"data":{}}"#
        )
        .is_ok());
        assert!(parse_send_response(reqwest::StatusCode::OK, r#"{"code":0}"#).is_ok());
        assert!(parse_send_response(reqwest::StatusCode::OK, r#"{"error":0}"#).is_ok());
    }

    #[test]
    fn parse_send_response_maps_login_and_rate_limit_codes() {
        let login = parse_send_response(
            reqwest::StatusCode::OK,
            r#"{"status_code":20003,"data":null}"#,
        )
        .unwrap_err();
        assert_eq!(login.code, "douyin_send_login_expired");

        let rate = parse_send_response(
            reqwest::StatusCode::OK,
            r#"{"status_code":10011,"data":null}"#,
        )
        .unwrap_err();
        assert_eq!(rate.code, "douyin_send_rate_limited");
    }
}
