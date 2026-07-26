//! Douyu danmaku — STT text over binary framing (simple_live `DouyuDanmaku`).
//!
//! WS: `wss://danmuproxy.douyu.com:8501..=8506`
//! Login / join / heartbeat are STT strings framed as little-endian packets.
//!
//! Note: Douyu's TLS stack only offers RSA-AES-GCM ciphers. Connections must
//! use the system TLS backend (`native-tls`), not rustls.

use std::collections::BTreeSet;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use md5::{Digest, Md5};
use serde::Deserialize;
use serde_json::Value;
use tokio::time;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use uuid::Uuid;

use crate::danmaku::{DanmakuEventSender, emit_event};
use crate::error::{AppError, AppResult};
use crate::models::live::{DanmakuEvent, DanmakuKind};

/// Official proxy ports (simple_live uses 8506; rotate on failure).
const SERVER_PORTS: &[u16] = &[8506, 8505, 8504, 8503, 8502, 8501];
const CLIENT_TO_SERVER: u16 = 689;
const SERVER_TO_CLIENT: u16 = 690;
const HEARTBEAT_SECS: u64 = 45;
/// The live site's web client uses this protocol version while authenticating
/// the websocket session used to submit a normal chat message.
const LOGIN_PROTOCOL_VERSION: &str = "20150929";
const LOGIN_APP_VERSION: &str = "H5_2018021001beta";
const LOGIN_VK_SALT: &str = r#"r5*^5;}2#${XF[h+;'./.Q'1;,-]f'p["#;
const SEND_LOGIN_TIMEOUT: Duration = Duration::from_secs(8);
/// A room may impose a shorter account-level limit. This client-side bound is
/// only a defensive ceiling for a manually composed plain-text message.
const MAX_OUTGOING_CHAT_UTF16_UNITS: usize = 100;
const SEND_PROXY_DISCOVERY_URL: &str = "https://www.douyu.com/swf_api/getProxyServer";
const SEND_PROXY_HOST: &str = "wsproxy.douyu.com";
const SEND_PROXY_PORTS: &[u16] = &[6671, 6672, 6673, 6674, 6675];

// A Douyu packet has a four-byte outer length followed by this fixed header:
// duplicate length (4), message type (2), encryption/reserved (2).  The
// declared length also includes the one-byte NUL terminator after the body.
const PACKET_HEADER_LEN: usize = 12;
const PACKET_TRAILER_LEN: usize = 1;
const MIN_PACKET_FULL_LEN: usize = 4 + 2 + 1 + 1 + PACKET_TRAILER_LEN;
// Danmaku STT messages are normally tiny.  A finite upper bound keeps a
// corrupt length field from making the hot path repeatedly inspect a giant
// payload while still leaving ample space for a legitimate control packet.
const MAX_PACKET_FULL_LEN: usize = 256 * 1024;
// Recover a following valid packet after a local header corruption, but do
// not turn an arbitrarily large invalid WebSocket binary frame into an
// unbounded byte-by-byte CPU scan.
const MAX_PACKET_RESYNC_BYTES: usize = 4 * 1024;

#[derive(Debug, Clone)]
pub struct DouyuDanmakuArgs {
    pub room_id: String,
}

/// The browser-cookie values that authenticate a Douyu STT chat session.
///
/// Do not derive `Debug`: callers must never accidentally put these values in
/// logs or a Tauri error payload. They are copied out of the local account
/// store only for the lifetime of an explicitly user-initiated send.
#[derive(Clone)]
struct DouyuSendCredentials {
    username: String,
    stk: String,
    ltkid: String,
    did: String,
    biz: String,
}

/// The documented public discovery response for the authenticated business
/// websocket. It is deliberately separate from the danmaku read servers:
/// sending a Cookie-derived STT login packet to the read gateway can neither
/// authenticate correctly nor be safely retried.
#[derive(Debug, Deserialize)]
struct SendProxyDiscoveryResponse {
    #[serde(default)]
    error: i64,
    #[serde(default)]
    servers: Vec<SendProxyServer>,
}

#[derive(Debug, Deserialize)]
struct SendProxyServer {
    ip: String,
    port: SendProxyPort,
}

/// The endpoint has returned both JSON numbers and decimal strings for ports.
/// Accept both shapes, then constrain the final value to the fixed allowlist
/// before opening a WebSocket.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum SendProxyPort {
    Number(u16),
    Text(String),
}

impl SendProxyPort {
    fn parse(self) -> Option<u16> {
        match self {
            Self::Number(port) => Some(port),
            Self::Text(port) => port.parse().ok(),
        }
    }
}

pub fn args_from_raw(room_id: &str, raw: &Value) -> AppResult<DouyuDanmakuArgs> {
    let rid = raw
        .get("room_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| {
            raw.get("room_id")
                .and_then(|v| v.as_i64())
                .map(|n| n.to_string())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| room_id.to_string());
    if rid.is_empty() {
        return Err(AppError::new("danmaku_bad_room", "empty douyu room id").with_site("douyu"));
    }
    Ok(DouyuDanmakuArgs { room_id: rid })
}

/// Read a named value from a browser-style Cookie header without logging it.
fn cookie_value<'a>(cookie: &'a str, key: &str) -> Option<&'a str> {
    let cookie = cookie
        .trim()
        .strip_prefix("Cookie:")
        .unwrap_or(cookie)
        .trim();
    cookie.split(';').find_map(|part| {
        let (candidate, value) = part.trim().split_once('=')?;
        (candidate.trim() == key)
            .then_some(value.trim())
            .filter(|value| !value.is_empty())
    })
}

fn cookie_value_any(cookie: &str, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        cookie_value(cookie, key)
            // Cookie fields used by the STT gateway are short opaque tokens.
            // Reject pathological manual input before it becomes a websocket
            // frame, while keeping the actual value local.
            .filter(|value| value.len() <= 4_096)
            .map(str::to_owned)
    })
}

