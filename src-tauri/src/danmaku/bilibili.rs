use std::io::Read;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use reqwest::Client;
use serde_json::Value;
use tauri::AppHandle;
use tokio::time;
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::danmaku::emit_event;
use crate::error::{AppError, AppResult};
use crate::models::live::{DanmakuEvent, DanmakuKind, SuperChatInfo};

#[derive(Debug, Clone)]
pub struct BilibiliDanmakuArgs {
    pub room_id: i64,
    pub token: String,
    pub buvid: String,
    pub server_host: String,
    /// Viewer mid (DedeUserID). Use 0 when anonymous.
    pub uid: i64,
}

/// Extract `key=value` from a cookie header string.
fn cookie_value(cookie: &str, key: &str) -> Option<String> {
    for part in cookie.split(';') {
        let part = part.trim();
        if let Some((k, v)) = part.split_once('=') {
            if k.trim() == key {
                let v = v.trim();
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

const SEND_CHAT_URL: &str = "https://api.live.bilibili.com/msg/send";
const MAX_OUTGOING_CHAT_CHARS: usize = 80;

/// Whether a saved browser Cookie contains the two values required for the
/// Bilibili live chat write endpoint.  This intentionally exposes only a
/// boolean to callers; neither Cookie nor CSRF values leave the backend.
pub fn has_send_credentials(cookie: &str) -> bool {
    cookie_value(cookie, "SESSDATA").is_some() && cookie_value(cookie, "bili_jct").is_some()
}

/// Send one user-confirmed, plain scrolling Bilibili danmaku.
///
/// This intentionally has no retry and no optimistic local event.  A timeout
/// could still mean that Bilibili accepted the message, while the normal room
/// WebSocket is the source of truth for its eventual echo.
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
            AppError::new("bilibili_send_invalid_room", "B站直播间号无效").with_site("bilibili"),
        );
    }
    if !has_send_credentials(cookie) {
        return Err(AppError::new(
            "bilibili_send_cookie_missing",
            "请先在设置中保存含 SESSDATA 和 bili_jct 的 B站 Cookie",
        )
        .with_site("bilibili"));
    }
    let message = normalize_outgoing_message(message)?;
    let csrf = cookie_value(cookie, "bili_jct").unwrap_or_default();
    let rnd = chrono::Utc::now().timestamp().to_string();
    let form = [
        ("roomid", room_id.to_string()),
        ("msg", message),
        ("mode", "1".to_string()),
        ("bubble", "0".to_string()),
        ("rnd", rnd),
        ("color", "16777215".to_string()),
        ("fontsize", "25".to_string()),
        ("csrf", csrf.clone()),
        ("csrf_token", csrf),
    ];
    let response = client
        .post(SEND_CHAT_URL)
        .header("user-agent", crate::sites::bilibili::DEFAULT_USER_AGENT)
        .header("referer", crate::sites::bilibili::DEFAULT_REFERER)
        .header("origin", "https://live.bilibili.com")
        .header("cookie", cookie)
        .form(&form)
        .send()
        .await
        .map_err(|_| {
            AppError::new(
                "bilibili_send_unknown",
                "发送状态未知，请到直播间确认是否已送达",
            )
            .with_site("bilibili")
            .retryable()
        })?;
    if !response.status().is_success() {
        return Err(AppError::new(
            "bilibili_send_rejected",
            "B站未接受此条弹幕，请检查账号状态或直播间限制",
        )
        .with_site("bilibili"));
    }
    let value = response.json::<Value>().await.map_err(|_| {
        AppError::new(
            "bilibili_send_unknown",
            "发送状态未知，请到直播间确认是否已送达",
        )
        .with_site("bilibili")
        .retryable()
    })?;
    let code = value.get("code").and_then(Value::as_i64).unwrap_or(-1);
    match code {
        0 => Ok(()),
        10030 | 10031 | 10039 => Err(AppError::new(
            "bilibili_send_rate_limited",
            "发送过快，请稍后再试",
        )
        .with_site("bilibili")
        .retryable()),
        -101 | -111 => Err(AppError::new(
            "bilibili_send_login_expired",
            "B站登录状态已失效，请更新 Cookie 后重试",
        )
        .with_site("bilibili")),
        _ => Err(AppError::new(
            "bilibili_send_rejected",
            "B站未接受此条弹幕，请检查账号状态或直播间限制",
        )
        .with_site("bilibili")),
    }
}

fn normalize_outgoing_message(value: &str) -> AppResult<String> {
    let message = value.trim();
    if message.is_empty() {
        return Err(
            AppError::new("bilibili_send_empty", "请输入要发送的弹幕内容").with_site("bilibili"),
        );
    }
    if message.chars().count() > MAX_OUTGOING_CHAT_CHARS {
        return Err(AppError::new(
            "bilibili_send_too_long",
            format!("单条弹幕最多 {MAX_OUTGOING_CHAT_CHARS} 个字符"),
        )
        .with_site("bilibili"));
    }
    if message.chars().any(char::is_control) {
        return Err(
            AppError::new("bilibili_send_invalid_text", "弹幕不能包含换行或控制字符")
                .with_site("bilibili"),
        );
    }
    Ok(message.to_string())
}

pub fn args_from_raw(room_id: &str, raw: &Value) -> AppResult<BilibiliDanmakuArgs> {
    let danmaku = raw.get("danmaku").cloned().unwrap_or(Value::Null);
    let token = danmaku
        .get("token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let cookie = danmaku
        .get("cookie")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let mut buvid = danmaku
        .get("buvid")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if buvid.is_empty() {
        buvid = cookie_value(&cookie, "buvid3").unwrap_or_default();
    }
    let server_host = danmaku
        .get("server_host")
        .and_then(|v| v.as_str())
        .unwrap_or("broadcastlv.chat.bilibili.com")
        .to_string();

    // Join packet `uid` is the **viewer** mid, never the streamer's room uid.
    let uid = danmaku
        .get("viewer_uid")
        .and_then(|v| v.as_i64())
        .or_else(|| {
            danmaku
                .get("viewer_uid")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse().ok())
        })
        .or_else(|| cookie_value(&cookie, "DedeUserID")?.parse().ok())
        .unwrap_or(0);

    let room_id_i = raw
        .get("room_id")
        .and_then(|v| v.as_i64())
        .or_else(|| {
            raw.get("room_id")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse().ok())
        })
        .or_else(|| room_id.parse().ok())
        .unwrap_or(0);

    Ok(BilibiliDanmakuArgs {
        room_id: room_id_i,
        token,
        buvid,
        server_host,
        uid,
    })
}

