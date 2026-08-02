//! Douyu danmaku — STT text over binary framing (simple_live `DouyuDanmaku`).
//!
//! WS: `wss://danmuproxy.douyu.com:8501..=8506`
//! Login / join / heartbeat are STT strings framed as little-endian packets.
//!
//! Note: Douyu's danmaku proxy ports only offer static-RSA AES-GCM ciphers, so
//! `None` here is always the native-tls connector (see
//! [`ASSERT_NATIVE_TLS_ENABLED`]).

use std::collections::BTreeSet;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::{
    SinkExt, StreamExt,
    stream::{SplitSink, SplitStream},
};
use md5::{Digest, Md5};
use reqwest::Url;
use serde::Deserialize;
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::{
    Connector, WebSocketStream, client_async_tls_with_config, connect_async_tls_with_config,
    tungstenite::Message,
};
use uuid::Uuid;

use crate::danmaku::reconnect::{Decision, DisconnectReason, ReconnectPolicy};
use crate::danmaku::{DanmakuEventSender, emit_event};
use crate::error::{AppError, AppResult};
use crate::models::live::{DanmakuEvent, DanmakuKind};

/// Fails to compile if tokio-tungstenite's `native-tls` feature is switched
/// off. Douyu's danmaku proxy ports offer only static-RSA AES-GCM ciphers that
/// rustls rejects, and with the feature disabled a `None` connector would
/// quietly resolve to rustls and fail every handshake. Referenced below so the
/// guard survives dead-code pruning.
const ASSERT_NATIVE_TLS_ENABLED: fn(&Connector) -> bool =
    |connector| matches!(connector, Connector::NativeTls(_));

/// Official proxy ports (simple_live uses 8506; rotate on failure).
const SERVER_PORTS: &[u16] = &[8506, 8505, 8504, 8503, 8502, 8501];
const CLIENT_TO_SERVER: u16 = 689;
const SERVER_TO_CLIENT: u16 = 690;
const HEARTBEAT_SECS: u64 = 45;
/// Values observed from the current first-party web room client. They are
/// protocol identifiers, not an rLive release version.
const LOGIN_PROTOCOL_VERSION: &str = "20220825";
const LOGIN_APP_VERSION: &str = "218101901";
const LOGIN_VK_SALT: &str = r#"r5*^5;}2#${XF[h+;'./.Q'1;,-]f'p["#;
const SEND_LOGIN_TIMEOUT: Duration = Duration::from_secs(8);
const SEND_RESULT_OBSERVE_TIMEOUT: Duration = Duration::from_secs(3);
const SEND_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_PROXY_RESPONSE_BYTES: usize = 16 * 1024;
const MAX_SEND_ENCRYPTION_TOKEN_BYTES: usize = 256;
const MAX_SEND_ENCRYPTION_KEY_VERSION_BYTES: usize = 64;
// The first-party client receives this number from a network response and
// performs one MD5 operation for every value. Keep an ample ceiling for a
// legitimate rotation while preventing a malformed response from turning an
// explicit one-message send into an unbounded CPU task.
const MAX_SEND_ENCRYPTION_ITERATIONS: u32 = 10_000;
/// A room may impose a shorter account-level limit. This client-side bound is
/// only a defensive ceiling for a manually composed plain-text message.
const MAX_OUTGOING_CHAT_UTF16_UNITS: usize = 100;
const SEND_PROXY_DISCOVERY_URL: &str = "https://www.douyu.com/swf_api/getProxyServer";
const SEND_ENCRYPTION_URL: &str = "https://www.douyu.com/wgapi/livenc/liveweb/websec/getEncryption";
const SEND_PROXY_HOST: &str = "wsproxy.douyu.com";
const SEND_PROXY_PORTS: &[u16] = &[6671, 6672, 6673, 6674, 6675];
const SEND_BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

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

/// The browser-cookie values that authenticate a current Douyu STT chat
/// session. The web client supplies both its account identity and its device
/// identity in the normal-chat packet; accepting only the historical login
/// trio makes a local preflight look ready while producing a packet the
/// gateway silently drops.
///
/// Do not derive `Debug`: callers must never accidentally put these values in
/// logs or a Tauri error payload. They are copied out of the local account
/// store only for the lifetime of an explicitly user-initiated send.
#[derive(Clone)]
struct DouyuSendCredentials {
    username: String,
    uid: String,
    stk: String,
    ltkid: String,
    did: String,
    biz: String,
    dmjwt: String,
}