fn credentials_from_cookie(cookie: &str) -> Option<DouyuSendCredentials> {
    let username = cookie_value_any(cookie, &["acf_username"])?;
    let stk = cookie_value_any(cookie, &["acf_stk"])?;
    // Older browser sessions and some QR flows use an underscore-wrapped
    // spelling. Accept both forms so users can paste their complete Cookie
    // header without having to edit a token by hand.
    let ltkid = cookie_value_any(cookie, &["acf_ltkid", "_acf_ltkid_", "acf_ltkid_"])?;
    let did = cookie_value_any(cookie, &["acf_did", "dy_did"]).unwrap_or_else(|| {
        // The device id participates in the protocol's vk checksum. A fresh
        // UUID is compatible with a complete authenticated session when an
        // older cookie export omitted this non-session field.
        Uuid::new_v4()
            .to_string()
            .replace('-', "")
            .to_ascii_uppercase()
    });
    let biz = cookie_value_any(cookie, &["acf_biz"]).unwrap_or_default();
    Some(DouyuSendCredentials {
        username,
        stk,
        ltkid,
        did,
        biz,
    })
}

/// Whether a saved browser Cookie has the session fields needed to authenticate
/// a user-initiated normal chat submission.
pub fn has_send_credentials(cookie: &str) -> bool {
    credentials_from_cookie(cookie).is_some()
}

/// Validate a manually composed regular chat message before the command
/// reserves its short cooldown. Douyu applies account/room-specific limits on
/// top of this conservative local safety bound.
pub(crate) fn normalize_outgoing_message(value: &str) -> AppResult<String> {
    let message = value.trim();
    if message.is_empty() {
        return Err(AppError::new("douyu_send_empty", "请输入要发送的弹幕内容").with_site("douyu"));
    }
    if message.encode_utf16().count() > MAX_OUTGOING_CHAT_UTF16_UNITS {
        return Err(AppError::new(
            "douyu_send_too_long",
            format!("单条弹幕最多 {MAX_OUTGOING_CHAT_UTF16_UNITS} 个字符"),
        )
        .with_site("douyu"));
    }
    if message.chars().any(char::is_control) {
        return Err(
            AppError::new("douyu_send_invalid_text", "弹幕不能包含换行或控制字符")
                .with_site("douyu"),
        );
    }
    Ok(message.to_string())
}

/// Escape one STT field value. The protocol uses `@=` and `/` as structural
/// separators, so outgoing user text and opaque Cookie values must be encoded
/// before they are placed into a packet.
fn escape_stt(value: &str) -> String {
    value.replace('@', "@A").replace('/', "@S")
}

fn encode_stt_fields(fields: &[(&str, &str)]) -> String {
    let mut body = String::new();
    for (key, value) in fields {
        body.push_str(key);
        body.push_str("@=");
        body.push_str(&escape_stt(value));
        body.push('/');
    }
    body
}

fn current_unix_seconds() -> AppResult<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| {
            AppError::new("douyu_send_clock", "系统时间异常，无法验证斗鱼登录状态")
                .with_site("douyu")
        })
}

fn login_request_body(room_id: &str, credentials: &DouyuSendCredentials, now: u64) -> String {
    let now = now.to_string();
    let vk_input = format!("{now}{LOGIN_VK_SALT}{}", credentials.did);
    let vk = format!("{:x}", Md5::digest(vk_input.as_bytes()));
    encode_stt_fields(&[
        ("type", "loginreq"),
        ("username", credentials.username.as_str()),
        ("ct", "0"),
        ("password", ""),
        ("roomid", room_id),
        ("devid", credentials.did.as_str()),
        ("rt", now.as_str()),
        ("pt", "2"),
        ("vk", vk.as_str()),
        ("ver", LOGIN_PROTOCOL_VERSION),
        ("aver", LOGIN_APP_VERSION),
        ("biz", credentials.biz.as_str()),
        ("stk", credentials.stk.as_str()),
        ("ltkid", credentials.ltkid.as_str()),
    ])
}

fn chat_request_body(message: &str) -> String {
    // This is the ordinary-text payload used by the web room client. It has no
    // gift, payment, scheduling, or repeat fields; every call sends one text
    // message explicitly supplied by the user.
    encode_stt_fields(&[
        ("type", "chatmessage"),
        ("receiver", "0"),
        ("content", message),
        ("scope", ""),
        ("col", "0"),
        ("pid", ""),
        ("p2p", "0"),
        ("nc", "0"),
        ("rev", "0"),
        ("hg", "0"),
        ("ifs", "0"),
        ("sid", ""),
        ("lid", "0"),
    ])
}

/// Frame a STT body for Douyu binary protocol.
pub fn serialize_packet(body: &str) -> Vec<u8> {
    let body_bytes = body.as_bytes();
    // length fields cover: second_len(4) + type(2) + enc(1) + rsv(1) + body + nul(1)
    let full_len = (4 + 2 + 1 + 1 + body_bytes.len() + 1) as u32;
    let mut out = Vec::with_capacity(4 + full_len as usize);
    out.extend_from_slice(&full_len.to_le_bytes());
    out.extend_from_slice(&full_len.to_le_bytes());
    out.extend_from_slice(&CLIENT_TO_SERVER.to_le_bytes());
    out.push(0); // encrypted
    out.push(0); // reserved
    out.extend_from_slice(body_bytes);
    out.push(0); // trailing nul
    out
}