pub fn encode_packet(body: &[u8], operation: u32) -> Vec<u8> {
    let packet_len = (body.len() + 16) as u32;
    let mut buf = Vec::with_capacity(packet_len as usize);
    buf.extend_from_slice(&packet_len.to_be_bytes());
    buf.extend_from_slice(&16u16.to_be_bytes()); // header length
    buf.extend_from_slice(&0u16.to_be_bytes()); // protocol version (JSON for send)
    buf.extend_from_slice(&operation.to_be_bytes());
    buf.extend_from_slice(&1u32.to_be_bytes()); // sequence
    buf.extend_from_slice(body);
    buf
}

fn read_u16(data: &[u8], start: usize) -> Option<u16> {
    data.get(start..start + 2)
        .map(|b| u16::from_be_bytes([b[0], b[1]]))
}

fn read_u32(data: &[u8], start: usize) -> Option<u32> {
    data.get(start..start + 4)
        .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
}

fn inflate_zlib(body: &[u8]) -> Option<Vec<u8>> {
    use flate2::read::ZlibDecoder;
    let mut dec = ZlibDecoder::new(body);
    let mut out = Vec::new();
    if dec.read_to_end(&mut out).is_ok() && !out.is_empty() {
        Some(out)
    } else {
        None
    }
}

fn inflate_brotli(body: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut reader = brotli::Decompressor::new(body, 4096);
    if reader.read_to_end(&mut out).is_ok() && !out.is_empty() {
        Some(out)
    } else {
        // Fallback: whole-buffer API when streaming decompress fails.
        out.clear();
        if brotli::BrotliDecompress(&mut std::io::Cursor::new(body), &mut out).is_ok()
            && !out.is_empty()
        {
            Some(out)
        } else {
            None
        }
    }
}