#[derive(Debug, Clone, Copy)]
struct DouyuSendTimestamp {
    seconds: u64,
    milliseconds: u128,
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

/// Public key material used only for the short-lived gateway challenge. It
/// never contains the user's Cookie or JWT, but should still remain local:
/// exposing it would make future protocol changes unnecessarily easy to
/// fingerprint.
#[derive(Deserialize)]
struct SendEncryptionResponse {
    #[serde(default)]
    error: i64,
    #[serde(default)]
    data: Option<SendEncryptionData>,
}

#[derive(Deserialize)]
struct SendEncryptionData {
    rand_str: String,
    enc_time: u32,
    cpp: SendEncryptionCpp,
}

#[derive(Deserialize)]
struct SendEncryptionCpp {
    danmu: SendEncryptionDanmu,
}

#[derive(Deserialize)]
struct SendEncryptionDanmu {
    key_ver: String,
    key: String,
}

struct SendEncryptionKey {
    key_version: String,
    key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SendGatewayChallenge {
    nonce: String,
    iterations: u32,
}

/// Sanitised HTTP CONNECT configuration. Do not retain the source URL, which
/// might include proxy credentials and must never reach tracing output.
struct SendHttpProxy {
    host: String,
    port: u16,
    authorization: Option<String>,
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

fn numeric_cookie_value(value: String) -> Option<String> {
    (!value.is_empty() && value.len() <= 32 && value.bytes().all(|byte| byte.is_ascii_digit()))
        .then_some(value)
}

fn credentials_from_cookie(cookie: &str) -> Option<DouyuSendCredentials> {
    let username = cookie_value_any(cookie, &["acf_username"])?;
    let uid = cookie_value_any(cookie, &["acf_uid", "uid"])
        .or_else(|| {
            username
                .clone()
                .bytes()
                .all(|byte| byte.is_ascii_digit())
                .then_some(username.clone())
        })
        .and_then(numeric_cookie_value)?;
    let stk = cookie_value_any(cookie, &["acf_stk"])?;
    // Older browser sessions and some QR flows use an underscore-wrapped
    // spelling. Accept both forms so users can paste their complete Cookie
    // header without having to edit a token by hand.
    let ltkid = cookie_value_any(cookie, &["acf_ltkid", "_acf_ltkid_", "acf_ltkid_"])?;
    // Do not invent a device id. It is used by both the login checksum and
    // the outgoing `dy` field, and a per-request random value breaks the
    // browser session binding. `acf_devid` appears in newer exported Cookies;
    // `acf_did` / `dy_did` are produced by the web client itself.
    let did = cookie_value_any(cookie, &["acf_did", "dy_did", "acf_devid"])?;
    let biz = cookie_value_any(cookie, &["acf_biz"])?;
    // The normal chat session uses the DM-scoped token, not the general web
    // JWT. Do not fall back to `acf_jwt_token`: its audience differs.
    let dmjwt = cookie_value_any(cookie, &["acf_dmjwt_token", "dmjwt_token"])?;
    Some(DouyuSendCredentials {
        username,
        uid,
        stk,
        ltkid,
        did,
        biz,
        dmjwt,
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
    current_send_timestamp().map(|timestamp| timestamp.seconds)
}

fn current_send_timestamp() -> AppResult<DouyuSendTimestamp> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| DouyuSendTimestamp {
            seconds: duration.as_secs(),
            milliseconds: duration.as_millis(),
        })
        .map_err(|_| {
            AppError::new("douyu_send_clock", "系统时间异常，无法验证斗鱼登录状态")
                .with_site("douyu")
        })
}

fn login_request_body(room_id: &str, credentials: &DouyuSendCredentials, now: u64) -> String {
    let now = now.to_string();
    let vk_input = format!("{now}{LOGIN_VK_SALT}{}", credentials.did);
    let vk = format!("{:x}", Md5::digest(vk_input.as_bytes()));
    // Field order mirrors the current browser room client. The gateway is
    // tolerant of ordering in most cases, but preserving it keeps the
    // captured protocol contract reviewable and avoids relying on legacy
    // parser behaviour.
    encode_stt_fields(&[
        ("type", "loginreq"),
        ("roomid", room_id),
        ("dfl", ""),
        ("username", credentials.username.as_str()),
        ("password", ""),
        ("ltkid", credentials.ltkid.as_str()),
        ("biz", credentials.biz.as_str()),
        ("stk", credentials.stk.as_str()),
        ("devid", credentials.did.as_str()),
        ("ct", "0"),
        ("pt", "2"),
        ("cvr", "0"),
        ("tvr", "7"),
        ("apd", ""),
        ("jwt", credentials.dmjwt.as_str()),
        ("rt", now.as_str()),
        ("vk", vk.as_str()),
        ("ver", LOGIN_PROTOCOL_VERSION),
        ("aver", LOGIN_APP_VERSION),
        // Keep the advertised browser fields coherent with the User-Agent
        // header set below. They are not user-controlled fingerprint input.
        ("dmbt", "chrome"),
        ("dmbv", "126"),
    ])
}

fn chat_request_body(
    message: &str,
    credentials: &DouyuSendCredentials,
    timestamp: DouyuSendTimestamp,
) -> String {
    // This is the ordinary-text payload observed from the current web room
    // client. In particular, `dy`, `sender`, `tts`, and `cst` are part of the
    // account/device context for a normal message; the old receiver/scope/pid
    // shape is accepted at the TCP layer but may be silently discarded.
    let seconds = timestamp.seconds.to_string();
    let milliseconds = timestamp.milliseconds.to_string();
    encode_stt_fields(&[
        ("pe", "0"),
        ("content", message),
        ("col", "0"),
        ("type", "chatmessage"),
        ("dy", credentials.did.as_str()),
        ("sender", credentials.uid.as_str()),
        ("ifs", "0"),
        ("nc", "0"),
        ("dat", "0"),
        ("rev", "0"),
        ("tts", seconds.as_str()),
        ("admzq", "0"),
        ("cst", milliseconds.as_str()),
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
    let mut user_id = None;
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
            "uid" => user_id = Some(value),
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
    let user_id = user_id
        .map(decode_value)
        .filter(|value| !value.is_empty() && value != "0");
    let col = color
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);

    Some(DanmakuEvent {
        kind: DanmakuKind::Chat,
        user,
        is_self: false,
        user_id,
        content,
        color: color_from_col(col),
        spans: None,
        super_chat: None,
        ts: chrono::Utc::now().timestamp_millis(),
    })
}

fn parse_gift_message(stt: &str) -> DanmakuEvent {
    let mut user = None;
    let mut user_id = None;
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
            "uid" => user_id = Some(value),
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
    let user_id = user_id
        .map(decode_value)
        .filter(|value| !value.is_empty() && value != "0");
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
        is_self: false,
        user_id,
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

fn encryption_token(value: &str, max_len: usize) -> Option<String> {
    (!value.is_empty()
        && value.len() <= max_len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')))
    .then(|| value.to_owned())
}

fn encryption_key(value: &str) -> Option<String> {
    (!value.is_empty()
        && value.len() <= MAX_SEND_ENCRYPTION_TOKEN_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_graphic() && byte != b'/' && byte != b'@'))
    .then(|| value.to_owned())
}

fn validate_encryption_iterations(iterations: u32) -> Option<u32> {
    (iterations <= MAX_SEND_ENCRYPTION_ITERATIONS).then_some(iterations)
}

fn encryption_key_from_response(response: SendEncryptionResponse) -> AppResult<SendEncryptionKey> {
    if response.error != 0 {
        return Err(AppError::new(
            "douyu_send_encryption",
            "斗鱼弹幕认证参数暂时不可用，请稍后重试",
        )
        .with_site("douyu")
        .retryable());
    }
    let data = response.data.ok_or_else(|| {
        AppError::new("douyu_send_encryption", "斗鱼弹幕认证参数无效，请稍后重试")
            .with_site("douyu")
            .retryable()
    })?;

    // The first-party client primes its key cache by calculating a signature
    // with these two values before sending `livreq`. The initial signature is
    // not sent, but validating both values ensures this response has the same
    // bounded shape before we use its `cpp.danmu` key in the server challenge.
    if encryption_token(&data.rand_str, MAX_SEND_ENCRYPTION_TOKEN_BYTES).is_none()
        || validate_encryption_iterations(data.enc_time).is_none()
    {
        return Err(
            AppError::new("douyu_send_encryption", "斗鱼弹幕认证参数无效，请稍后重试")
                .with_site("douyu")
                .retryable(),
        );
    }

    let key_version = encryption_token(
        &data.cpp.danmu.key_ver,
        MAX_SEND_ENCRYPTION_KEY_VERSION_BYTES,
    )
    .ok_or_else(|| {
        AppError::new("douyu_send_encryption", "斗鱼弹幕认证参数无效，请稍后重试")
            .with_site("douyu")
            .retryable()
    })?;
    let key = encryption_key(&data.cpp.danmu.key).ok_or_else(|| {
        AppError::new("douyu_send_encryption", "斗鱼弹幕认证参数无效，请稍后重试")
            .with_site("douyu")
            .retryable()
    })?;
    Ok(SendEncryptionKey { key_version, key })
}

/// Obtain only the public, short-lived gateway challenge key. This endpoint
/// is deliberately requested without the user's Cookie: the official web
/// protocol derives it from the browser device id, while account
/// authentication remains inside the STT `loginreq` packet.
async fn fetch_send_encryption_key(
    proxy: Option<&str>,
    did: &str,
    room_id: &str,
    attempt_id: &Uuid,
) -> AppResult<SendEncryptionKey> {
    let mut url = Url::parse(SEND_ENCRYPTION_URL).expect("fixed Douyu encryption URL");
    url.query_pairs_mut().append_pair("did", did);
    let client = crate::http_client::build_no_redirect_client(proxy)?;
    let response = client
        .get(url)
        .header("Referer", "https://www.douyu.com/")
        .header("User-Agent", SEND_BROWSER_USER_AGENT)
        .send()
        .await
        .map_err(|_| {
            tracing::warn!(
                %attempt_id,
                room_id,
                stage = "encryption_request",
                "douyu send encryption request failed"
            );
            AppError::new(
                "douyu_send_encryption",
                "无法获取斗鱼弹幕认证参数，请稍后重试",
            )
            .with_site("douyu")
            .retryable()
        })?;
    if !response.status().is_success() {
        tracing::warn!(
            %attempt_id,
            room_id,
            stage = "encryption_response",
            status = response.status().as_u16(),
            "douyu send encryption endpoint returned a non-success status"
        );
        return Err(AppError::new(
            "douyu_send_encryption",
            "无法获取斗鱼弹幕认证参数，请稍后重试",
        )
        .with_site("douyu")
        .retryable());
    }
    let response = response
        .json::<SendEncryptionResponse>()
        .await
        .map_err(|_| {
            tracing::warn!(
                %attempt_id,
                room_id,
                stage = "encryption_parse",
                "douyu send encryption response could not be parsed"
            );
            AppError::new("douyu_send_encryption", "斗鱼弹幕认证参数无效，请稍后重试")
                .with_site("douyu")
                .retryable()
        })?;
    encryption_key_from_response(response).map_err(|error| {
        tracing::warn!(
            %attempt_id,
            room_id,
            stage = "encryption_validate",
            error_code = %error.code,
            "douyu send encryption response was rejected"
        );
        error
    })
}

fn md5_hex(value: impl AsRef<[u8]>) -> String {
    format!("{:x}", Md5::digest(value.as_ref()))
}

fn gateway_signature(
    room_id: &str,
    did: &str,
    timestamp_seconds: u64,
    challenge: &SendGatewayChallenge,
    key: &SendEncryptionKey,
) -> String {
    let mut value = challenge.nonce.clone();
    for _ in 0..challenge.iterations {
        value = md5_hex(format!("{value}{}", key.key));
    }
    md5_hex(format!(
        "{value}{}{room_id}{did}{timestamp_seconds}",
        key.key
    ))
}

fn gateway_challenge_request_body(key_version: &str) -> String {
    encode_stt_fields(&[
        ("type", "livreq"),
        ("alg_ver", "1.0"),
        ("key_ver", key_version),
    ])
}

fn gateway_signature_request_body(signature: &str, timestamp_seconds: u64) -> String {
    let timestamp_seconds = timestamp_seconds.to_string();
    encode_stt_fields(&[
        ("type", "lsigreq"),
        ("sig", signature),
        ("ts", timestamp_seconds.as_str()),
    ])
}

fn endpoint_host_and_port(url: &str) -> AppResult<(String, u16)> {
    let endpoint = Url::parse(url).map_err(|_| {
        AppError::new("douyu_send_network", "斗鱼发送服务器地址无效，请稍后重试")
            .with_site("douyu")
            .retryable()
    })?;
    let host = endpoint.host_str().ok_or_else(|| {
        AppError::new("douyu_send_network", "斗鱼发送服务器地址无效，请稍后重试")
            .with_site("douyu")
            .retryable()
    })?;
    let port = endpoint.port_or_known_default().ok_or_else(|| {
        AppError::new("douyu_send_network", "斗鱼发送服务器地址无效，请稍后重试")
            .with_site("douyu")
            .retryable()
    })?;
    Ok((host.to_owned(), port))
}

fn socket_address(host: &str, port: u16) -> String {
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

fn proxy_error(message: impl Into<String>) -> AppError {
    AppError::new("douyu_send_proxy", message).with_site("douyu")
}

fn proxy_connection_error(message: impl Into<String>) -> AppError {
    proxy_error(message).retryable()
}

/// Decode URL user-info without treating `+` as a space. Proxy credentials
/// belong to URL components rather than form data, and Basic authentication
/// below safely re-encodes the resulting bytes.
fn percent_decode_proxy_credential(value: &str) -> AppResult<Vec<u8>> {
    fn hex(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }

    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            decoded.push(bytes[index]);
            index += 1;
            continue;
        }
        let Some(high) = bytes.get(index + 1).and_then(|byte| hex(*byte)) else {
            return Err(proxy_error("斗鱼弹幕代理账号编码无效"));
        };
        let Some(low) = bytes.get(index + 2).and_then(|byte| hex(*byte)) else {
            return Err(proxy_error("斗鱼弹幕代理账号编码无效"));
        };
        decoded.push((high << 4) | low);
        index += 3;
    }
    Ok(decoded)
}

fn proxy_authorization(proxy: &Url) -> AppResult<Option<String>> {
    let username = proxy.username();
    let password = proxy.password();
    if username.is_empty() && password.is_none() {
        return Ok(None);
    }
    let password = password
        .ok_or_else(|| proxy_error("斗鱼弹幕代理账号需同时提供用户名和密码，或移除账号信息"))?;

    let mut credential = percent_decode_proxy_credential(username)?;
    credential.push(b':');
    credential.extend(percent_decode_proxy_credential(password)?);
    Ok(Some(STANDARD.encode(credential)))
}

/// Parse the same user-facing proxy setting as normal HTTP requests. The
/// websocket transport is an HTTP CONNECT tunnel, so SOCKS and HTTPS proxy
/// endpoints are rejected explicitly instead of silently bypassing the
/// setting. A scheme-less legacy `127.0.0.1:7890` value remains HTTP.
fn configured_http_proxy(proxy: Option<&str>) -> AppResult<Option<SendHttpProxy>> {
    let Some(raw) = proxy.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let normalized = if raw.contains("://") {
        raw.to_owned()
    } else {
        format!("http://{raw}")
    };
    let proxy = Url::parse(&normalized).map_err(|_| {
        AppError::new(
            "douyu_send_proxy_invalid",
            "斗鱼弹幕代理地址无效，请使用 HTTP 地址",
        )
        .with_site("douyu")
    })?;
    if proxy.scheme() != "http" {
        return Err(AppError::new(
            "douyu_send_proxy_unsupported",
            "斗鱼弹幕发送目前仅支持 HTTP 代理，请调整代理地址后重试",
        )
        .with_site("douyu"));
    }
    let host = proxy
        .host_str()
        .filter(|host| !host.is_empty())
        .ok_or_else(|| {
            AppError::new("douyu_send_proxy_invalid", "斗鱼弹幕代理地址缺少主机名")
                .with_site("douyu")
        })?
        .to_owned();
    if !matches!(proxy.path(), "" | "/") || proxy.query().is_some() || proxy.fragment().is_some() {
        return Err(AppError::new(
            "douyu_send_proxy_invalid",
            "斗鱼弹幕代理地址不能包含路径、查询参数或片段",
        )
        .with_site("douyu"));
    }
    let port = proxy.port_or_known_default().ok_or_else(|| {
        AppError::new("douyu_send_proxy_invalid", "斗鱼弹幕代理地址缺少端口").with_site("douyu")
    })?;
    Ok(Some(SendHttpProxy {
        host,
        port,
        authorization: proxy_authorization(&proxy)?,
    }))
}

async fn open_send_tcp(address: String) -> AppResult<TcpStream> {
    let stream = time::timeout(SEND_CONNECT_TIMEOUT, TcpStream::connect(address))
        .await
        .map_err(|_| {
            AppError::new("douyu_send_network", "连接斗鱼发送服务器超时，请稍后重试")
                .with_site("douyu")
                .retryable()
        })?
        .map_err(|_| {
            AppError::new("douyu_send_network", "无法连接斗鱼发送服务器，请稍后重试")
                .with_site("douyu")
                .retryable()
        })?;
    let _ = stream.set_nodelay(true);
    Ok(stream)
}

fn http_connect_request(proxy: &SendHttpProxy, target: &str) -> Vec<u8> {
    let mut request =
        format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\nProxy-Connection: Keep-Alive\r\n");
    if let Some(credential) = &proxy.authorization {
        request.push_str("Proxy-Authorization: Basic ");
        request.push_str(credential);
        request.push_str("\r\n");
    }
    request.push_str("\r\n");
    request.into_bytes()
}

fn parse_http_connect_response(response: &[u8]) -> AppResult<()> {
    let response = std::str::from_utf8(response).map_err(|_| {
        AppError::new("douyu_send_proxy", "代理返回了无效响应")
            .with_site("douyu")
            .retryable()
    })?;
    let status = response.lines().next().unwrap_or_default();
    let code = status
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok());
    if !status.starts_with("HTTP/") || code != Some(200) {
        return Err(AppError::new(
            "douyu_send_proxy",
            "代理拒绝连接斗鱼弹幕服务器，请检查代理设置",
        )
        .with_site("douyu")
        .retryable());
    }
    Ok(())
}

async fn connect_via_http_proxy(
    proxy: &SendHttpProxy,
    target_host: &str,
    target_port: u16,
) -> AppResult<TcpStream> {
    let mut stream = open_send_tcp(socket_address(&proxy.host, proxy.port)).await?;
    let target = socket_address(target_host, target_port);
    stream
        .write_all(&http_connect_request(proxy, &target))
        .await
        .map_err(|_| proxy_connection_error("无法向代理建立斗鱼弹幕连接"))?;
    stream
        .flush()
        .await
        .map_err(|_| proxy_connection_error("无法向代理建立斗鱼弹幕连接"))?;

    let mut response = Vec::with_capacity(1024);
    let mut buffer = [0_u8; 1024];
    let header_end = loop {
        if response.len() >= MAX_PROXY_RESPONSE_BYTES {
            return Err(proxy_connection_error("代理响应过长，无法建立弹幕连接"));
        }
        let read = time::timeout(SEND_CONNECT_TIMEOUT, stream.read(&mut buffer))
            .await
            .map_err(|_| proxy_connection_error("等待代理连接响应超时"))?
            .map_err(|_| proxy_connection_error("读取代理连接响应失败"))?;
        if read == 0 {
            return Err(proxy_connection_error("代理在建立连接前关闭"));
        }
        response.extend_from_slice(&buffer[..read]);
        if let Some(index) = response.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
    };
    // A CONNECT peer cannot legitimately send tunneled TLS data before this
    // client starts the TLS handshake. Refuse an ambiguous response instead
    // of silently dropping bytes that TLS would need to inspect.
    if response.len() != header_end {
        return Err(proxy_connection_error("代理连接响应格式异常"));
    }
    parse_http_connect_response(&response)?;
    Ok(stream)
}

async fn connect_douyu_send_ws(
    proxy: Option<&str>,
    room_id: &str,
    attempt_id: &Uuid,
) -> AppResult<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
> {
    let proxy_config = configured_http_proxy(proxy)?;
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
        if let Ok(value) = HeaderValue::from_str(SEND_BROWSER_USER_AGENT) {
            headers.insert("User-Agent", value);
        }
        let (host, port) = match endpoint_host_and_port(&url) {
            Ok(target) => target,
            Err(error) => {
                tracing::warn!(
                    %attempt_id,
                    room_id,
                    endpoint = %url,
                    stage = "server_target",
                    error_code = %error.code,
                    "douyu send websocket target was invalid"
                );
                continue;
            }
        };
        let socket = match proxy_config.as_ref() {
            Some(proxy) => connect_via_http_proxy(proxy, &host, port).await,
            None => open_send_tcp(socket_address(&host, port)).await,
        };
        let socket = match socket {
            Ok(socket) => socket,
            Err(error) => {
                tracing::warn!(
                    %attempt_id,
                    room_id,
                    endpoint = %url,
                    stage = "server_transport",
                    error_code = %error.code,
                    "douyu send websocket transport connect failed"
                );
                continue;
            }
        };
        match client_async_tls_with_config(request, socket, None, None).await {
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
        if let Ok(v) = HeaderValue::from_str(SEND_BROWSER_USER_AGENT) {
            headers.insert("User-Agent", v);
        }
        // Do NOT offer a `Sec-WebSocket-Protocol` subprotocol here: the danmaku
        // proxy never echoes one back, and tungstenite (RFC 6455) then rejects
        // the handshake with `SecWebSocketSubProtocolError::NoSubProtocol`.
        let _ = ASSERT_NATIVE_TLS_ENABLED;
        match connect_async_tls_with_config(req, None, false, None).await {
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

#[derive(Debug, Clone, PartialEq, Eq)]
enum SendGatewayReply {
    Login { user_id: Option<String> },
    EncryptionChallenge(SendGatewayChallenge),
    EncryptionChallengeInvalid,
    ChatAccepted,
    ChatSubmitted,
    Rejected(Option<String>),
}

fn safe_gateway_code(stt: &str) -> Option<String> {
    // `chatres` reports its result in `res`; `error` packets normally use
    // `code`. Keep `res` first so a bundled rejection cannot be mistaken for
    // a successful chat acknowledgement merely because it has no `code`.
    ["res", "code", "ec", "err"]
        .iter()
        .find_map(|key| stt_field(stt, key))
        .map(str::trim)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
        })
        .map(str::to_owned)
}

fn gateway_login_user_id(stt: &str) -> Option<String> {
    stt_field(stt, "userid")
        .or_else(|| stt_field(stt, "uid"))
        .map(str::trim)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 32
                && value.bytes().all(|byte| byte.is_ascii_digit())
        })
        .map(str::to_owned)
}

fn gateway_challenge_from_stt(stt: &str) -> Option<SendGatewayChallenge> {
    let nonce = encryption_token(stt_field(stt, "nonce")?, MAX_SEND_ENCRYPTION_TOKEN_BYTES)?;
    let iterations = stt_field(stt, "its")?
        .parse::<u32>()
        .ok()
        .and_then(validate_encryption_iterations)?;
    Some(SendGatewayChallenge { nonce, iterations })
}

fn send_gateway_reply_from_stt(stt: &str) -> Option<SendGatewayReply> {
    match stt_type(stt)? {
        "loginres" => Some(SendGatewayReply::Login {
            user_id: gateway_login_user_id(stt),
        }),
        "livres" => Some(
            gateway_challenge_from_stt(stt)
                .map(SendGatewayReply::EncryptionChallenge)
                .unwrap_or(SendGatewayReply::EncryptionChallengeInvalid),
        ),
        "error" => Some(SendGatewayReply::Rejected(safe_gateway_code(stt))),
        // The business gateway confirms an ordinary-text submission with a
        // `chatres` packet. Only `res=0` is a positive confirmation. A
        // packet that omits `res` means the socket has seen a related update,
        // not that the platform accepted the message.
        "chatres" => match stt_field(stt, "res").map(str::trim) {
            Some("0") => Some(SendGatewayReply::ChatAccepted),
            Some(_) => Some(SendGatewayReply::Rejected(safe_gateway_code(stt))),
            None => Some(SendGatewayReply::ChatSubmitted),
        },
        _ => None,
    }
}

fn send_gateway_reply_from_binary(data: &[u8]) -> Option<SendGatewayReply> {
    let mut reply = None;
    for_each_packet(data, |stt| {
        let Some(candidate) = send_gateway_reply_from_stt(stt) else {
            return;
        };
        // The proxy can bundle several STT packets into one WebSocket frame.
        // A terminal rejection must win over an earlier positive-looking
        // packet in the same frame so the client never reports a false send.
        let terminal = matches!(
            &candidate,
            SendGatewayReply::Rejected(_) | SendGatewayReply::EncryptionChallengeInvalid
        );
        if terminal {
            reply = Some(candidate);
        } else if reply.is_none() {
            reply = Some(candidate);
        }
    });
    reply
}

async fn next_send_gateway_reply<S>(
    write: &mut SplitSink<WebSocketStream<S>, Message>,
    read: &mut SplitStream<WebSocketStream<S>>,
    room_id: &str,
    attempt_id: &Uuid,
    stage: &'static str,
) -> AppResult<SendGatewayReply>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    loop {
        let frame = match read.next().await {
            Some(Ok(frame)) => frame,
            Some(Err(error)) => {
                tracing::warn!(
                    %attempt_id,
                    room_id,
                    stage,
                    error = %error,
                    "douyu send gateway response read failed"
                );
                return Err(AppError::new(
                    "douyu_send_network",
                    "斗鱼弹幕服务器连接中断，请稍后重试",
                )
                .with_site("douyu")
                .retryable());
            }
            None => {
                tracing::warn!(
                    %attempt_id,
                    room_id,
                    stage,
                    "douyu send gateway websocket closed before a response"
                );
                return Err(AppError::new(
                    "douyu_send_network",
                    "斗鱼弹幕服务器连接中断，请稍后重试",
                )
                .with_site("douyu")
                .retryable());
            }
        };
        let reply = match frame {
            Message::Binary(data) => send_gateway_reply_from_binary(&data),
            Message::Text(text) => send_gateway_reply_from_stt(text.as_str()),
            Message::Ping(payload) => {
                write.send(Message::Pong(payload)).await.map_err(|error| {
                    tracing::warn!(
                        %attempt_id,
                        room_id,
                        stage,
                        error = %error,
                        "douyu send gateway ping response failed"
                    );
                    AppError::new("douyu_send_network", "斗鱼弹幕服务器连接中断，请稍后重试")
                        .with_site("douyu")
                        .retryable()
                })?;
                None
            }
            Message::Close(frame) => {
                tracing::warn!(
                    %attempt_id,
                    room_id,
                    stage,
                    close_frame = frame.is_some(),
                    "douyu send gateway websocket closed"
                );
                return Err(AppError::new(
                    "douyu_send_network",
                    "斗鱼弹幕服务器连接中断，请稍后重试",
                )
                .with_site("douyu")
                .retryable());
            }
            _ => None,
        };
        if let Some(reply) = reply {
            return Ok(reply);
        }
    }
}

async fn wait_for_send_gateway_reply<S, F>(
    write: &mut SplitSink<WebSocketStream<S>, Message>,
    read: &mut SplitStream<WebSocketStream<S>>,
    room_id: &str,
    attempt_id: &Uuid,
    stage: &'static str,
    mut matches_stage: F,
) -> AppResult<SendGatewayReply>
where
    S: AsyncRead + AsyncWrite + Unpin,
    F: FnMut(&SendGatewayReply) -> bool,
{
    loop {
        let reply = next_send_gateway_reply(write, read, room_id, attempt_id, stage).await?;
        let terminal = matches!(
            &reply,
            SendGatewayReply::Rejected(_) | SendGatewayReply::EncryptionChallengeInvalid
        );
        if terminal || matches_stage(&reply) {
            return Ok(reply);
        }
    }
}

fn authentication_rejected_error(stage: &'static str) -> AppError {
    let (code, message) = match stage {
        "login" => (
            "douyu_send_login_rejected",
            "斗鱼登录状态已失效，请重新扫码或更新 Cookie 后重试",
        ),
        _ => (
            "douyu_send_auth_rejected",
            "斗鱼弹幕认证被拒绝，请更新 Cookie 后重试",
        ),
    };
    AppError::new(code, message).with_site("douyu")
}

fn send_unknown_error() -> AppError {
    // Do not mark this retryable. The WebSocket write may already have
    // reached Douyu, so automatic or reflexive retry would risk duplicates.
    AppError::new(
        "douyu_send_unknown",
        "发送请求已提交，但未收到斗鱼确认；请到直播间确认是否显示",
    )
    .with_site("douyu")
}

/// Authenticate a short-lived websocket session and submit one ordinary
/// Douyu chat message.
///
/// There is intentionally no automatic retry and no optimistic local event.
/// A write is only reported as successful after `chatres(res=0)`; after any
/// post-write uncertainty the caller receives an explicit unknown state so it
/// cannot accidentally duplicate a message by retrying in the background.
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
            "请先在设置中扫码登录或保存包含账号、设备和弹幕令牌字段的斗鱼 Cookie",
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
            return Err(error);
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
    let login_reply = match time::timeout(
        SEND_LOGIN_TIMEOUT,
        wait_for_send_gateway_reply(
            &mut write,
            &mut read,
            room_id,
            &attempt_id,
            "login",
            |reply| matches!(reply, SendGatewayReply::Login { .. }),
        ),
    )
    .await
    {
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
    };
    match &login_reply {
        SendGatewayReply::Login {
            user_id: Some(user_id),
        } if user_id == &credentials.uid => {}
        SendGatewayReply::Login { .. } | SendGatewayReply::Rejected(_) => {
            let gateway_code = match &login_reply {
                SendGatewayReply::Rejected(Some(code)) => code.as_str(),
                _ => "unknown",
            };
            tracing::warn!(
                %attempt_id,
                room_id,
                stage = "login_response",
                gateway_code,
                "douyu send login was not authenticated as the Cookie account"
            );
            return Err(authentication_rejected_error("login"));
        }
        SendGatewayReply::EncryptionChallengeInvalid => {
            return Err(
                AppError::new("douyu_send_encryption", "斗鱼弹幕认证挑战无效，请稍后重试")
                    .with_site("douyu")
                    .retryable(),
            );
        }
        _ => {
            return Err(AppError::new(
                "douyu_send_login_timeout",
                "斗鱼登录确认异常，请检查 Cookie 后重试",
            )
            .with_site("douyu")
            .retryable());
        }
    }