/// Return the body and total byte length of a well-formed packet at `offset`.
///
/// The two length fields, known packet type, and trailing NUL are all cheap
/// checks that sharply reduce false positives when recovering after a corrupt
/// packet in an otherwise valid WebSocket frame.
fn packet_at(data: &[u8], offset: usize) -> Option<(usize, &[u8])> {
    let header_end = offset.checked_add(PACKET_HEADER_LEN)?;
    if header_end > data.len() {
        return None;
    }

    let full = u32::from_le_bytes(data[offset..offset + 4].try_into().ok()?) as usize;
    let duplicate_full = u32::from_le_bytes(data[offset + 4..offset + 8].try_into().ok()?) as usize;
    let packet_type = u16::from_le_bytes(data[offset + 8..offset + 10].try_into().ok()?);
    let encryption = data[offset + 10];
    let reserved = data[offset + 11];
    if full != duplicate_full
        || !(MIN_PACKET_FULL_LEN..=MAX_PACKET_FULL_LEN).contains(&full)
        || (packet_type != CLIENT_TO_SERVER && packet_type != SERVER_TO_CLIENT)
        // This parser only understands plaintext STT. Rejecting non-zero
        // flags also makes a false header during bounded resynchronisation
        // substantially less likely.
        || encryption != 0
        || reserved != 0
    {
        return None;
    }

    // `full` excludes the first length field.  It includes the duplicate
    // length/type/flags, body, and terminal NUL.
    let total = 4usize.checked_add(full)?;
    let packet_end = offset.checked_add(total)?;
    if packet_end > data.len() || data[packet_end - 1] != 0 {
        return None;
    }

    let body_len = full.checked_sub(MIN_PACKET_FULL_LEN)?;
    let body_start = header_end;
    let body_end = body_start.checked_add(body_len)?;
    // The body must end immediately before the protocol's NUL terminator.
    if body_end != packet_end - PACKET_TRAILER_LEN {
        return None;
    }
    Some((total, &data[body_start..body_end]))
}

/// Visit zero or more UTF-8 STT body strings from a binary buffer.
///
/// The Douyu proxy commonly bundles many protocol packets into a single WS
/// frame. Keeping this as a borrowing iterator-style helper lets the live
/// connection discard uninteresting packets (especially `uenter`) without
/// first allocating a `String` for every body.  A malformed packet advances
/// one byte and searches for the next validated header so it cannot hide a
/// following valid chat packet in the same WebSocket frame.
fn for_each_packet(data: &[u8], mut visit: impl FnMut(&str)) {
    let mut offset = 0usize;
    let mut resync_bytes = 0usize;
    while offset
        .checked_add(PACKET_HEADER_LEN)
        .is_some_and(|header_end| header_end <= data.len())
    {
        let Some((total, body)) = packet_at(data, offset) else {
            if resync_bytes >= MAX_PACKET_RESYNC_BYTES {
                break;
            }
            offset += 1;
            resync_bytes += 1;
            continue;
        };

        if let Ok(stt) = std::str::from_utf8(body) {
            if !stt.is_empty() {
                visit(stt);
            }
        }
        offset += total;
        resync_bytes = 0;
    }
}

/// Test-only convenience wrapper around the borrowing packet visitor.
#[cfg(test)]
fn deserialize_packets(data: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    for_each_packet(data, |body| out.push(body.to_owned()));
    out
}

/// Unescape Douyu STT `@S` / `@A` sequences.
pub fn unescape_slash_at(s: &str) -> String {
    s.replace("@S", "/").replace("@A", "@")
}

/// Read the message type without constructing a map. Douyu sends `type` as
/// the first field, but retain the generic fallback so malformed/reordered
/// packets keep the former parser's behaviour.
fn stt_type(stt: &str) -> Option<&str> {
    if let Some(rest) = stt.strip_prefix("type@=") {
        if let Some(value) = rest.split('/').next().filter(|value| !value.is_empty()) {
            return Some(value);
        }
    }

    stt.split('/').find_map(|field| {
        let (key, value) = field.split_once("@=")?;
        (key == "type" && !value.is_empty()).then_some(value)
    })
}

/// Decode a value only when the STT escape syntax is actually present.
fn decode_value(value: &str) -> String {
    if value.contains("@S") || value.contains("@A") {
        unescape_slash_at(value)
    } else {
        value.to_owned()
    }
}

/// Some upstream relay variants encode room-entry notices as `chatmsg`
/// instead of the normal high-volume `uenter` packet.  They have no value in
/// the chat UI and used to cross the IPC boundary as text such as
/// "某某进入直播间".  Keep this check on the borrowed STT field, before escape
/// decoding or allocating a [`DanmakuEvent`].
const ROOM_ENTER_SUFFIXES: [&str; 3] = ["进入直播间", "进入了直播间", "进入直播间了"];

fn has_room_enter_suffix(content: &str) -> bool {
    // The normal packet path avoids any allocation. `进入直播间了` ends in
    // `了`, so it must not be skipped by the usual final-`间` shortcut.
    if !matches!(content.chars().next_back(), Some('间' | '了')) {
        return false;
    }
    ROOM_ENTER_SUFFIXES
        .iter()
        .any(|suffix| content.ends_with(suffix))
}

fn ends_with_room_enter_suffix_ignoring_whitespace(content: &str, suffix: &str) -> bool {
    let mut content_chars = content
        .chars()
        .rev()
        .filter(|character| !character.is_whitespace());
    suffix
        .chars()
        .rev()
        .all(|expected| content_chars.next() == Some(expected))
}

fn is_room_enter_noise(content: &str) -> bool {
    let content = content.trim();
    if has_room_enter_suffix(content) {
        return true;
    }
    if !matches!(content.chars().next_back(), Some('间' | '了'))
        || !content.chars().any(char::is_whitespace)
    {
        return false;
    }
    ROOM_ENTER_SUFFIXES
        .iter()
        .any(|suffix| ends_with_room_enter_suffix_ignoring_whitespace(content, suffix))
}

