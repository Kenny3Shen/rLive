//! Huya danmaku — TARS binary over WebSocket (simple_live `HuyaDanmaku`).
//!
//! WS: `wss://cdnws.api.huya.com`
//! Join packet encodes ayyuid + channel ids; chat push uri=1400.
//! Reconnects follow the shared [`crate::danmu_rs::reconnect`] policy, which
//! stops once the endpoint stops looking recoverable.

use std::time::{Duration, Instant};

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use md5::{Digest, Md5};
use serde_json::Value;
use tokio::time;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest, http::HeaderValue},
};
use uuid::Uuid;

use crate::danmu_rs::reconnect::{Decision, DisconnectReason, ReconnectPolicy};
use crate::danmu_rs::tars::{TarsReader, TarsWriter, decode_wup_v3, encode_wup_v3};
use crate::danmu_rs::{DanmakuEventSender, emit_event};
use crate::error::{AppError, AppResult};
use crate::models::live::{DanmakuEvent, DanmakuKind};
/// simple_live heartbeat payload: base64 `ABQdAAwsNgBM`
const SERVER_URL: &str = "wss://cdnws.api.huya.com";
const HEARTBEAT_SECS: u64 = 60;
/// simple_live heartbeat payload: base64 `ABQdAAwsNgBM`
const HEARTBEAT_B64: &str = "ABQdAAwsNgBM";

// The authenticated web signal service is separate from the anonymous room
// subscription endpoint above. Do not reuse a receive connection for a
// user-initiated write: it deliberately has no browser Cookie attached.
const SEND_SERVER_URLS: &[&str] = &["wss://wsapi.huya.com/", "wss://cdnws.api.huya.com/"];
const SEND_RESPONSE_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_OUTGOING_CHAT_UTF16_UNITS: usize = 30;
const MAX_COOKIE_LEN: usize = 16 * 1024;
const HUYA_APP_SOURCE: &str = "HUYA&ZH&2052";
// This is Huya Signal's protocol UA, not the HTTP User-Agent header. The web
// client carries it in `WSConnectParaInfo`, `WSVerifyCookieReq`, and `UserId`.
// The official web player currently advertises its H5-player build here.
// `webh5&2.26.0&websocket` was retired long ago; the signal gateway uses
// this value together with the Cookie carried in WSConnectParaInfo to decide
// whether a browser session may issue write requests.
const HUYA_SIGNAL_UA: &str = "webh5&2607101000&websocket";
const HUYA_HTTP_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const WS_CMD_WUP_REQUEST: i64 = 3;
const WS_CMD_WUP_RESPONSE: i64 = 4;
const WS_CMD_VERIFY_COOKIE_REQUEST: i64 = 10;
const WS_CMD_VERIFY_COOKIE_RESPONSE: i64 = 11;

#[derive(Debug, Clone)]
pub struct HuyaDanmakuArgs {
    pub ayyuid: i64,
    pub top_sid: i64,
    pub sub_sid: i64,
    /// The broadcaster id used as `lPid` by `HUYA.SendMessageReq`.
    pub presenter_id: i64,
}