    // Current web rooms require this challenge after `loginres`. Fetching the
    // public key intentionally omits Cookie headers; the account session has
    // already been authenticated inside the STT login packet above.
    let encryption =
        fetch_send_encryption_key(proxy, &credentials.did, room_id, &attempt_id).await?;
    write
        .send(Message::Binary(
            serialize_packet(&gateway_challenge_request_body(&encryption.key_version)).into(),
        ))
        .await
        .map_err(|error| {
            tracing::warn!(
                %attempt_id,
                room_id,
                stage = "livreq_write",
                error = %error,
                "douyu send encryption challenge request write failed"
            );
            AppError::new("douyu_send_network", "斗鱼弹幕认证连接中断，请稍后重试")
                .with_site("douyu")
                .retryable()
        })?;
    let challenge_reply = match time::timeout(
        SEND_LOGIN_TIMEOUT,
        wait_for_send_gateway_reply(
            &mut write,
            &mut read,
            room_id,
            &attempt_id,
            "encryption_challenge",
            |reply| matches!(reply, SendGatewayReply::EncryptionChallenge(_)),
        ),
    )
    .await
    {
        Ok(result) => result?,
        Err(_) => {
            tracing::warn!(
                %attempt_id,
                room_id,
                stage = "encryption_challenge_timeout",
                timeout_seconds = SEND_LOGIN_TIMEOUT.as_secs(),
                "douyu send encryption challenge timed out"
            );
            return Err(AppError::new(
                "douyu_send_encryption_timeout",
                "斗鱼弹幕认证确认超时，请稍后重试",
            )
            .with_site("douyu")
            .retryable());
        }
    };
    let challenge = match challenge_reply {
        SendGatewayReply::EncryptionChallenge(challenge) => challenge,
        SendGatewayReply::Rejected(code) => {
            tracing::warn!(
                %attempt_id,
                room_id,
                stage = "encryption_challenge_response",
                gateway_code = code.as_deref().unwrap_or("unknown"),
                "douyu send encryption challenge was rejected"
            );
            return Err(authentication_rejected_error("encryption"));
        }
        SendGatewayReply::EncryptionChallengeInvalid => {
            return Err(
                AppError::new("douyu_send_encryption", "斗鱼弹幕认证挑战无效，请稍后重试")
                    .with_site("douyu")
                    .retryable(),
            );
        }
        _ => {
            return Err(
                AppError::new("douyu_send_encryption", "斗鱼弹幕认证确认异常，请稍后重试")
                    .with_site("douyu")
                    .retryable(),
            );
        }
    };
    let signature_timestamp = current_unix_seconds()?;
    let signature = gateway_signature(
        room_id,
        &credentials.did,
        signature_timestamp,
        &challenge,
        &encryption,
    );
    write
        .send(Message::Binary(
            serialize_packet(&gateway_signature_request_body(
                &signature,
                signature_timestamp,
            ))
            .into(),
        ))
        .await
        .map_err(|error| {
            tracing::warn!(
                %attempt_id,
                room_id,
                stage = "lsigreq_write",
                error = %error,
                "douyu send encryption signature write failed"
            );
            AppError::new("douyu_send_network", "斗鱼弹幕认证连接中断，请稍后重试")
                .with_site("douyu")
                .retryable()
        })?;