fn parse_chat_message(stt: &str) -> Option<DanmakuEvent> {
    let mut user = None;
    let mut content = None;
    let mut color = None;
    let mut has_dms = false;

    // Only inspect fields required for a real chat event. The old generic
    // HashMap parser allocated every field of every packet, including noisy
    // enter/heartbeat/control packets in busy rooms.
    for field in stt.split('/') {
        let Some((key, value)) = field.split_once("@=") else {
            continue;
        };
        match key {
            "dms" => has_dms = true,
            "nn" => user = Some(value),
            "txt" => content = Some(value),
            "col" => color = Some(value),
            _ => {}
        }
    }

    // simple_live filters messages without `dms` (anti-spam / "阴间弹幕").
    if !has_dms {
        return None;
    }

    let raw_content = content?;
    if is_room_enter_noise(raw_content) {
        return None;
    }

    let content = decode_value(raw_content);
    if content.is_empty() {
        return None;
    }
    let user = user
        .map(decode_value)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "用户".into());
    let col = color
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);

    Some(DanmakuEvent {
        kind: DanmakuKind::Chat,
        user,
        content,
        color: color_from_col(col),
        spans: None,
        super_chat: None,
        ts: chrono::Utc::now().timestamp_millis(),
    })
}

fn parse_gift_message(stt: &str) -> DanmakuEvent {
    let mut user = None;
    let mut gift_name = None;
    let mut fallback_gift_name = None;
    let mut gift_count = None;
    let mut fallback_gift_count = None;

    for field in stt.split('/') {
        let Some((key, value)) = field.split_once("@=") else {
            continue;
        };
        match key {
            "nn" => user = Some(value),
            "gfn" => gift_name = Some(value),
            "gn" => fallback_gift_name = Some(value),
            "gfcnt" => gift_count = Some(value),
            "hits" => fallback_gift_count = Some(value),
            _ => {}
        }
    }

    let user = user
        .map(decode_value)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "用户".into());
    let gift = gift_name
        .or(fallback_gift_name)
        .map(decode_value)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "礼物".into());
    let count = gift_count
        .or(fallback_gift_count)
        .map(decode_value)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "1".into());

    DanmakuEvent {
        kind: DanmakuKind::Gift,
        user,
        content: format!("投喂 {gift} x{count}"),
        color: None,
        spans: None,
        super_chat: None,
        ts: chrono::Utc::now().timestamp_millis(),
    }
}

fn color_from_col(col: i64) -> Option<String> {
    // simple_live DouyuDanmaku.getColor
    let rgb = match col {
        1 => (255, 0, 0),
        2 => (30, 135, 240),
        3 => (122, 200, 75),
        4 => (255, 127, 0),
        5 => (155, 57, 244),
        6 => (255, 105, 180),
        _ => return None,
    };
    Some(format!("#{:02x}{:02x}{:02x}", rgb.0, rgb.1, rgb.2))
}

pub fn parse_stt_message(stt: &str) -> Option<DanmakuEvent> {
    match stt_type(stt)? {
        "chatmsg" => parse_chat_message(stt),
        // `uenter` is a high-volume room-presence notification, not a user
        // chat. Suppressing it before JSON/IPC/UI work removes messages such
        // as “xxx 进入直播间” while preserving the `Enter` event kind for other
        // site implementations and normal chat/gift events for Douyu.
        "uenter" => None,
        "dgb" | "odfbc" | "rndp" => Some(parse_gift_message(stt)),
        _ => None,
    }
}

fn decode_binary_with(data: &[u8], mut emit: impl FnMut(DanmakuEvent)) {
    for_each_packet(data, |stt| {
        if let Some(event) = parse_stt_message(stt) {
            emit(event);
        }
    });
}

#[cfg(test)]
fn decode_binary(data: &[u8]) -> Vec<DanmakuEvent> {
    let mut events = Vec::new();
    decode_binary_with(data, |event| events.push(event));
    events
}

/// Keep the Cookie-derived login packet on the endpoint class that Douyu
/// publishes for business websocket traffic. The discovery payload is treated
/// as untrusted input even though it comes from a trusted HTTPS origin: only
/// the expected host and small known port set can ever receive the packet.
fn parse_send_proxy_urls(payload: SendProxyDiscoveryResponse) -> AppResult<Vec<String>> {
    if payload.error != 0 {
        return Err(AppError::new(
            "douyu_send_server_discovery",
            "斗鱼发送服务器暂时不可用，请稍后重试",
        )
        .with_site("douyu")
        .retryable());
    }

    let ports = payload
        .servers
        .into_iter()
        .filter_map(|server| {
            let port = server.port.parse()?;
            (server.ip.eq_ignore_ascii_case(SEND_PROXY_HOST) && SEND_PROXY_PORTS.contains(&port))
                .then_some(port)
        })
        .collect::<BTreeSet<_>>();
    if ports.is_empty() {
        return Err(AppError::new(
            "douyu_send_server_discovery",
            "斗鱼发送服务器地址无效，请稍后重试",
        )
        .with_site("douyu")
        .retryable());
    }

    Ok(ports
        .into_iter()
        .map(|port| format!("wss://{SEND_PROXY_HOST}:{port}/"))
        .collect())
}