/// Test-only allocating wrapper around the streaming packet decoder.
#[cfg(test)]
fn decode_packets(data: &[u8]) -> Vec<DanmakuEvent> {
    let mut out = Vec::new();
    decode_packets_with(data, &mut |event| out.push(event));
    out
}

/// Decode a packet buffer directly into a caller-owned sink.
///
/// The websocket loop can emit each event as it is decoded, avoiding a
/// short-lived `Vec<DanmakuEvent>` for every busy-room frame.
fn decode_packets_with(data: &[u8], emit: &mut impl FnMut(DanmakuEvent)) {
    let mut offset = 0usize;
    while offset + 16 <= data.len() {
        let packet_len = match read_u32(data, offset) {
            Some(n) if (n as usize) >= 16 => n as usize,
            _ => break,
        };
        if offset + packet_len > data.len() {
            break;
        }
        let protocol_version = read_u16(data, offset + 6).unwrap_or(0);
        let operation = read_u32(data, offset + 8).unwrap_or(0);
        let body = &data[offset + 16..offset + packet_len];
        offset += packet_len;

        match operation {
            // Heartbeat reply / popularity — ignore
            3 => {}
            // Auth reply — ignore (handled in run_loop)
            8 => {}
            // Notify / danmaku payload
            5 => {
                match protocol_version {
                    // Compressed frames expand into nested packets (headers +
                    // bodies). They necessarily own a decompression buffer,
                    // but the recursive decoder streams events from it rather
                    // than allocating an additional event vector.
                    2 | 3 => {
                        let payload = if protocol_version == 2 {
                            inflate_zlib(body)
                        } else {
                            inflate_brotli(body)
                        };
                        let Some(payload) = payload else {
                            continue;
                        };
                        if payload.len() >= 16 {
                            let nested_len = read_u32(&payload, 0).unwrap_or(0) as usize;
                            if nested_len >= 16 && nested_len <= payload.len() {
                                decode_packets_with(&payload, emit);
                                continue;
                            }
                        }
                        parse_notify_body_with(&payload, emit);
                    }
                    // Raw JSON payloads borrow the websocket frame directly;
                    // copying them was a measurable allocation source in
                    // high-traffic rooms.
                    _ => parse_notify_body_with(body, emit),
                }
            }
            _ => {}
        }
    }
}

/// Whether this buffer looks like a server auth-ok packet (op=8).
pub fn packets_contain_auth_ok(data: &[u8]) -> bool {
    let mut offset = 0usize;
    while offset + 16 <= data.len() {
        let packet_len = match read_u32(data, offset) {
            Some(n) if (n as usize) >= 16 => n as usize,
            _ => break,
        };
        if offset + packet_len > data.len() {
            break;
        }
        let operation = read_u32(data, offset + 8).unwrap_or(0);
        if operation == 8 {
            return true;
        }
        offset += packet_len;
    }
    false
}

fn parse_notify_body_with(body: &[u8], emit: &mut impl FnMut(DanmakuEvent)) {
    let text = String::from_utf8_lossy(body);
    let mut emitted = false;
    // One WS body may contain multiple JSON objects glued by control bytes.
    for part in text.split(|c: char| c.is_control()) {
        let part = part.trim();
        if part.len() > 2 && part.starts_with('{') {
            if let Some(ev) = parse_message_json(part) {
                emit(ev);
                emitted = true;
            }
        }
    }
    // Fallback: whole body as single JSON
    if !emitted {
        let trimmed = text.trim();
        if trimmed.starts_with('{') {
            if let Some(ev) = parse_message_json(trimmed) {
                emit(ev);
            }
        }
    }
}

fn json_stringish(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}

const MAX_SUPER_CHAT_PRICE: f64 = 1_000_000.0;
const MAX_SUPER_CHAT_DURATION_SECS: u64 = 86_400;