fn json_i64(v: &Value) -> Option<i64> {
    v.as_i64()
        .or_else(|| v.as_u64().map(|u| u as i64))
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

pub fn args_from_raw(_room_id: &str, raw: &Value) -> AppResult<HuyaDanmakuArgs> {
    let ayyuid = raw
        .get("ayyuid")
        .and_then(json_i64)
        .or_else(|| raw.get("lYyid").and_then(json_i64))
        .unwrap_or(0);
    let mut top_sid = raw.get("topSid").and_then(json_i64).unwrap_or(0);
    let mut sub_sid = raw.get("subSid").and_then(json_i64).unwrap_or(0);

    // Fallback: retain channel IDs alongside each parsed stream line. A
    // presenter's uid (`lPid`) is not interchangeable with a channel id.
    if top_sid == 0
        && let Some(lines) = raw.get("lines").and_then(|v| v.as_array())
    {
        for line in lines {
            if let Some(channel) = line
                .get("topSid")
                .or_else(|| line.get("lChannelId"))
                .and_then(json_i64)
                && channel > 0
            {
                top_sid = channel;
                break;
            }
        }
    }
    if sub_sid == 0 {
        if let Some(lines) = raw.get("lines").and_then(|v| v.as_array()) {
            for line in lines {
                if let Some(channel) = line
                    .get("subSid")
                    .or_else(|| line.get("lSubChannelId"))
                    .and_then(json_i64)
                    && channel > 0
                {
                    sub_sid = channel;
                    break;
                }
            }
        }
        if sub_sid == 0 {
            sub_sid = top_sid;
        }
    }
    // A public profile/short room id is not a signal channel id.  Sending it
    // as lTid/lSid can target a different room while appearing locally valid.
    // The room resolver is responsible for supplying canonical IDs (including
    // the documented offline-room presenter fallback) before we reach here.
    if top_sid <= 0 || sub_sid <= 0 {
        return Err(AppError::new(
            "danmaku_bad_room",
            "huya danmaku missing canonical channel ids (room raw incomplete)",
        )
        .with_site("huya"));
    }

    let presenter_id = raw
        .get("presenterUid")
        .and_then(json_i64)
        .or_else(|| raw.get("lp").and_then(json_i64))
        .or_else(|| raw.get("presenter_id").and_then(json_i64))
        .or_else(|| {
            raw.get("lines")
                .and_then(|value| value.as_array())
                .and_then(|lines| lines.first())
                .and_then(|line| line.get("presenterUid"))
                .and_then(json_i64)
        })
        .filter(|id| *id > 0)
        .unwrap_or(top_sid);

    Ok(HuyaDanmakuArgs {
        ayyuid: if ayyuid != 0 { ayyuid } else { top_sid },
        top_sid,
        sub_sid,
        presenter_id,
    })
}

/// Build WS join packet (wscmd type=1 + UserInfo body).
pub fn encode_join(ayyuid: i64, tid: i64, sid: i64) -> Vec<u8> {
    let mut inner = TarsWriter::new();
    inner.write_i64(ayyuid, 0);
    inner.write_bool(true, 1);
    inner.write_string("", 2);
    inner.write_string("", 3);
    inner.write_i64(tid, 4);
    inner.write_i64(sid, 5);
    inner.write_i64(0, 6);
    inner.write_i64(0, 7);
    let body = inner.into_bytes();

    let mut outer = TarsWriter::new();
    outer.write_i64(1, 0);
    outer.write_bytes(&body, 1);
    outer.into_bytes()
}

pub fn heartbeat_bytes() -> Vec<u8> {
    base64_decode(HEARTBEAT_B64)
        .unwrap_or_else(|| vec![0x00, 0x14, 0x1d, 0x00, 0x0c, 0x2c, 0x36, 0x00, 0x4c])
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut inv = [255u8; 256];
    for (i, &c) in T.iter().enumerate() {
        inv[c as usize] = i as u8;
    }
    let s: Vec<u8> = s
        .bytes()
        .filter(|c| !c.is_ascii_whitespace() && *c != b'=')
        .collect();
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    for chunk in s.chunks(4) {
        if chunk.len() < 2 {
            break;
        }
        let mut n = 0u32;
        let mut bits = 0;
        for &c in chunk {
            let v = inv[c as usize];
            if v == 255 {
                return None;
            }
            n = (n << 6) | u32::from(v);
            bits += 6;
        }
        while bits >= 8 {
            bits -= 8;
            out.push((n >> bits) as u8);
            n &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// A complete local browser session for a single explicit Huya chat send.
///
/// Deliberately omit `Debug`: Cookie content and the temporary guid must never
/// reach logs, errors, or Tauri event payloads.
#[derive(Clone)]
struct HuyaSendCredentials {
    uid: i64,
    guid: String,
    cookie: String,
}

fn cookie_value<'a>(cookie: &'a str, key: &str) -> Option<&'a str> {
    cookie.split(';').find_map(|segment| {
        let (candidate, value) = segment.trim().split_once('=')?;
        (candidate.trim() == key)
            .then_some(value.trim())
            .filter(|value| !value.is_empty())
    })
}

fn numeric_cookie_value(cookie: &str, names: &[&str]) -> Option<i64> {
    names.iter().find_map(|name| {
        let value = cookie_value(cookie, name)?;
        (value.len() <= 20 && value.bytes().all(|byte| byte.is_ascii_digit()))
            .then(|| value.parse::<i64>().ok())
            .flatten()
            .filter(|value| *value > 0)
    })
}

fn credentials_from_cookie(cookie: &str) -> Option<HuyaSendCredentials> {
    let cookie = cookie
        .trim()
        .strip_prefix("Cookie:")
        .unwrap_or(cookie)
        .trim();
    if cookie.is_empty()
        || cookie.len() > MAX_COOKIE_LEN
        || cookie.contains(['\r', '\n'])
        // A single yyuid is easy to fabricate and is insufficient proof of a
        // logged-in web session. Browser exports often carry `udb_n` /
        // `udb_cred`; the UDB QR flow more commonly yields `udb_biztoken`.
        // The server-side verification response remains authoritative before
        // any chat write.
        || !["udb_n", "udb_cred", "udb_biztoken"]
            .iter()
            .any(|&key| cookie_value(cookie, key).is_some())
    {
        return None;
    }
    let uid = numeric_cookie_value(cookie, &["yyuid", "udb_uid"])?;
    let guid = cookie_value(cookie, "guid")
        .filter(|value| value.len() <= 256 && !value.contains(['\r', '\n']))
        .map(str::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().simple().to_string());
    Some(HuyaSendCredentials {
        uid,
        guid,
        cookie: cookie.to_owned(),
    })
}

/// Whether a manually saved Cookie has enough local session fields to attempt
/// the authenticated Huya signal handshake. The server's verify response is
/// still authoritative and is checked before sending any text.
pub fn has_send_credentials(cookie: &str) -> bool {
    credentials_from_cookie(cookie).is_some()
}

/// Validate an ordinary manually composed chat message before the caller
/// reserves its per-room cooldown.
pub(crate) fn normalize_outgoing_message(value: &str) -> AppResult<String> {
    let message = value.trim();
    if message.is_empty() {
        return Err(AppError::new("huya_send_empty", "请输入要发送的弹幕内容").with_site("huya"));
    }
    if message.encode_utf16().count() > MAX_OUTGOING_CHAT_UTF16_UNITS {
        return Err(AppError::new(
            "huya_send_too_long",
            format!("单条弹幕最多 {MAX_OUTGOING_CHAT_UTF16_UNITS} 个字符"),
        )
        .with_site("huya"));
    }
    if message.chars().any(char::is_control) {
        return Err(
            AppError::new("huya_send_invalid_text", "弹幕不能包含换行或控制字符").with_site("huya"),
        );
    }
    Ok(message.to_owned())
}

fn percent_encode_query(value: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(value.len());
    for &byte in value {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    out
}

/// Serialize HUYA.WSConnectParaInfo exactly as the first-party H5 player
/// does for an authenticated signal connection.
///
/// Its `sCookie` field is part of the websocket URL's `baseinfo` descriptor
/// (tag 8), not merely an Upgrade header.  Leaving it blank lets a socket
/// connect but makes its later VerifyCookie / sendMessage frames an
/// unauthenticated write path.
fn encode_send_baseinfo(credentials: &HuyaSendCredentials) -> Vec<u8> {
    let mut writer = TarsWriter::new();
    // HUYA.WSConnectParaInfo
    writer.write_i64(credentials.uid, 0);
    writer.write_string(&credentials.guid, 1);
    writer.write_string(HUYA_SIGNAL_UA, 2);
    writer.write_string(HUYA_APP_SOURCE, 3);
    writer.write_string("", 4);
    writer.write_string("", 5);
    writer.write_i64(0, 6);
    writer.write_string("", 7);
    writer.write_string(&credentials.cookie, 8);
    writer.write_string("", 9);
    writer.write_map_string_string(10, &[("HUYA_NET", "0"), ("HUYA_VSDKUA", HUYA_SIGNAL_UA)]);
    writer.into_bytes()
}

fn build_send_baseinfo(credentials: &HuyaSendCredentials) -> String {
    let encoded =
        base64::engine::general_purpose::STANDARD.encode(encode_send_baseinfo(credentials));
    percent_encode_query(encoded.as_bytes())
}

/// Wrap a serialized TARS payload in `HUYA.WebSocketCommand`.
fn encode_websocket_command_with_metadata(
    command: i64,
    payload: &[u8],
    request_id: i64,
    trace_id: &str,
    md5: &str,
) -> Vec<u8> {
    let mut outer = TarsWriter::new();
    outer.write_i64(command, 0);
    outer.write_bytes(payload, 1);
    outer.write_i64(request_id, 2);
    outer.write_string(trace_id, 3);
    outer.write_i64(0, 4);
    outer.write_i64(0, 5);
    outer.write_string(md5, 6);
    outer.into_bytes()
}

fn encode_websocket_command(command: i64, payload: &[u8], request_id: i64) -> Vec<u8> {
    encode_websocket_command_with_metadata(command, payload, request_id, "", "")
}

fn decode_websocket_command(
    packet: &[u8],
) -> Result<(i64, Vec<u8>, i64), crate::danmu_rs::tars::TarsError> {
    let mut reader = TarsReader::new(packet);
    let command = reader.read_i64(0, true)?;
    let payload = reader.read_bytes(1, true)?;
    let request_id = reader.read_i64(2, false)?;
    Ok((command, payload, request_id))
}

fn encode_verify_cookie(credentials: &HuyaSendCredentials) -> Vec<u8> {
    let mut verify = TarsWriter::new();
    // HUYA.WSVerifyCookieReq
    verify.write_i64(credentials.uid, 0);
    verify.write_string(HUYA_SIGNAL_UA, 1);
    verify.write_string(&credentials.cookie, 2);
    verify.write_string(&credentials.guid, 3);
    verify.write_bool(true, 4);
    verify.write_string(HUYA_APP_SOURCE, 5);
    encode_websocket_command(WS_CMD_VERIFY_COOKIE_REQUEST, &verify.into_bytes(), 0)
}

fn write_user_id(writer: &mut TarsWriter, credentials: &HuyaSendCredentials) {
    // HUYA.UserId
    writer.write_i64(credentials.uid, 0);
    writer.write_string(&credentials.guid, 1);
    writer.write_string("", 2);
    writer.write_string(HUYA_SIGNAL_UA, 3);
    writer.write_string(&credentials.cookie, 4);
    writer.write_i64(0, 5);
    writer.write_string("", 6);
    writer.write_string("", 7);
}

fn write_content_format(writer: &mut TarsWriter) {
    // HUYA.ContentFormat's web defaults.
    writer.write_i64(-1, 0);
    writer.write_i64(4, 1);
    writer.write_i64(0, 2);
    writer.write_i64(-1, 3);
    writer.write_i64(-1, 4);
    writer.write_i64(-1, 5);
}

fn write_bullet_format(writer: &mut TarsWriter) {
    // HUYA.BulletFormat's web defaults. An empty nested
    // BulletBorderGroundFormat is valid: all fields have protocol defaults.
    writer.write_i64(-1, 0);
    writer.write_i64(4, 1);
    writer.write_i64(0, 2);
    writer.write_i64(1, 3);
    writer.write_i64(0, 4);
    writer.write_struct(5, |_| {});
    writer.write_empty_list(6);
    writer.write_i64(0, 7);
    writer.write_i64(-1, 8);
}

fn write_send_message_format(writer: &mut TarsWriter) {
    // HUYA.SendMessageFormat
    writer.write_i64(0, 0);
    writer.write_i64(0, 1);
    writer.write_i64(0, 2);
}

fn encode_send_message(
    credentials: &HuyaSendCredentials,
    args: &HuyaDanmakuArgs,
    message: &str,
) -> Vec<u8> {
    let mut request = TarsWriter::new();
    request.write_struct(0, |writer| {
        // HUYA.SendMessageReq
        writer.write_struct(0, |user| write_user_id(user, credentials));
        writer.write_i64(args.top_sid, 1);
        writer.write_i64(args.sub_sid, 2);
        writer.write_string(message, 3);
        writer.write_i64(0, 4);
        writer.write_struct(5, write_content_format);
        writer.write_struct(6, write_bullet_format);
        writer.write_empty_list(7);
        writer.write_i64(
            if args.presenter_id > 0 {
                args.presenter_id
            } else {
                args.top_sid
            },
            8,
        );
        writer.write_empty_list(9);
        writer.write_struct(10, write_send_message_format);
        writer.write_i64(0, 11);
    });
    let request = request.into_bytes();
    let wup = encode_wup_v3("liveui", "sendMessage", 1, &[("tReq", &request)]);
    // Huya's web signal client authenticates the WUP wrapper itself with an
    // MD5 and carries a per-request trace string. They are protocol metadata,
    // not user credentials, and are regenerated for this one-off send.
    let trace_seed = Uuid::new_v4().simple().to_string();
    let trace_seed = &trace_seed[..16];
    let trace_id = format!("{trace_seed}:{trace_seed}:0:0");
    let checksum = format!("{:x}", Md5::digest(&wup));
    // The WUP request id lives inside `wup`; the outer WebSocketCommand's id
    // remains zero just like the official `sendWupNew` transport.
    encode_websocket_command_with_metadata(WS_CMD_WUP_REQUEST, &wup, 0, &trace_id, &checksum)
}

type HuyaWebSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect_send_ws(credentials: &HuyaSendCredentials) -> AppResult<HuyaWebSocket> {
    let baseinfo = build_send_baseinfo(credentials);
    let mut last_error = None;
    for endpoint in SEND_SERVER_URLS {
        let url = format!("{endpoint}?baseinfo={baseinfo}");
        let mut request = match url.as_str().into_client_request() {
            Ok(request) => request,
            Err(error) => {
                last_error = Some(error.to_string());
                continue;
            }
        };
        let headers = request.headers_mut();
        let origin = HeaderValue::from_static("https://www.huya.com");
        let user_agent = HeaderValue::from_static(HUYA_HTTP_USER_AGENT);
        let cookie = match HeaderValue::from_str(&credentials.cookie) {
            Ok(value) => value,
            Err(_) => {
                return Err(AppError::new(
                    "huya_send_cookie_invalid",
                    "虎牙 Cookie 格式无效，请重新复制完整 Cookie",
                )
                .with_site("huya"));
            }
        };
        headers.insert("Origin", origin);
        headers.insert("User-Agent", user_agent);
        headers.insert("Cookie", cookie);

        match connect_async(request).await {
            Ok((socket, _)) => return Ok(socket),
            Err(error) => {
                // Do not include the URL here: its query holds a user-bound
                // connection descriptor. The endpoint name and error are
                // enough for diagnostics without exposing a session detail.
                tracing::warn!(host = %endpoint, error = %error, "huya send websocket connect failed");
                last_error = Some(error.to_string());
            }
        }
    }
    let _ = last_error;
    Err(
        AppError::new("huya_send_network", "无法连接虎牙弹幕服务器，请稍后重试")
            .with_site("huya")
            .retryable(),
    )
}

async fn wait_for_command(
    write: &mut futures_util::stream::SplitSink<HuyaWebSocket, Message>,
    read: &mut futures_util::stream::SplitStream<HuyaWebSocket>,
    expected_command: i64,
) -> AppResult<Vec<u8>> {
    let result = time::timeout(SEND_RESPONSE_TIMEOUT, async {
        loop {
            let frame = match read.next().await {
                Some(Ok(frame)) => frame,
                Some(Err(_)) => {
                    return Err(AppError::new(
                        "huya_send_network",
                        "虎牙弹幕服务器连接中断，请稍后重试",
                    )
                    .with_site("huya")
                    .retryable());
                }
                None => {
                    return Err(AppError::new(
                        "huya_send_network",
                        "虎牙弹幕服务器已关闭连接，请稍后重试",
                    )
                    .with_site("huya")
                    .retryable());
                }
            };
            match frame {
                Message::Binary(data) => {
                    let Ok((command, payload, _request_id)) = decode_websocket_command(&data)
                    else {
                        // Ignore an unrelated push/control packet. This
                        // one-off connection only waits for the matching
                        // authentication or WUP response.
                        continue;
                    };
                    if command == expected_command {
                        return Ok(payload);
                    }
                }
                Message::Ping(payload) => {
                    write.send(Message::Pong(payload)).await.map_err(|_| {
                        AppError::new("huya_send_network", "虎牙弹幕服务器连接中断，请稍后重试")
                            .with_site("huya")
                            .retryable()
                    })?;
                }
                Message::Close(_) => {
                    return Err(AppError::new(
                        "huya_send_network",
                        "虎牙弹幕服务器已关闭连接，请稍后重试",
                    )
                    .with_site("huya")
                    .retryable());
                }
                _ => {}
            }
        }
    })
    .await;
    result.map_err(|_| {
        AppError::new("huya_send_timeout", "虎牙弹幕服务器响应超时，请稍后重试")
            .with_site("huya")
            .retryable()
    })?
}

fn verify_cookie_response(payload: &[u8]) -> AppResult<()> {
    let mut reader = TarsReader::new(payload);
    let validation = reader.read_i64(0, false).map_err(|_| {
        AppError::new(
            "huya_send_auth_response",
            "无法确认虎牙登录状态，请重新扫码或更新 Cookie 后重试",
        )
        .with_site("huya")
    })?;
    if validation == 0 {
        Ok(())
    } else {
        Err(AppError::new(
            "huya_send_cookie_expired",
            "虎牙登录状态已失效，请重新保存完整 Cookie 后重试",
        )
        .with_site("huya"))
    }
}

fn send_response_status(payload: &[u8]) -> AppResult<(i64, String)> {
    let response = decode_wup_v3(payload).map_err(|_| {
        AppError::new("huya_send_response", "虎牙弹幕服务器返回异常，请稍后重试")
            .with_site("huya")
            .retryable()
    })?;
    if response.function != "sendMessage" {
        return Err(AppError::new(
            "huya_send_response",
            "虎牙弹幕服务器返回了未知响应，请稍后重试",
        )
        .with_site("huya")
        .retryable());
    }
    let Some((_, response_body)) = response.data.iter().find(|(key, _)| key == "tRsp") else {
        return Err(
            AppError::new("huya_send_response", "虎牙未确认弹幕发送，请稍后重试")
                .with_site("huya")
                .retryable(),
        );
    };
    // WUP v3 stores a serialized `SendMessageRsp` struct at `tRsp`.
    // The first field is the outer struct wrapper at tag 0; treating it as
    // `iStatus` made a successful server response look malformed.
    let mut reader = TarsReader::new(response_body);
    reader.read_struct_begin(0, true).map_err(|_| {
        AppError::new("huya_send_response", "虎牙弹幕响应格式异常，请稍后重试")
            .with_site("huya")
            .retryable()
    })?;
    let status = reader.read_i64(0, false).map_err(|_| {
        AppError::new("huya_send_response", "虎牙弹幕响应格式异常，请稍后重试")
            .with_site("huya")
            .retryable()
    })?;
    // tag 1 is a rich MessageNotice. We do not expose or need it; skip the
    // complete nested struct so the toast at tag 2 can still be read safely.
    if reader.read_struct_begin(1, false).map_err(|_| {
        AppError::new("huya_send_response", "虎牙弹幕响应格式异常，请稍后重试")
            .with_site("huya")
            .retryable()
    })? {
        reader.read_struct_end().map_err(|_| {
            AppError::new("huya_send_response", "虎牙弹幕响应格式异常，请稍后重试")
                .with_site("huya")
                .retryable()
        })?;
    }
    let toast = reader.read_string(2, false).unwrap_or_default();
    reader.read_struct_end().map_err(|_| {
        AppError::new("huya_send_response", "虎牙弹幕响应格式异常，请稍后重试")
            .with_site("huya")
            .retryable()
    })?;
    Ok((status, toast))
}

/// Authenticate a one-off Huya signal websocket and submit exactly one text
/// message. No automatic retry or optimistic local echo is performed: a
/// timeout after the final write can still mean the remote service accepted it.
pub async fn send_chat(cookie: &str, args: HuyaDanmakuArgs, message: &str) -> AppResult<()> {
    let message = normalize_outgoing_message(message)?;
    if args.top_sid <= 0 || args.sub_sid <= 0 {
        return Err(AppError::new(
            "huya_send_room_unavailable",
            "无法获取虎牙直播间信息，请刷新房间后重试",
        )
        .with_site("huya"));
    }
    let credentials = credentials_from_cookie(cookie).ok_or_else(|| {
        AppError::new(
            "huya_send_cookie_missing",
            "请先在设置中扫码登录或保存含 yyuid/udb_uid，以及 udb_n/udb_cred/udb_biztoken 的完整虎牙 Cookie",
        )
        .with_site("huya")
    })?;

    let socket = connect_send_ws(&credentials).await?;
    let (mut write, mut read) = socket.split();
    write
        .send(Message::Binary(encode_verify_cookie(&credentials).into()))
        .await
        .map_err(|_| {
            AppError::new("huya_send_network", "虎牙登录验证连接中断，请稍后重试")
                .with_site("huya")
                .retryable()
        })?;
    let verify = wait_for_command(&mut write, &mut read, WS_CMD_VERIFY_COOKIE_RESPONSE).await?;
    verify_cookie_response(&verify)?;

    write
        .send(Message::Binary(
            encode_send_message(&credentials, &args, &message).into(),
        ))
        .await
        .map_err(|_| {
            AppError::new(
                "huya_send_unknown",
                "虎牙弹幕发送状态未知，请到直播间确认是否已送达",
            )
            .with_site("huya")
            .retryable()
        })?;
    let response = wait_for_command(&mut write, &mut read, WS_CMD_WUP_RESPONSE).await?;
    let (status, toast) = send_response_status(&response)?;
    if status == 0 {
        return Ok(());
    }
    let message = match status {
        905 => "虎牙要求先绑定手机号后才能发送弹幕".to_owned(),
        _ if !toast.trim().is_empty() => toast,
        _ => format!("虎牙拒绝发送弹幕（状态 {status}）"),
    };
    Err(AppError::new("huya_send_rejected", message).with_site("huya"))
}

fn color_hex(font_color: i64) -> Option<String> {
    if font_color <= 0 {
        return None;
    }
    Some(format!("#{:06x}", font_color as u32 & 0x00ff_ffff))
}

/// Decode one WS binary frame directly into a caller-owned sink.
///
/// A Huya push contains at most one chat event. Streaming it avoids creating
/// an empty temporary vector for online-count/control frames and lets the
/// TARS envelope borrow nested byte lists from the websocket buffer.
fn decode_message_with(data: &[u8], emit: &mut impl FnMut(DanmakuEvent)) {
    let mut stream = TarsReader::new(data);
    let msg_type = match stream.read_i64(0, false) {
        Ok(v) => v,
        Err(_) => return,
    };
    // type == 7 → push message
    if msg_type != 7 {
        return;
    }
    let push_bytes = match stream.read_bytes_cow(1, false) {
        Ok(b) if !b.is_empty() => b,
        _ => return,
    };
    let mut push = TarsReader::new(push_bytes.as_ref());
    // HYPushMessage: pushType@0, uri@1, msg@2, protocolType@3
    let _push_type = push.read_i64(0, false).unwrap_or(0);
    let uri = push.read_i64(1, false).unwrap_or(0);
    let msg = match push.read_bytes_cow(2, false) {
        Ok(bytes) if !bytes.is_empty() => bytes,
        _ => return,
    };
    // uri 8006 = online count — ignored for now (no dedicated event kind)
    if uri != 1400 {
        return;
    }

    // HYMessage: userInfo@0, content@3, bulletFormat@6
    let mut notice = TarsReader::new(msg.as_ref());
    let mut nick = String::new();
    let mut user_id = None;
    if notice.read_struct_begin(0, false).unwrap_or(false) {
        // HYSender: uid@0, lMid@0 (ignored), nickName@2, gender@3
        let uid = notice.read_i64(0, false).unwrap_or(0);
        user_id = (uid > 0).then(|| uid.to_string());
        nick = notice.read_string(2, false).unwrap_or_default();
        let _ = notice.read_struct_end();
    }
    let content = notice.read_string(3, false).unwrap_or_default();
    if content.is_empty() {
        return;
    }
    let mut font_color = 0i64;
    if notice.read_struct_begin(6, false).unwrap_or(false) {
        font_color = notice.read_i64(0, false).unwrap_or(0);
        let _ = notice.read_struct_end();
    }
    emit(DanmakuEvent {
        kind: DanmakuKind::Chat,
        user: if nick.is_empty() {
            "用户".into()
        } else {
            nick
        },
        is_self: false,
        user_id,
        content,
        color: color_hex(font_color),
        spans: None,
        super_chat: None,
        ts: chrono::Utc::now().timestamp_millis(),
    });
}

#[cfg(test)]
fn decode_message(data: &[u8]) -> Vec<DanmakuEvent> {
    let mut events = Vec::new();
    decode_message_with(data, &mut |event| events.push(event));
    events
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

pub async fn run_loop(events: DanmakuEventSender, args: HuyaDanmakuArgs) -> AppResult<()> {
    // Channel ids come from room metadata; without one the join packet can
    // never address a channel, so this is a local refusal rather than a dial.
    if args.top_sid == 0 && args.sub_sid == 0 {
        return Err(
            AppError::new("danmaku_bad_room", "虎牙频道号缺失，无法连接弹幕").with_site("huya"),
        );
    }

    let mut policy = ReconnectPolicy::with_defaults("huya");
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
    args: &HuyaDanmakuArgs,
) -> DisconnectReason {
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

    let (ws, _) = match connect_async(SERVER_URL).await {
        Ok(ws) => ws,
        Err(e) => {
            return DisconnectReason::transient(format!("连接虎牙弹幕服务器失败：{e}"));
        }
    };
    let connected_at = Instant::now();
    let (mut write, mut read) = ws.split();

    // simple_live uses topSid for both tid and sid in join
    let tid = if args.top_sid != 0 {
        args.top_sid
    } else {
        args.sub_sid
    };
    let sid = tid;
    let join = encode_join(args.ayyuid, tid, sid);
    if write.send(Message::Binary(join.into())).await.is_err() {
        return DisconnectReason::transient("加入虎牙弹幕频道失败");
    }

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

    let hb_payload = heartbeat_bytes();
    let mut heartbeat = time::interval(Duration::from_secs(HEARTBEAT_SECS));
    heartbeat.tick().await;
    let mut msg_count: u64 = 0;

    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                if write.send(Message::Binary(hb_payload.clone().into())).await.is_err() {
                    break;
                }
            }
            msg = read.next() => {
                match msg {
                    Some(Ok(Message::Binary(bin))) => {
                        decode_message_with(&bin, &mut |ev| {
                            msg_count += 1;
                            emit_event(events, ev);
                        });
                    }
                    Some(Ok(Message::Ping(p))) => {
                        let _ = write.send(Message::Pong(p)).await;
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(e)) => {
                        tracing::warn!(error = %e, msgs = msg_count, "huya danmaku read error");
                        break;
                    }
                    _ => {}
                }
            }
        }
    }

    DisconnectReason::Dropped {
        messages: msg_count,
        connected_for: connected_at.elapsed(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_packet_non_empty() {
        let p = encode_join(1_346_609_715, 1_346_609_715, 1_346_609_715);
        assert!(p.len() > 10);
        // Outer type tag 0 = 1
        let mut r = TarsReader::new(&p);
        assert_eq!(r.read_i64(0, true).unwrap(), 1);
        let body = r.read_bytes(1, true).unwrap();
        assert!(!body.is_empty());
    }

    #[test]
    fn heartbeat_matches_simple_live() {
        let hb = heartbeat_bytes();
        assert_eq!(hb, base64_decode(HEARTBEAT_B64).unwrap());
    }

    #[tokio::test]
    async fn missing_channel_ids_refuse_to_dial_at_all() {
        let (tx, _rx) = tokio::sync::mpsc::channel(8);
        let events = DanmakuEventSender::new(tx, Default::default());
        let args = HuyaDanmakuArgs {
            ayyuid: 1,
            top_sid: 0,
            sub_sid: 0,
            presenter_id: 0,
        };
        let error = run_loop(events, args).await.unwrap_err();
        assert_eq!(error.code, "danmaku_bad_room");
    }

    #[test]
    fn args_from_raw_reads_fields() {
        let raw = serde_json::json!({
            "ayyuid": 1486578378,
            "topSid": 1346609715,
            "subSid": 1346609715,
            "presenterUid": 9988,
        });
        let a = args_from_raw("lpl", &raw).unwrap();
        assert_eq!(a.ayyuid, 1486578378);
        assert_eq!(a.top_sid, 1346609715);
        assert_eq!(a.presenter_id, 9988);
    }

    #[test]
    fn args_keep_channel_ids_distinct_from_presenter_fallback() {
        let raw = serde_json::json!({
            "ayyuid": 123,
            "lines": [{
                "topSid": 456,
                "subSid": 457,
                "presenterUid": 999,
            }],
        });
        let args = args_from_raw("room", &raw).unwrap();
        assert_eq!(args.top_sid, 456);
        assert_eq!(args.sub_sid, 457);
        assert_eq!(args.presenter_id, 999);
    }

    #[test]
    fn huya_sender_accepts_current_browser_session_shapes() {
        assert!(has_send_credentials(
            "yyuid=12345; udb_uid=12345; udb_n=viewer; guid=test-guid"
        ));
        assert!(has_send_credentials(
            "udb_uid=12345; udb_cred=opaque-session-proof; guid=test-guid"
        ));
        assert!(has_send_credentials(
            "udb_uid=12345; udb_biztoken=qr-session-token; guid=test-guid"
        ));
        assert!(!has_send_credentials("yyuid=12345; udb_uid=12345"));
        assert!(!has_send_credentials(
            "yyuid=not-a-number; udb_cred=opaque-session-proof"
        ));
    }

    #[test]
    fn authenticated_baseinfo_carries_cookie_at_protocol_tag_eight() {
        let credentials = credentials_from_cookie(
            "yyuid=12345; udb_uid=12345; udb_cred=opaque-session-proof; guid=test-guid",
        )
        .unwrap();
        let bytes = encode_send_baseinfo(&credentials);
        let mut reader = TarsReader::new(&bytes);
        assert_eq!(reader.read_i64(0, true).unwrap(), 12345);
        assert_eq!(reader.read_string(1, true).unwrap(), "test-guid");
        assert_eq!(reader.read_string(2, true).unwrap(), HUYA_SIGNAL_UA);
        assert_eq!(reader.read_string(3, true).unwrap(), HUYA_APP_SOURCE);
        assert_eq!(reader.read_string(4, true).unwrap(), "");
        assert_eq!(reader.read_string(5, true).unwrap(), "");
        assert_eq!(reader.read_i64(6, true).unwrap(), 0);
        assert_eq!(reader.read_string(7, true).unwrap(), "");
        assert_eq!(reader.read_string(8, true).unwrap(), credentials.cookie);
    }

    #[test]
    fn numeric_profile_room_is_not_used_as_a_signal_channel() {
        let raw = serde_json::json!({"ayyuid": 99});
        assert!(args_from_raw("31339681", &raw).is_err());
    }

    #[test]
    fn huya_sender_validates_plain_text_and_length() {
        assert_eq!(normalize_outgoing_message("  你好  ").unwrap(), "你好");
        assert!(normalize_outgoing_message("\n").is_err());
        assert!(normalize_outgoing_message(&"a".repeat(31)).is_err());
        assert!(normalize_outgoing_message("第一行\n第二行").is_err());
    }

    #[test]
    fn authenticated_send_packet_keeps_room_and_message_fields() {
        let credentials = credentials_from_cookie(
            "yyuid=12345; udb_uid=12345; udb_cred=opaque-session-proof; guid=test-guid",
        )
        .unwrap();
        let args = HuyaDanmakuArgs {
            ayyuid: 1,
            top_sid: 200,
            sub_sid: 201,
            presenter_id: 202,
        };
        let packet = encode_send_message(&credentials, &args, "发送测试");
        let (command, wup, request_id) = decode_websocket_command(&packet).unwrap();
        assert_eq!(command, WS_CMD_WUP_REQUEST);
        assert_eq!(request_id, 0);

        let wup = decode_wup_v3(&wup).unwrap();
        assert_eq!(wup.servant, "liveui");
        assert_eq!(wup.function, "sendMessage");
        let request = wup
            .data
            .into_iter()
            .find_map(|(key, value)| (key == "tReq").then_some(value))
            .unwrap();
        let mut reader = TarsReader::new(&request);
        assert!(reader.read_struct_begin(0, true).unwrap());
        assert!(reader.read_struct_begin(0, true).unwrap());
        assert_eq!(reader.read_i64(0, true).unwrap(), 12345);
        assert_eq!(reader.read_string(1, true).unwrap(), "test-guid");
        reader.read_struct_end().unwrap();
        assert_eq!(reader.read_i64(1, true).unwrap(), 200);
        assert_eq!(reader.read_i64(2, true).unwrap(), 201);
        assert_eq!(reader.read_string(3, true).unwrap(), "发送测试");
        assert_eq!(reader.read_i64(4, true).unwrap(), 0);
        assert!(reader.read_struct_begin(5, true).unwrap());
        reader.read_struct_end().unwrap();
        assert!(reader.read_struct_begin(6, true).unwrap());
        reader.read_struct_end().unwrap();
        assert_eq!(reader.read_list_len(7, true).unwrap(), 0);
        assert_eq!(reader.read_i64(8, true).unwrap(), 202);
    }

    #[test]
    fn send_response_parses_status_and_safe_toast() {
        let mut rsp = TarsWriter::new();
        rsp.write_struct(0, |writer| {
            writer.write_i64(905, 0);
            writer.write_struct(1, |_| {});
            writer.write_string("请绑定手机", 2);
        });
        let rsp = rsp.into_bytes();
        let packet = encode_wup_v3("liveui", "sendMessage", 1, &[("tRsp", &rsp)]);
        assert_eq!(
            send_response_status(&packet).unwrap(),
            (905, "请绑定手机".into())
        );
    }

    #[test]
    fn decode_empty_is_empty() {
        assert!(decode_message(&[]).is_empty());
        assert!(decode_message(&[0x0c]).is_empty()); // ZERO at tag0 → type 0
    }

    #[test]
    fn streaming_decoder_preserves_a_chat_push() {
        let mut notice = TarsWriter::new();
        notice.write_head(crate::danmu_rs::tars::ty::STRUCT_BEGIN, 0);
        notice.write_i64(42, 0);
        notice.write_string("虎牙观众", 2);
        notice.write_head(crate::danmu_rs::tars::ty::STRUCT_END, 0);
        notice.write_string("测试弹幕", 3);
        notice.write_head(crate::danmu_rs::tars::ty::STRUCT_BEGIN, 6);
        notice.write_i64(0x11_22_33, 0);
        notice.write_head(crate::danmu_rs::tars::ty::STRUCT_END, 0);
        let notice = notice.into_bytes();

        let mut push = TarsWriter::new();
        push.write_i64(0, 0);
        push.write_i64(1400, 1);
        push.write_bytes(&notice, 2);
        let push = push.into_bytes();

        let mut frame = TarsWriter::new();
        frame.write_i64(7, 0);
        frame.write_bytes(&push, 1);

        let events = decode_message(&frame.into_bytes());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].user, "虎牙观众");
        assert_eq!(events[0].user_id.as_deref(), Some("42"));
        assert_eq!(events[0].content, "测试弹幕");
        assert_eq!(events[0].color.as_deref(), Some("#112233"));
    }
}