async fn discover_send_proxy_urls(
    proxy: Option<&str>,
    room_id: &str,
    attempt_id: &Uuid,
) -> AppResult<Vec<String>> {
    let client = crate::http_client::build_no_redirect_client(proxy)?;
    let response = client
        .get(SEND_PROXY_DISCOVERY_URL)
        .header("Referer", "https://www.douyu.com/")
        .send()
        .await
        .map_err(|error| {
            // The request URL is fixed and contains no account data. Do not
            // include the configured proxy URL, Cookie, or raw response body.
            tracing::warn!(
                %attempt_id,
                room_id,
                stage = "server_discovery_request",
                error = %error,
                "douyu send server discovery request failed"
            );
            AppError::new(
                "douyu_send_server_discovery",
                "无法获取斗鱼发送服务器，请稍后重试",
            )
            .with_site("douyu")
            .retryable()
        })?;
    if !response.status().is_success() {
        tracing::warn!(
            %attempt_id,
            room_id,
            stage = "server_discovery_response",
            status = response.status().as_u16(),
            "douyu send server discovery returned a non-success status"
        );
        return Err(AppError::new(
            "douyu_send_server_discovery",
            "无法获取斗鱼发送服务器，请稍后重试",
        )
        .with_site("douyu")
        .retryable());
    }
    let payload = response
        .json::<SendProxyDiscoveryResponse>()
        .await
        .map_err(|error| {
            tracing::warn!(
                %attempt_id,
                room_id,
                stage = "server_discovery_parse",
                error = %error,
                "douyu send server discovery response could not be parsed"
            );
            AppError::new(
                "douyu_send_server_discovery",
                "斗鱼发送服务器返回无效数据，请稍后重试",
            )
            .with_site("douyu")
            .retryable()
        })?;
    let urls = parse_send_proxy_urls(payload).map_err(|error| {
        tracing::warn!(
            %attempt_id,
            room_id,
            stage = "server_discovery_validate",
            error_code = %error.code,
            "douyu send server discovery response was rejected"
        );
        error
    })?;
    Ok(urls)
}

async fn connect_douyu_send_ws(
    proxy: Option<&str>,
    room_id: &str,
    attempt_id: &Uuid,
) -> AppResult<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
> {
    let urls = discover_send_proxy_urls(proxy, room_id, attempt_id).await?;
    for url in urls {
        let mut request = match url.as_str().into_client_request() {
            Ok(request) => request,
            Err(_) => {
                continue;
            }
        };
        let headers = request.headers_mut();
        if let Ok(value) = HeaderValue::from_str("https://www.douyu.com/") {
            headers.insert("Origin", value);
        }
        if let Ok(value) = HeaderValue::from_str(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        ) {
            headers.insert("User-Agent", value);
        }
        match connect_async(request).await {
            Ok((ws, _)) => return Ok(ws),
            Err(error) => {
                tracing::warn!(
                    %attempt_id,
                    room_id,
                    endpoint = %url,
                    stage = "server_connect",
                    error = %error,
                    "douyu send websocket connect failed"
                );
            }
        }
    }
    Err(
        AppError::new("douyu_send_network", "无法连接斗鱼发送服务器，请稍后重试")
            .with_site("douyu")
            .retryable(),
    )
}

async fn connect_douyu_ws() -> AppResult<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
> {
    let mut last_err = String::new();
    for &port in SERVER_PORTS {
        let url = format!("wss://danmuproxy.douyu.com:{port}/");
        let mut req = match url.as_str().into_client_request() {
            Ok(r) => r,
            Err(e) => {
                last_err = format!("bad url {url}: {e}");
                continue;
            }
        };
        let headers = req.headers_mut();
        // Browser-like headers improve acceptance on some edges.
        if let Ok(v) = HeaderValue::from_str("https://www.douyu.com/") {
            headers.insert("Origin", v);
        }
        if let Ok(v) = HeaderValue::from_str(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        ) {
            headers.insert("User-Agent", v);
        }
        match connect_async(req).await {
            Ok((ws, _)) => return Ok(ws),
            Err(e) => {
                last_err = format!("{url}: {e}");
                tracing::warn!(port, error = %e, "douyu danmaku ws connect failed");
            }
        }
    }
    Err(AppError::new(
        "danmaku_ws_error",
        format!("douyu connect failed (all ports): {last_err}"),
    )
    .with_site("douyu")
    .retryable())
}

fn stt_field<'a>(stt: &'a str, expected_key: &str) -> Option<&'a str> {
    stt.split('/').find_map(|field| {
        let (key, value) = field.split_once("@=")?;
        (key == expected_key).then_some(value)
    })
}

/// A successful authenticated login reply includes the account nickname. An
/// anonymous `loginres` has an empty nickname and must never be allowed to
/// proceed to the write packet.
fn login_reply_from_stt(stt: &str) -> Option<bool> {
    (stt_type(stt)? == "loginres").then(|| {
        stt_field(stt, "nickname")
            .map(str::trim)
            .is_some_and(|nickname| !nickname.is_empty())
    })
}

fn login_reply_from_binary(data: &[u8]) -> Option<bool> {
    let mut reply = None;
    for_each_packet(data, |stt| {
        if reply.is_none() {
            reply = login_reply_from_stt(stt);
        }
    });
    reply
}

