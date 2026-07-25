//! Douyin live danmaku transport.
//!
//! Douyin's web IM endpoint requires a short-lived, signed WSS URL.  The
//! signing algorithm deliberately is not embedded in rLive.  Instead, users
//! may point the app at a service they operate (normally a local one).  Once a
//! signed URL is obtained, this module owns the standard WebSocket, gzip and
//! protobuf framing path and emits the common `DanmakuEvent` model.

use std::collections::HashMap;
use std::io::Read;
use std::net::IpAddr;
use std::time::Duration;

use flate2::read::GzDecoder;
use futures_util::{SinkExt, StreamExt};
use reqwest::Url;
use serde::Deserialize;
use serde_json::json;
use tauri::AppHandle;
use tokio::time;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        Message,
        client::IntoClientRequest,
        http::{HeaderName, HeaderValue},
    },
};

use crate::danmaku::emit_event;
use crate::error::{AppError, AppResult};
use crate::http_client;
use crate::models::live::{DanmakuEvent, DanmakuKind};

const DEFAULT_HEARTBEAT_MS: u64 = 10_000;
const MIN_HEARTBEAT_MS: u64 = 3_000;
const MAX_HEARTBEAT_MS: u64 = 60_000;
const MAX_DECOMPRESSED_FRAME_BYTES: u64 = 8 * 1024 * 1024;
const MAX_EVENT_TEXT_CHARS: usize = 500;
const MAX_USER_NAME_CHARS: usize = 128;

/// This is a valid `PushFrame` containing protobuf field 7 = "hb".
const HEARTBEAT: &[u8] = &[0x3a, 0x02, b'h', b'b'];

#[derive(Debug, Clone)]
pub struct DouyinDanmakuArgs {
    pub wss_url: String,
    pub headers: HashMap<String, String>,
    pub heartbeat_interval: Duration,
}

#[derive(Debug, Deserialize)]
struct SignResponse {
    #[serde(rename = "wssUrl", alias = "wss_url")]
    wss_url: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    heartbeat: Option<HeartbeatResponse>,
}

#[derive(Debug, Deserialize)]
struct HeartbeatResponse {
    #[serde(rename = "intervalMs", alias = "interval_ms")]
    interval_ms: Option<u64>,
}

/// Resolve the app's room metadata into a short-lived WSS connection.
///
/// `sign_service_url` is intentionally a full endpoint (for example
/// `http://127.0.0.1:18080/sign`), rather than a hidden vendor endpoint.  We
/// only submit a saved Cookie to HTTPS or loopback HTTP endpoints.
pub async fn request_signed_connection(
    sign_service_url: Option<&str>,
    room_id: &str,
    raw: &serde_json::Value,
    cookie: &str,
    proxy: Option<&str>,
) -> AppResult<DouyinDanmakuArgs> {
    let endpoint = validate_sign_service_url(sign_service_url)?;
    let actual_room_id = numeric_field(raw.get("room_id")).unwrap_or_else(|| room_id.to_string());
    let live_id = numeric_field(raw.get("web_rid")).unwrap_or_else(|| room_id.to_string());
    validate_numeric_id(&actual_room_id, "房间号")?;
    validate_numeric_id(&live_id, "直播间号")?;

    // Never follow a signer-selected redirect: the JSON body contains the
    // local Douyin Cookie, and a 307/308 would otherwise replay it to an
    // arbitrary destination. A fresh, no-redirect client is intentional here.
    let client = http_client::build_no_redirect_client(proxy)?;

    // Never place Cookie data in logs or error strings.  The configured
    // signing service receives it only because it is needed to create a WSS
    // session with the user's own Douyin account state.
    let response = client
        .post(endpoint)
        .header("accept", "application/json")
        .json(&json!({
            "roomId": actual_room_id,
            "liveId": live_id,
            "cookie": cookie.trim(),
        }))
        .send()
        .await
        .map_err(|_| {
            AppError::new(
                "douyin_sign_request_failed",
                "抖音弹幕签名服务请求失败，请检查地址或网络后重试",
            )
            .with_site("douyin")
            .retryable()
        })?;
    let status = response.status();
    if !status.is_success() {
        return Err(AppError::new(
            "douyin_sign_service_error",
            format!("抖音弹幕签名服务返回 HTTP {status}"),
        )
        .with_site("douyin")
        .retryable());
    }
    let signed = response.json::<SignResponse>().await.map_err(|_| {
        AppError::new(
            "douyin_sign_response_invalid",
            "抖音弹幕签名服务响应无效，请检查服务返回格式",
        )
        .with_site("douyin")
    })?;
    let wss_url = validate_signed_wss_url(&signed.wss_url)?;
    let heartbeat_ms = signed
        .heartbeat
        .and_then(|heartbeat| heartbeat.interval_ms)
        .unwrap_or(DEFAULT_HEARTBEAT_MS)
        .clamp(MIN_HEARTBEAT_MS, MAX_HEARTBEAT_MS);

    Ok(DouyinDanmakuArgs {
        wss_url,
        headers: sanitize_ws_headers(signed.headers),
        heartbeat_interval: Duration::from_millis(heartbeat_ms),
    })
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

fn validate_sign_service_url(value: Option<&str>) -> AppResult<Url> {
    let value = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AppError::new(
                "douyin_sign_service_missing",
                "请先在设置 → 账号 → 抖音中配置弹幕签名服务地址",
            )
            .with_site("douyin")
        })?;
    let url = Url::parse(value).map_err(|_| {
        AppError::new("douyin_sign_service_invalid", "抖音弹幕签名服务地址无效").with_site("douyin")
    })?;
    if url.username() != "" || url.password().is_some() || url.fragment().is_some() {
        return Err(AppError::new(
            "douyin_sign_service_invalid",
            "抖音弹幕签名服务地址不能包含账号、密码或片段",
        )
        .with_site("douyin"));
    }
    let host = url.host_str().unwrap_or_default();
    let secure = url.scheme() == "https";
    let loopback_http = url.scheme() == "http" && is_loopback_host(host);
    if !secure && !loopback_http {
        return Err(AppError::new(
            "douyin_sign_service_insecure",
            "签名服务必须使用 HTTPS，或使用本机回环地址的 HTTP",
        )
        .with_site("douyin"));
    }
    Ok(url)
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<IpAddr>()
            .map(|address| address.is_loopback())
            .unwrap_or(false)
}