    // `send` flushes the complete WebSocket frame. Do not automatically retry
    // after this point: the platform may have accepted the message even if a
    // later read fails.
    let chat_timestamp = current_send_timestamp()?;
    write
        .send(Message::Binary(
            serialize_packet(&chat_request_body(&message, &credentials, chat_timestamp)).into(),
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
            send_unknown_error()
        })?;

    match time::timeout(
        SEND_RESULT_OBSERVE_TIMEOUT,
        wait_for_send_gateway_reply(
            &mut write,
            &mut read,
            room_id,
            &attempt_id,
            "chat_result",
            |reply| matches!(reply, SendGatewayReply::ChatAccepted),
        ),
    )
    .await
    {
        Ok(Ok(SendGatewayReply::ChatAccepted)) => Ok(()),
        Ok(Ok(SendGatewayReply::Rejected(code))) => {
            tracing::warn!(
                %attempt_id,
                room_id,
                stage = "chat_result",
                gateway_code = code.as_deref().unwrap_or("unknown"),
                "douyu rejected a chat submission"
            );
            Err(AppError::new(
                "douyu_send_rejected",
                "斗鱼拒绝了该弹幕，可能受禁言、频率或直播间限制",
            )
            .with_site("douyu"))
        }
        Ok(Ok(_)) | Ok(Err(_)) | Err(_) => {
            tracing::warn!(
                %attempt_id,
                room_id,
                stage = "chat_result_unknown",
                timeout_millis = SEND_RESULT_OBSERVE_TIMEOUT.as_millis(),
                "douyu chat submission was written without a confirmed result"
            );
            Err(send_unknown_error())
        }
    }
}