/// Bilibili provides card colours as CSS-style hex strings. Keep the decoder
/// strict because this value is later used as an inline style in the client.
fn safe_css_hex_color(value: Option<&Value>) -> Option<String> {
    let color = value?.as_str()?.trim();
    let hex = color.strip_prefix('#')?;
    if !matches!(hex.len(), 3 | 4 | 6 | 8) || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some(format!("#{hex}"))
}

fn safe_currency(value: Option<&Value>) -> Option<String> {
    let currency = value?.as_str()?.trim();
    if currency.len() != 3 || !currency.bytes().all(|byte| byte.is_ascii_alphabetic()) {
        return None;
    }
    Some(currency.to_ascii_uppercase())
}

fn safe_super_chat_id(data: &Value) -> Option<String> {
    let value = data.get("id").or_else(|| data.get("id_str"))?;
    let id = match value {
        Value::String(value) => value.trim().to_string(),
        Value::Number(value) => value.to_string(),
        _ => return None,
    };
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return None;
    }
    Some(id)
}

fn safe_super_chat_price(value: Option<&Value>) -> Option<f64> {
    let price = match value? {
        Value::Number(value) => value.as_f64(),
        Value::String(value) => value.trim().parse::<f64>().ok(),
        _ => None,
    }?;
    if !price.is_finite() || !(0.0..=MAX_SUPER_CHAT_PRICE).contains(&price) {
        return None;
    }
    Some(price)
}

fn safe_super_chat_duration(value: Option<&Value>) -> Option<u32> {
    let duration = match value? {
        Value::Number(value) => value.as_u64(),
        Value::String(value) => value.trim().parse::<u64>().ok(),
        _ => None,
    }?;
    if !(1..=MAX_SUPER_CHAT_DURATION_SECS).contains(&duration) {
        return None;
    }
    u32::try_from(duration).ok()
}

fn parse_super_chat_info(data: &Value) -> SuperChatInfo {
    SuperChatInfo {
        id: safe_super_chat_id(data),
        price: safe_super_chat_price(data.get("price")),
        currency: safe_currency(data.get("currency").or_else(|| data.get("currency_type"))),
        background_color: safe_css_hex_color(
            data.get("background_color")
                .or_else(|| data.get("background_color_start")),
        ),
        background_bottom_color: safe_css_hex_color(
            data.get("background_bottom_color")
                .or_else(|| data.get("background_color_end")),
        ),
        duration: safe_super_chat_duration(data.get("time").or_else(|| data.get("duration"))),
    }
}

pub fn parse_message_json(json_message: &str) -> Option<DanmakuEvent> {
    let obj: Value = serde_json::from_str(json_message).ok()?;
    // Keep the command borrowed from `serde_json::Value`. It is inspected for
    // every websocket payload, while only a subset becomes a UI event.
    let cmd = obj.get("cmd")?.as_str()?;
    // Newer cmds look like "DANMU_MSG:4:0:0:0"
    let cmd_base = cmd.split(':').next().unwrap_or(cmd);

    if cmd_base == "DANMU_MSG" || cmd.contains("DANMU_MSG") {
        let info = obj.get("info")?.as_array()?;
        let message = info
            .get(1)
            .map(json_stringish)
            .filter(|s| !s.is_empty())
            .or_else(|| {
                // Some variants nest text under info[0][15].extra JSON
                None
            })
            .unwrap_or_default();
        if message.is_empty() {
            return None;
        }
        let color_num = info
            .get(0)
            .and_then(|v| v.as_array())
            .and_then(|a| a.get(3))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let user = info
            .get(2)
            .and_then(|v| v.as_array())
            .and_then(|a| a.get(1))
            .map(json_stringish)
            .unwrap_or_else(|| "用户".into());
        let color = if color_num == 0 {
            None
        } else {
            Some(format!("#{:06x}", color_num & 0x00ff_ffff))
        };
        return Some(DanmakuEvent {
            kind: DanmakuKind::Chat,
            user,
            content: message,
            color,
            super_chat: None,
            ts: chrono::Utc::now().timestamp_millis(),
        });
    }

    if cmd_base == "SUPER_CHAT_MESSAGE" || cmd_base == "SUPER_CHAT_MESSAGE_JPN" {
        let data = obj.get("data")?;
        let user = data
            .pointer("/user_info/uname")
            .and_then(|v| v.as_str())
            .unwrap_or("SC")
            .to_string();
        let message = data
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if message.is_empty() {
            return None;
        }
        return Some(DanmakuEvent {
            kind: DanmakuKind::SuperChat,
            user,
            content: message,
            color: None,
            super_chat: Some(parse_super_chat_info(data)),
            ts: chrono::Utc::now().timestamp_millis(),
        });
    }

    if cmd_base == "INTERACT_WORD" {
        let data = obj.get("data")?;
        let user = data
            .get("uname")
            .and_then(|v| v.as_str())
            .unwrap_or("用户")
            .to_string();
        return Some(DanmakuEvent {
            kind: DanmakuKind::Enter,
            user: user.clone(),
            content: format!("{user} 进入直播间"),
            color: None,
            super_chat: None,
            ts: chrono::Utc::now().timestamp_millis(),
        });
    }

    if cmd_base == "SEND_GIFT" {
        let data = obj.get("data")?;
        let user = data
            .get("uname")
            .and_then(|v| v.as_str())
            .unwrap_or("用户")
            .to_string();
        let gift = data
            .get("giftName")
            .and_then(|v| v.as_str())
            .unwrap_or("礼物");
        let num = data.get("num").and_then(|v| v.as_i64()).unwrap_or(1);
        return Some(DanmakuEvent {
            kind: DanmakuKind::Gift,
            user,
            content: format!("投喂 {gift} x{num}"),
            color: None,
            super_chat: None,
            ts: chrono::Utc::now().timestamp_millis(),
        });
    }

    None
}