fn validate_signed_wss_url(value: &str) -> AppResult<String> {
    let url = Url::parse(value.trim()).map_err(|_| {
        AppError::new("douyin_signed_wss_invalid", "签名服务未返回有效的 WSS 地址")
            .with_site("douyin")
    })?;
    if url.scheme() != "wss" || url.host_str().is_none() {
        return Err(
            AppError::new("douyin_signed_wss_invalid", "签名服务未返回安全的 WSS 地址")
                .with_site("douyin"),
        );
    }
    Ok(url.to_string())
}

fn sanitize_ws_headers(headers: HashMap<String, String>) -> HashMap<String, String> {
    headers
        .into_iter()
        .filter(|(name, value)| {
            let name = name.trim().to_ascii_lowercase();
            let allowed = matches!(
                name.as_str(),
                "cookie" | "user-agent" | "origin" | "referer"
            ) || name.starts_with("x-");
            allowed
                && HeaderName::from_bytes(name.as_bytes()).is_ok()
                && HeaderValue::from_str(value.trim()).is_ok()
        })
        .collect()
}

pub async fn run_loop(app: AppHandle, args: DouyinDanmakuArgs) -> AppResult<()> {
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

    emit_system(&app, "正在连接抖音弹幕服务器…");
    let (ws, _) = connect_async(request).await.map_err(|_| {
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

    emit_system(&app, "抖音弹幕服务器连接成功");
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
                    let ack = decode_response(&payload, &mut |event| emit_event(&app, event))?;
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

fn emit_system(app: &AppHandle, content: &str) {
    emit_event(
        app,
        DanmakuEvent {
            kind: DanmakuKind::System,
            user: "system".into(),
            content: content.into(),
            color: None,
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
        DanmakuKind::Chat,
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
        content,
        color,
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
    fn only_allows_https_or_loopback_sign_services() {
        assert!(validate_sign_service_url(Some("https://example.com/sign")).is_ok());
        assert!(validate_sign_service_url(Some("http://127.0.0.1:18080/sign")).is_ok());
        assert!(validate_sign_service_url(Some("http://localhost:18080/sign")).is_ok());
        assert!(validate_sign_service_url(Some("http://example.com/sign")).is_err());
        assert!(validate_sign_service_url(Some("ftp://example.com/sign")).is_err());
    }

    #[test]
    fn keeps_only_safe_ws_headers() {
        let headers = HashMap::from([
            ("Cookie".into(), "ttwid=abc".into()),
            ("X-TT-Logid".into(), "log".into()),
            ("Host".into(), "attacker.example".into()),
            ("Connection".into(), "close".into()),
        ]);
        let safe = sanitize_ws_headers(headers);
        assert!(safe.contains_key("Cookie"));
        assert!(safe.contains_key("X-TT-Logid"));
        assert!(!safe.contains_key("Host"));
        assert!(!safe.contains_key("Connection"));
    }
}