/// Authenticate a short-lived websocket session and submit one ordinary
/// Douyu chat message.
///
/// There is intentionally no automatic retry and no optimistic local event:
/// once the final WebSocket write succeeds, the remote side may already have
/// accepted the message even if a subsequent network error occurs. The normal
/// room danmaku connection remains the source of truth for the eventual echo.
pub async fn send_chat(
    cookie: &str,
    room_id: &str,
    message: &str,
    proxy: Option<&str>,
) -> AppResult<()> {
    let room_id = room_id.trim();
    if room_id.is_empty()
        || room_id.len() > 32
        || !room_id.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(AppError::new("douyu_send_invalid_room", "斗鱼直播间号无效").with_site("douyu"));
    }
    let message = normalize_outgoing_message(message)?;
    let credentials = credentials_from_cookie(cookie).ok_or_else(|| {
        AppError::new(
            "douyu_send_cookie_missing",
            "请先在设置中扫码登录或保存含 acf_username、acf_stk、acf_ltkid 的斗鱼 Cookie",
        )
        .with_site("douyu")
    })?;
    // Failure diagnostics use this id to correlate stages. Neither Cookie
    // fields nor outgoing text may reach the persistent log.
    let attempt_id = Uuid::new_v4();
    let login = login_request_body(room_id, &credentials, current_unix_seconds()?);

    let ws = match connect_douyu_send_ws(proxy, room_id, &attempt_id).await {
        Ok(ws) => ws,
        Err(error) => {
            // `connect_douyu_ws` logs the individual port failures. Retain the
            // final safe error code here to tie them to this send attempt.
            tracing::warn!(
                %attempt_id,
                room_id,
                stage = "connect",
                error_code = %error.code,
                retryable = error.retryable,
                "douyu send websocket connection failed"
            );
            return Err(
                AppError::new("douyu_send_network", "无法连接斗鱼弹幕服务器，请稍后重试")
                    .with_site("douyu")
                    .retryable(),
            );
        }
    };
    let (mut write, mut read) = ws.split();
    write
        .send(Message::Binary(serialize_packet(&login).into()))
        .await
        .map_err(|error| {
            tracing::warn!(
                %attempt_id,
                room_id,
                stage = "login_write",
                error = %error,
                "douyu send login packet write failed"
            );
            AppError::new("douyu_send_network", "斗鱼弹幕服务器连接中断，请稍后重试")
                .with_site("douyu")
                .retryable()
        })?;
    let login_result = time::timeout(SEND_LOGIN_TIMEOUT, async {
        loop {
            let frame = match read.next().await {
                Some(Ok(frame)) => frame,
                Some(Err(error)) => {
                    tracing::warn!(
                        %attempt_id,
                        room_id,
                        stage = "login_read",
                        error = %error,
                        "douyu send login response read failed"
                    );
                    return Err(AppError::new(
                        "douyu_send_network",
                        "斗鱼登录连接中断，请稍后重试",
                    )
                    .with_site("douyu")
                    .retryable());
                }
                None => {
                    tracing::warn!(
                        %attempt_id,
                        room_id,
                        stage = "login_read",
                        "douyu send login websocket closed before a response"
                    );
                    return Err(AppError::new(
                        "douyu_send_login_expired",
                        "斗鱼登录会话已关闭，请更新 Cookie 后重试",
                    )
                    .with_site("douyu"));
                }
            };
            let reply = match frame {
                Message::Binary(data) => login_reply_from_binary(&data),
                Message::Text(text) => login_reply_from_stt(text.as_str()),
                Message::Ping(payload) => {
                    write.send(Message::Pong(payload)).await.map_err(|error| {
                        tracing::warn!(
                            %attempt_id,
                            room_id,
                            stage = "login_pong",
                            error = %error,
                            "douyu send login ping response failed"
                        );
                        AppError::new("douyu_send_network", "斗鱼登录连接中断，请稍后重试")
                            .with_site("douyu")
                            .retryable()
                    })?;
                    None
                }
                Message::Close(frame) => {
                    tracing::warn!(
                        %attempt_id,
                        room_id,
                        stage = "login_close",
                        close_frame = frame.is_some(),
                        "douyu send login websocket closed"
                    );
                    return Err(AppError::new(
                        "douyu_send_login_expired",
                        "斗鱼登录会话已关闭，请更新 Cookie 后重试",
                    )
                    .with_site("douyu"));
                }
                _ => None,
            };
            if let Some(authenticated) = reply {
                if authenticated {
                    return Ok(());
                }
                tracing::warn!(
                    %attempt_id,
                    room_id,
                    stage = "login_response",
                    error_code = "douyu_send_login_expired",
                    "douyu send login was rejected"
                );
                return Err(AppError::new(
                    "douyu_send_login_expired",
                    "斗鱼登录状态已失效，请重新扫码或更新 Cookie 后重试",
                )
                .with_site("douyu"));
            }
        }
    })
    .await;
    match login_result {
        Ok(result) => result?,
        Err(_) => {
            tracing::warn!(
                %attempt_id,
                room_id,
                stage = "login_timeout",
                timeout_seconds = SEND_LOGIN_TIMEOUT.as_secs(),
                "douyu send login confirmation timed out"
            );
            return Err(AppError::new(
                "douyu_send_login_timeout",
                "斗鱼登录确认超时，请检查 Cookie 后重试",
            )
            .with_site("douyu")
            .retryable());
        }
    }

    // `send` flushes the complete WebSocket frame. Do not wait for or retry an
    // undocumented response packet here: server-side filtering can be
    // asynchronous, and the live room connection is responsible for showing a
    // confirmed echo.
    write
        .send(Message::Binary(
            serialize_packet(&chat_request_body(&message)).into(),
        ))
        .await
        .map_err(|error| {
            tracing::warn!(
                %attempt_id,
                room_id,
                stage = "chat_write",
                error = %error,
                "douyu send chat packet write failed"
            );
            AppError::new(
                "douyu_send_unknown",
                "发送状态未知，请到直播间确认是否已送达",
            )
            .with_site("douyu")
            .retryable()
        })?;
    Ok(())
}