pub async fn run_loop(app: AppHandle, args: BilibiliDanmakuArgs) -> AppResult<()> {
    if args.room_id <= 0 {
        return Err(
            AppError::new("danmaku_bad_room", "invalid room id for danmaku").with_site("bilibili"),
        );
    }
    if args.token.is_empty() {
        return Err(AppError::new(
            "danmaku_missing_token",
            "弹幕 token 为空（请在设置中保存有效 B 站 Cookie）",
        )
        .with_site("bilibili"));
    }

    let url = format!("wss://{}/sub", args.server_host);
    emit_event(
        &app,
        DanmakuEvent {
            kind: DanmakuKind::System,
            user: "system".into(),
            content: format!(
                "正在连接弹幕服务器… room={} host={}",
                args.room_id, args.server_host
            ),
            color: None,
            super_chat: None,
            ts: chrono::Utc::now().timestamp_millis(),
        },
    );

    let (ws, _) = connect_async(&url).await.map_err(|e| {
        AppError::new("danmaku_ws_error", format!("connect failed: {e}"))
            .with_site("bilibili")
            .retryable()
    })?;
    let (mut write, mut read) = ws.split();

    // Auth / join. `uid` must be viewer mid (or 0).
    let join_body = serde_json::json!({
        "uid": args.uid,
        "roomid": args.room_id,
        "protover": 3,
        "buvid": args.buvid,
        "platform": "web",
        "type": 2,
        "key": args.token,
    })
    .to_string();
    let join_pkt = encode_packet(join_body.as_bytes(), 7);
    write
        .send(Message::Binary(join_pkt.into()))
        .await
        .map_err(|e| AppError::new("danmaku_ws_error", format!("auth send: {e}")))?;

    let mut heartbeat = time::interval(Duration::from_secs(30));
    heartbeat.tick().await;
    let mut auth_ok = false;
    let mut msg_count: u64 = 0;

    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                let hb = encode_packet(b"", 2);
                if write.send(Message::Binary(hb.into())).await.is_err() {
                    break;
                }
            }
            msg = read.next() => {
                match msg {
                    Some(Ok(Message::Binary(bin))) => {
                        if !auth_ok && packets_contain_auth_ok(&bin) {
                            auth_ok = true;
                            emit_event(
                                &app,
                                DanmakuEvent {
                                    kind: DanmakuKind::System,
                                    user: "system".into(),
                                    content: "弹幕服务器连接成功".into(),
                                    color: None,
                                    super_chat: None,
                                    ts: chrono::Utc::now().timestamp_millis(),
                                },
                            );
                        }
                        decode_packets_with(&bin, &mut |ev| {
                            // First payload often arrives with/without an
                            // operation-8 frame.  Announce success before
                            // forwarding that first event, as before.
                            if !auth_ok {
                                auth_ok = true;
                                emit_event(
                                    &app,
                                    DanmakuEvent {
                                        kind: DanmakuKind::System,
                                        user: "system".into(),
                                        content: "弹幕服务器连接成功".into(),
                                        color: None,
                                        super_chat: None,
                                        ts: chrono::Utc::now().timestamp_millis(),
                                    },
                                );
                            }
                            msg_count += 1;
                            emit_event(&app, ev);
                        });
                    }
                    Some(Ok(Message::Text(text))) => {
                        decode_packets_with(text.as_bytes(), &mut |ev| {
                            msg_count += 1;
                            emit_event(&app, ev);
                        });
                    }
                    Some(Ok(Message::Ping(p))) => {
                        let _ = write.send(Message::Pong(p)).await;
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(e)) => {
                        tracing::warn!(error = %e, msgs = msg_count, "danmaku ws read error");
                        break;
                    }
                    _ => {}
                }
            }
        }
    }

    emit_event(
        &app,
        DanmakuEvent {
            kind: DanmakuKind::System,
            user: "system".into(),
            content: format!("弹幕连接结束（已收 {msg_count} 条）"),
            color: None,
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
    fn encode_packet_header() {
        let p = encode_packet(b"{}", 7);
        assert_eq!(p.len(), 18);
        let len = u32::from_be_bytes([p[0], p[1], p[2], p[3]]);
        assert_eq!(len, 18);
        let op = u32::from_be_bytes([p[8], p[9], p[10], p[11]]);
        assert_eq!(op, 7);
    }

    #[test]
    fn parse_danmu_msg() {
        let json = r#"{
          "cmd":"DANMU_MSG",
          "info":[[0,1,25,16777215], "hello world", [1, "alice", 0], [], [], [], 0]
        }"#;
        let ev = parse_message_json(json).unwrap();
        assert_eq!(ev.user, "alice");
        assert_eq!(ev.content, "hello world");
        matches!(ev.kind, DanmakuKind::Chat);
    }

    #[test]
    fn parse_danmu_msg_colon_cmd() {
        let json = r#"{"cmd":"DANMU_MSG:4:0:0:0","info":[[0,1,25,16777215],"hi",[1,"bob",0]]}"#;
        let ev = parse_message_json(json).unwrap();
        assert_eq!(ev.user, "bob");
        assert_eq!(ev.content, "hi");
    }

    #[test]
    fn parse_super_chat_metadata() {
        let json = r##"{
          "cmd":"SUPER_CHAT_MESSAGE",
          "data": {
            "id": 123456,
            "message": "辛苦了！",
            "price": 30,
            "currency": "cny",
            "background_color": "#2A60B2",
            "background_bottom_color": "#1D4A92",
            "time": 60,
            "user_info": {"uname": "SC 用户"}
          }
        }"##;
        let ev = parse_message_json(json).unwrap();
        assert!(matches!(ev.kind, DanmakuKind::SuperChat));
        assert_eq!(ev.user, "SC 用户");
        assert_eq!(ev.content, "辛苦了！");

        let info = ev.super_chat.as_ref().unwrap();
        assert_eq!(info.id.as_deref(), Some("123456"));
        assert_eq!(info.price, Some(30.0));
        assert_eq!(info.currency.as_deref(), Some("CNY"));
        assert_eq!(info.background_color.as_deref(), Some("#2A60B2"));
        assert_eq!(info.background_bottom_color.as_deref(), Some("#1D4A92"));
        assert_eq!(info.duration, Some(60));
    }

    #[test]
    fn parse_super_chat_ignores_unsafe_metadata() {
        let json = r##"{
          "cmd":"SUPER_CHAT_MESSAGE",
          "data": {
            "id": "<bad-id>",
            "message": "仍应显示",
            "price": -1,
            "currency": "CNY; color:red",
            "background_color": "url(javascript:alert(1))",
            "background_color_end": "#not-a-color",
            "duration": 999999
          }
        }"##;
        let ev = parse_message_json(json).unwrap();
        let info = ev.super_chat.as_ref().unwrap();
        assert_eq!(info, &SuperChatInfo::default());
    }

    #[test]
    fn parse_enter() {
        let json = r#"{"cmd":"INTERACT_WORD","data":{"uname":"访客"}}"#;
        let ev = parse_message_json(json).unwrap();
        assert!(ev.content.contains("进入"));
    }

    #[test]
    fn args_from_raw_uses_viewer_uid_not_streamer() {
        let raw = serde_json::json!({
            "room_id": 12345,
            "uid": "999999",
            "danmaku": {
                "token": "tok",
                "server_host": "broadcastlv.chat.bilibili.com",
                "buvid": "b3",
                "cookie": "DedeUserID=1732227; SESSDATA=x",
                "viewer_uid": 1732227
            }
        });
        let args = args_from_raw("12345", &raw).unwrap();
        assert_eq!(args.token, "tok");
        assert_eq!(args.room_id, 12345);
        assert_eq!(args.uid, 1732227);
    }

    #[test]
    fn cookie_value_parses() {
        let c = "a=1; DedeUserID=42; b=2";
        assert_eq!(cookie_value(c, "DedeUserID").as_deref(), Some("42"));
    }

    #[test]
    fn outgoing_send_requires_complete_login_cookie() {
        assert!(!has_send_credentials("SESSDATA=abc"));
        assert!(!has_send_credentials("bili_jct=csrf"));
        assert!(has_send_credentials("SESSDATA=abc; bili_jct=csrf"));
    }

    #[test]
    fn outgoing_message_is_single_line_and_bounded() {
        assert_eq!(normalize_outgoing_message("  你好  ").unwrap(), "你好");
        assert!(normalize_outgoing_message("\n").is_err());
        assert!(normalize_outgoing_message("hello\nworld").is_err());
        assert!(normalize_outgoing_message(&"a".repeat(MAX_OUTGOING_CHAT_CHARS + 1)).is_err());
    }

    #[test]
    fn zlib_nested_packet_roundtrip() {
        // Build a nested op=5 JSON packet, zlib-compress as outer ver=2 body.
        let inner_json = br#"{"cmd":"DANMU_MSG","info":[[0,1,25,0],"nested",[1,"carol",0]]}"#;
        let inner = encode_packet(inner_json, 5);
        use flate2::Compression;
        use flate2::write::ZlibEncoder;
        use std::io::Write;
        let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
        enc.write_all(&inner).unwrap();
        let compressed = enc.finish().unwrap();

        // Outer packet: ver=2, op=5
        let mut outer = Vec::new();
        let packet_len = (compressed.len() + 16) as u32;
        outer.extend_from_slice(&packet_len.to_be_bytes());
        outer.extend_from_slice(&16u16.to_be_bytes());
        outer.extend_from_slice(&2u16.to_be_bytes());
        outer.extend_from_slice(&5u32.to_be_bytes());
        outer.extend_from_slice(&1u32.to_be_bytes());
        outer.extend_from_slice(&compressed);

        let events = decode_packets(&outer);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].user, "carol");
        assert_eq!(events[0].content, "nested");
    }

    #[test]
    fn streaming_decoder_forwards_all_packets_in_order() {
        let first = encode_packet(
            br#"{"cmd":"DANMU_MSG","info":[[0,1,25,0],"first",[1,"alice",0]]}"#,
            5,
        );
        let second = encode_packet(
            br#"{"cmd":"DANMU_MSG","info":[[0,1,25,0],"second",[1,"bob",0]]}"#,
            5,
        );
        let mut frame = first;
        frame.extend(second);

        let mut received = Vec::new();
        decode_packets_with(&frame, &mut |event| {
            received.push((event.user, event.content))
        });

        assert_eq!(
            received,
            vec![
                ("alice".to_string(), "first".to_string()),
                ("bob".to_string(), "second".to_string()),
            ]
        );
    }
}