fn emit_system(events: &DanmakuEventSender, content: impl Into<String>) {
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

pub async fn run_loop(events: DanmakuEventSender, args: DouyuDanmakuArgs) -> AppResult<()> {
    let mut policy = ReconnectPolicy::with_defaults("douyu");
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

async fn run_connection_once(
    events: &DanmakuEventSender,
    args: &DouyuDanmakuArgs,
) -> DisconnectReason {
    match connect_and_read(events, args).await {
        Ok(reason) => reason,
        // Every read-path error here is a dial or transport failure, so it maps
        // to a transient reason; the policy decides when the streak ends.
        Err(error) => DisconnectReason::transient(error.message),
    }
}

async fn connect_and_read(
    events: &DanmakuEventSender,
    args: &DouyuDanmakuArgs,
) -> Result<DisconnectReason, AppError> {
    emit_event(
        events,
        DanmakuEvent {
            kind: DanmakuKind::System,
            user: "system".into(),
            is_self: false,
            user_id: None,
            content: "正在连接弹幕服务器…".into(),
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
        events,
        DanmakuEvent {
            kind: DanmakuKind::System,
            user: "system".into(),
            is_self: false,
            user_id: None,
            content: "弹幕服务器连接成功".into(),
            color: None,
            spans: None,
            super_chat: None,
            ts: chrono::Utc::now().timestamp_millis(),
        },
    );

    let connected_at = Instant::now();
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
                            emit_event(events, ev);
                        });
                    }
                    Some(Ok(Message::Text(text))) => {
                        // Some proxies may deliver text; try STT parse directly.
                        if let Some(ev) = parse_stt_message(text.as_str()) {
                            msg_count += 1;
                            emit_event(events, ev);
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

    Ok(DisconnectReason::Dropped {
        messages: msg_count,
        connected_for: connected_at.elapsed(),
    })
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
        assert!(!has_send_credentials(
            "acf_username=viewer; acf_uid=42; acf_stk=session; acf_ltkid=login; acf_devid=device; acf_biz=1"
        ));
        assert!(!has_send_credentials(
            "acf_username=viewer; acf_stk=session; acf_ltkid=login; acf_devid=device; acf_biz=1; acf_dmjwt_token=token"
        ));
        assert!(has_send_credentials(
            "acf_username=viewer; acf_uid=42; acf_stk=session; acf_ltkid=login; acf_devid=device; acf_dmjwt_token=token; acf_biz=1"
        ));
        let credentials = credentials_from_cookie(
            "Cookie: acf_username=42; acf_stk=session; _acf_ltkid_=legacy-login; acf_did=device; acf_dmjwt_token=token; acf_biz=1",
        )
        .expect("complete legacy cookie");
        assert_eq!(credentials.uid, "42");
        assert_eq!(credentials.did, "device");
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
        let credentials = DouyuSendCredentials {
            username: "u/name@site".into(),
            uid: "42".into(),
            stk: "stk/value".into(),
            ltkid: "login@key".into(),
            did: "device".into(),
            biz: "1".into(),
            dmjwt: "dm/jwt".into(),
        };
        let body = chat_request_body(
            "@主播/冲啊",
            &credentials,
            DouyuSendTimestamp {
                seconds: 1_700_000_000,
                milliseconds: 1_700_000_000_123,
            },
        );
        assert!(body.starts_with("pe@=0/content@=@A主播@S冲啊/col@=0/type@=chatmessage/"));
        assert!(body.contains("dy@=device/"));
        assert!(body.contains("sender@=42/"));
        assert!(body.contains("tts@=1700000000/"));
        assert!(body.contains("cst@=1700000000123/"));

        let login = login_request_body("123", &credentials, 1_700_000_000);
        assert!(login.starts_with("type@=loginreq/roomid@=123/dfl@=/username@=u@Sname@Asite/"));
        assert!(login.contains("stk@=stk@Svalue/"));
        assert!(login.contains("ltkid@=login@Akey/"));
        assert!(login.contains("jwt@=dm@Sjwt/"));
        assert!(login.contains("vk@="));
    }

    #[test]
    fn gateway_replies_require_the_cookie_account_and_chatres_res_zero() {
        let login = serialize_packet("type@=loginres/userid@=42/username@=viewer/");
        assert_eq!(
            send_gateway_reply_from_binary(&login),
            Some(SendGatewayReply::Login {
                user_id: Some("42".into())
            })
        );
        assert_eq!(
            send_gateway_reply_from_stt("type@=loginres/userid@=anonymous/"),
            Some(SendGatewayReply::Login { user_id: None })
        );
        assert_eq!(
            send_gateway_reply_from_stt("type@=chatres/res@=0/cd@=1/"),
            Some(SendGatewayReply::ChatAccepted)
        );
        assert_eq!(
            send_gateway_reply_from_stt("type@=chatres/res@=308/cd@=1/"),
            Some(SendGatewayReply::Rejected(Some("308".into())))
        );
        assert_eq!(
            send_gateway_reply_from_stt("type@=chatres/cd@=1/"),
            Some(SendGatewayReply::ChatSubmitted)
        );
    }

    #[test]
    fn gateway_challenge_and_rejections_are_parsed_without_raw_packet_data() {
        assert_eq!(
            send_gateway_reply_from_stt("type@=livres/nonce@=nonce_123/its@=2/"),
            Some(SendGatewayReply::EncryptionChallenge(
                SendGatewayChallenge {
                    nonce: "nonce_123".into(),
                    iterations: 2,
                }
            ))
        );
        assert_eq!(
            send_gateway_reply_from_stt("type@=livres/nonce@=nonce/its@=10001/"),
            Some(SendGatewayReply::EncryptionChallengeInvalid)
        );

        let accepted = serialize_packet("type@=chatres/res@=0/");
        let rejected = serialize_packet("type@=error/code@=59/");
        let mut bundled = accepted;
        bundled.extend(rejected);
        assert_eq!(
            send_gateway_reply_from_binary(&bundled),
            Some(SendGatewayReply::Rejected(Some("59".into())))
        );
    }

    #[test]
    fn gateway_signature_matches_the_web_client_algorithm() {
        let signature = gateway_signature(
            "123",
            "device",
            1_700_000_000,
            &SendGatewayChallenge {
                nonce: "nonce".into(),
                iterations: 2,
            },
            &SendEncryptionKey {
                key_version: "1.0".into(),
                key: "key".into(),
            },
        );
        assert_eq!(signature, "6d1bb79d38efa8dbb401e167f9cafaa3");
        assert_eq!(
            gateway_challenge_request_body("1.0"),
            "type@=livreq/alg_ver@=1.0/key_ver@=1.0/"
        );
        assert_eq!(
            gateway_signature_request_body("abc", 1_700_000_000),
            "type@=lsigreq/sig@=abc/ts@=1700000000/"
        );
    }

    #[test]
    fn encryption_response_is_validated_before_the_gateway_challenge() {
        let response: SendEncryptionResponse = serde_json::from_value(serde_json::json!({
            "error": 0,
            "data": {
                "rand_str": "seed",
                "enc_time": 1,
                "cpp": { "danmu": { "key_ver": "1.0", "key": "key" } }
            }
        }))
        .unwrap();
        let key = encryption_key_from_response(response).unwrap();
        assert_eq!(key.key_version, "1.0");
        assert_eq!(key.key, "key");

        let invalid: SendEncryptionResponse = serde_json::from_value(serde_json::json!({
            "error": 0,
            "data": {
                "rand_str": "seed",
                "enc_time": 10001,
                "cpp": { "danmu": { "key_ver": "1.0", "key": "key" } }
            }
        }))
        .unwrap();
        let error = match encryption_key_from_response(invalid) {
            Err(error) => error,
            Ok(_) => panic!("oversized encryption iteration count must be rejected"),
        };
        assert_eq!(error.code, "douyu_send_encryption");
    }

    #[test]
    fn send_proxy_accepts_legacy_http_settings_without_leaking_credentials() {
        let proxy = configured_http_proxy(Some("user:pa%3Ass@127.0.0.1:7890"))
            .unwrap()
            .expect("proxy");
        assert_eq!(proxy.host, "127.0.0.1");
        assert_eq!(proxy.port, 7890);
        let request =
            String::from_utf8(http_connect_request(&proxy, "wsproxy.douyu.com:6671")).unwrap();
        assert!(request.starts_with("CONNECT wsproxy.douyu.com:6671 HTTP/1.1\r\n"));
        assert!(request.contains("Proxy-Authorization: Basic dXNlcjpwYTpzcw==\r\n"));
        assert!(configured_http_proxy(Some("https://127.0.0.1:7890")).is_err());
        assert!(configured_http_proxy(Some("http://127.0.0.1:7890/path")).is_err());
    }

    #[test]
    fn parse_chatmsg() {
        let stt = "type@=chatmsg/nn@=alice/uid@=42/txt@=hello world/col@=1/dms@=5/";
        let ev = parse_stt_message(stt).unwrap();
        assert_eq!(ev.user, "alice");
        assert_eq!(ev.user_id.as_deref(), Some("42"));
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