pub async fn run_loop(events: DanmakuEventSender, args: DouyuDanmakuArgs) -> AppResult<()> {
    emit_event(
        &events,
        DanmakuEvent {
            kind: DanmakuKind::System,
            user: "system".into(),
            content: format!("正在连接弹幕服务器… room={}", args.room_id),
            color: None,
            spans: None,
            super_chat: None,
            ts: chrono::Utc::now().timestamp_millis(),
        },
    );

    let ws = connect_douyu_ws().await?;
    let (mut write, mut read) = ws.split();

    // login + join group
    let login = format!("type@=loginreq/roomid@={}/", args.room_id);
    let join = format!("type@=joingroup/rid@={}/gid@=-9999/", args.room_id);
    write
        .send(Message::Binary(serialize_packet(&login).into()))
        .await
        .map_err(|e| {
            AppError::new("danmaku_ws_error", format!("login send: {e}")).with_site("douyu")
        })?;
    write
        .send(Message::Binary(serialize_packet(&join).into()))
        .await
        .map_err(|e| {
            AppError::new("danmaku_ws_error", format!("join send: {e}")).with_site("douyu")
        })?;

    emit_event(
        &events,
        DanmakuEvent {
            kind: DanmakuKind::System,
            user: "system".into(),
            content: "弹幕服务器连接成功".into(),
            color: None,
            spans: None,
            super_chat: None,
            ts: chrono::Utc::now().timestamp_millis(),
        },
    );

    let mut heartbeat = time::interval(Duration::from_secs(HEARTBEAT_SECS));
    heartbeat.tick().await;
    let mut msg_count: u64 = 0;

    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                let hb = serialize_packet("type@=mrkl/");
                if write.send(Message::Binary(hb.into())).await.is_err() {
                    break;
                }
            }
            msg = read.next() => {
                match msg {
                    Some(Ok(Message::Binary(bin))) => {
                        decode_binary_with(&bin, |ev| {
                            msg_count += 1;
                            emit_event(&events, ev);
                        });
                    }
                    Some(Ok(Message::Text(text))) => {
                        // Some proxies may deliver text; try STT parse directly.
                        if let Some(ev) = parse_stt_message(text.as_str()) {
                            msg_count += 1;
                            emit_event(&events, ev);
                        }
                    }
                    Some(Ok(Message::Ping(p))) => {
                        let _ = write.send(Message::Pong(p)).await;
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(e)) => {
                        tracing::warn!(error = %e, msgs = msg_count, "douyu danmaku read error");
                        break;
                    }
                    _ => {}
                }
            }
        }
    }

    emit_event(
        &events,
        DanmakuEvent {
            kind: DanmakuKind::System,
            user: "system".into(),
            content: format!("弹幕连接结束（已收 {msg_count} 条）"),
            color: None,
            spans: None,
            super_chat: None,
            ts: chrono::Utc::now().timestamp_millis(),
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialize_roundtrip_body() {
        let body = "type@=loginreq/roomid@=123/";
        let pkt = serialize_packet(body);
        let decoded = deserialize_packets(&pkt);
        assert_eq!(decoded.len(), 1);
        assert_eq!(decoded[0], body);
    }

    #[test]
    fn outgoing_send_requires_the_authenticated_cookie_fields() {
        assert!(!has_send_credentials("acf_username=viewer"));
        assert!(!has_send_credentials("acf_stk=session; acf_ltkid=login"));
        assert!(has_send_credentials(
            "acf_username=viewer; acf_stk=session; acf_ltkid=login; acf_did=device; acf_biz=1"
        ));
        assert!(has_send_credentials(
            "Cookie: acf_username=viewer; acf_stk=session; _acf_ltkid_=legacy-login"
        ));
    }

    #[test]
    fn send_proxy_discovery_only_accepts_the_trusted_business_websocket_hosts() {
        let response: SendProxyDiscoveryResponse = serde_json::from_value(serde_json::json!({
            "error": 0,
            "servers": [
                { "ip": "wsproxy.douyu.com", "port": "6675" },
                { "ip": "WSPROXY.DOUYU.COM", "port": 6671 },
                { "ip": "wsproxy.douyu.com", "port": 6671 },
                { "ip": "wsproxy.douyu.com", "port": 8506 },
                { "ip": "untrusted.example", "port": 6672 }
            ]
        }))
        .unwrap();
        assert_eq!(
            parse_send_proxy_urls(response).unwrap(),
            vec![
                "wss://wsproxy.douyu.com:6671/".to_string(),
                "wss://wsproxy.douyu.com:6675/".to_string(),
            ]
        );

        let invalid: SendProxyDiscoveryResponse = serde_json::from_value(serde_json::json!({
            "error": 0,
            "servers": [{ "ip": "127.0.0.1", "port": 6671 }]
        }))
        .unwrap();
        assert_eq!(
            parse_send_proxy_urls(invalid).unwrap_err().code,
            "douyu_send_server_discovery"
        );
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
        assert!(normalize_outgoing_message(&"😀".repeat(50)).is_ok());
        assert!(normalize_outgoing_message(&"😀".repeat(51)).is_err());
    }

    #[test]
    fn outgoing_stt_body_escapes_user_text_and_cookie_values() {
        let body = chat_request_body("@主播/冲啊");
        assert!(body.starts_with("type@=chatmessage/receiver@=0/"));
        assert!(body.contains("content@=@A主播@S冲啊/"));

        let credentials = DouyuSendCredentials {
            username: "u/name@site".into(),
            stk: "stk/value".into(),
            ltkid: "login@key".into(),
            did: "device".into(),
            biz: "1".into(),
        };
        let login = login_request_body("123", &credentials, 1_700_000_000);
        assert!(login.starts_with("type@=loginreq/username@=u@Sname@Asite/"));
        assert!(login.contains("stk@=stk@Svalue/"));
        assert!(login.contains("ltkid@=login@Akey/"));
        assert!(login.contains("vk@="));
    }

    #[test]
    fn authenticated_login_reply_requires_a_nickname() {
        let success =
            serialize_packet("type@=loginres/userid@=42/username@=viewer/nickname@=热心观众/");
        let anonymous = serialize_packet("type@=loginres/userid@=0/username@=/nickname@=/");
        assert_eq!(login_reply_from_binary(&success), Some(true));
        assert_eq!(login_reply_from_binary(&anonymous), Some(false));
        assert_eq!(login_reply_from_stt("type@=chatmsg/txt@=ignored/"), None);
    }

    #[test]
    fn parse_chatmsg() {
        let stt = "type@=chatmsg/nn@=alice/txt@=hello world/col@=1/dms@=5/";
        let ev = parse_stt_message(stt).unwrap();
        assert_eq!(ev.user, "alice");
        assert_eq!(ev.content, "hello world");
        assert_eq!(ev.color.as_deref(), Some("#ff0000"));
        assert!(matches!(ev.kind, DanmakuKind::Chat));
    }

    #[test]
    fn parse_chatmsg_filters_without_dms() {
        let stt = "type@=chatmsg/nn@=bob/txt@=spam/col@=0/";
        assert!(parse_stt_message(stt).is_none());
    }

    #[test]
    fn parse_chatmsg_accepts_reordered_type_field() {
        let stt = "nn@=alice/txt@=hello/dms@=1/type@=chatmsg/";
        let event = parse_stt_message(stt).expect("chat event");
        assert_eq!(event.user, "alice");
        assert_eq!(event.content, "hello");
    }

    #[test]
    fn parse_uenter_is_suppressed() {
        let stt = "type@=uenter/nn@=热心观众/uid@=12345/";
        assert!(parse_stt_message(stt).is_none());
    }

    #[test]
    fn parse_chatmsg_suppresses_textual_room_entry_noise() {
        for text in [
            "热心观众进入直播间",
            "热心观众 进入直播间",
            "热心观众进入了直播间",
            "热心观众进入直播间了",
            "热 心 观 众 进 入 了 直 播 间",
            "热 心 观 众 进 入 直 播 间 了",
        ] {
            let stt = format!("type@=chatmsg/nn@=热心观众/txt@={text}/dms@=1/");
            assert!(
                parse_stt_message(&stt).is_none(),
                "entry notice must not become a chat event: {text}"
            );
        }

        let normal = "type@=chatmsg/nn@=热心观众/txt@=刚进入直播间就看到好节目/dms@=1/";
        assert!(parse_stt_message(normal).is_some());
    }

    #[test]
    fn parse_gift_preserves_user_and_gift_fields() {
        let stt = "type@=dgb/nn@=alice/gfn@=火箭/gfcnt@=2/gn@=备用礼物/hits@=3/";
        let event = parse_stt_message(stt).expect("gift event");
        assert!(matches!(event.kind, DanmakuKind::Gift));
        assert_eq!(event.user, "alice");
        assert_eq!(event.content, "投喂 火箭 x2");
    }

    #[test]
    fn parse_chatmsg_preserves_stt_escapes() {
        let stt = "type@=chatmsg/nn@=a@Sb/txt@=加油@A主播@S冲啊/dms@=1/";
        let event = parse_stt_message(stt).expect("chat event");
        assert_eq!(event.user, "a/b");
        assert_eq!(event.content, "加油@主播/冲啊");
    }

    #[test]
    fn unescape_at() {
        assert_eq!(unescape_slash_at("a@Sb@Ac"), "a/b@c");
    }

    #[test]
    fn multi_packet_buffer() {
        let a = serialize_packet("type@=chatmsg/nn@=u1/txt@=a/dms@=1/");
        let b = serialize_packet("type@=chatmsg/nn@=u2/txt@=b/dms@=1/");
        let mut buf = a;
        buf.extend_from_slice(&b);
        let events = decode_binary(&buf);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].content, "a");
        assert_eq!(events[1].content, "b");
    }

    #[test]
    fn decode_binary_skips_uenter_without_dropping_useful_events() {
        let chat = serialize_packet("type@=chatmsg/nn@=u1/txt@=聊天/dms@=1/");
        let enter = serialize_packet("type@=uenter/nn@=路人/");
        let text_enter = serialize_packet("type@=chatmsg/nn@=路人/txt@=路人进入直播间/dms@=1/");
        let gift = serialize_packet("type@=odfbc/nn@=u2/gn@=荧光棒/hits@=4/");
        let mut buffer = chat;
        buffer.extend_from_slice(&enter);
        buffer.extend_from_slice(&text_enter);
        buffer.extend_from_slice(&gift);

        let events = decode_binary(&buffer);
        assert_eq!(events.len(), 2);
        assert!(matches!(events[0].kind, DanmakuKind::Chat));
        assert!(matches!(events[1].kind, DanmakuKind::Gift));
        assert_eq!(events[1].content, "投喂 荧光棒 x4");
    }

    #[test]
    fn packet_parser_accepts_server_packets_and_recovers_after_bad_header() {
        let mut corrupt = serialize_packet("type@=chatmsg/nn@=bad/txt@=bad/dms@=1/");
        // Duplicate length mismatch: this packet must be ignored rather than
        // allowing its body to be interpreted as a future header.
        corrupt[4] ^= 0x01;

        let mut valid = serialize_packet("type@=chatmsg/nn@=ok/txt@=仍可收到/dms@=1/");
        valid[8..10].copy_from_slice(&SERVER_TO_CLIENT.to_le_bytes());
        corrupt.extend_from_slice(&valid);

        let events = decode_binary(&corrupt);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].user, "ok");
        assert_eq!(events[0].content, "仍可收到");
    }

    #[test]
    fn packet_parser_rejects_bad_terminator_and_truncated_packets() {
        let mut bad_terminator = serialize_packet("type@=chatmsg/nn@=bad/txt@=bad/dms@=1/");
        *bad_terminator.last_mut().expect("packet terminator") = 1;
        let valid = serialize_packet("type@=chatmsg/nn@=ok/txt@=good/dms@=1/");
        bad_terminator.extend_from_slice(&valid);

        let events = decode_binary(&bad_terminator);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].content, "good");

        let truncated = &valid[..valid.len() - 1];
        assert!(decode_binary(truncated).is_empty());
    }

    #[test]
    fn packet_parser_rejects_non_plaintext_headers_and_resyncs() {
        let mut unsupported = serialize_packet("type@=chatmsg/nn@=bad/txt@=bad/dms@=1/");
        unsupported[10] = 1;
        let valid = serialize_packet("type@=chatmsg/nn@=ok/txt@=good/dms@=1/");
        unsupported.extend_from_slice(&valid);

        let events = decode_binary(&unsupported);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].content, "good");
    }
}
