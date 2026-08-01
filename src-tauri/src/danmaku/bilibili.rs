use std::collections::HashMap;
use std::io::Read;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use reqwest::{Client, Url};
use serde_json::Value;
use tokio::time;
use tokio_tungstenite::{connect_async_tls_with_config, tungstenite::Message};

use crate::danmaku::{DanmakuEventSender, emit_event};
use crate::error::{AppError, AppResult};
use crate::models::live::{DanmakuContentSpan, DanmakuEvent, DanmakuKind, SuperChatInfo};

#[derive(Clone)]
pub struct BilibiliDanmakuArgs {
    pub room_id: i64,
    pub token: String,
    pub buvid: String,
    pub server_host: String,
    /// All websocket hosts returned by `getDanmuInfo`, primary first.  Bilibili
    /// regularly retires individual edge nodes, so keeping the whole list is
    /// important when a long-lived room connection needs to recover.
    pub server_hosts: Vec<String>,
    /// The session used to obtain the original danmaku token.  It never leaves
    /// the backend; reconnects use it only to refresh the ephemeral token and
    /// host list from Bilibili.
    session_cookie: String,
    /// Viewer mid (DedeUserID). Use 0 when anonymous.
    pub uid: i64,
}

/// Return the value portion of a copied browser `Cookie:` header, if present.
fn cookie_header_value(cookie: &str) -> &str {
    let cookie = cookie.trim();
    match cookie.get(..7) {
        Some(prefix) if prefix.eq_ignore_ascii_case("cookie:") => cookie[7..].trim(),
        _ => cookie,
    }
}

/// Extract `key=value` from a cookie header string.
fn cookie_value(cookie: &str, key: &str) -> Option<String> {
    let cookie = cookie_header_value(cookie);
    for part in cookie.split(';') {
        let part = part.trim();
        if let Some((k, v)) = part.split_once('=') {
            if k.trim().eq_ignore_ascii_case(key) {
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
/// Current ordinary-web-composer default, measured in UTF-16 code units.
const MAX_OUTGOING_CHAT_UTF16_UNITS: usize = 20;
const DANMAKU_INFO_URL: &str = "https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo";
/// The older official token endpoint needs no WBI keys, so it stays reachable
/// when the signed `getDanmuInfo` call or its key fetch fails.
const LEGACY_DANMAKU_INFO_URL: &str = "https://api.live.bilibili.com/room/v1/Danmu/getConf";
/// Source of the WBI signing keys required by `getDanmuInfo`.
const NAV_URL: &str = "https://api.bilibili.com/x/web-interface/nav";
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const RECONNECT_INITIAL_DELAY: Duration = Duration::from_secs(1);
const RECONNECT_MAX_DELAY: Duration = Duration::from_secs(30);

/// Whether a saved browser Cookie contains the two values required for the
/// Bilibili live chat write endpoint.  This intentionally exposes only a
/// boolean to callers; neither Cookie nor CSRF values leave the backend.
pub fn has_send_credentials(cookie: &str) -> bool {
    cookie_value(cookie, "SESSDATA").is_some() && cookie_value(cookie, "bili_jct").is_some()
}

/// Send one user-initiated, plain scrolling Bilibili danmaku.
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
    send_chat_to_url(client, cookie, room_id, message, SEND_CHAT_URL).await
}

/// Internal endpoint-injectable variant used by the HTTP contract tests. The
/// public sender is intentionally pinned to Bilibili's live-chat endpoint.
async fn send_chat_to_url(
    client: &Client,
    cookie: &str,
    room_id: &str,
    message: &str,
    url: &str,
) -> AppResult<()> {
    let cookie = cookie_header_value(cookie);
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
        .post(url)
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
    if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(
            AppError::new("bilibili_send_rate_limited", "发送过快，请稍后再试")
                .with_site("bilibili")
                .retryable(),
        );
    }
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

/// Validate a plain, user-composed chat message before it consumes a manual
/// send cooldown. The sender repeats this validation as a defence-in-depth
/// check for any future caller outside the Tauri command.
pub(crate) fn normalize_outgoing_message(value: &str) -> AppResult<String> {
    let message = value.trim();
    if message.is_empty() {
        return Err(
            AppError::new("bilibili_send_empty", "请输入要发送的弹幕内容").with_site("bilibili"),
        );
    }
    if message.encode_utf16().count() > MAX_OUTGOING_CHAT_UTF16_UNITS {
        return Err(AppError::new(
            "bilibili_send_too_long",
            format!("单条弹幕最多 {MAX_OUTGOING_CHAT_UTF16_UNITS} 个字符"),
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
    let mut server_hosts = collect_server_hosts(&danmaku);
    // Older cached room details contain just `server_host`. Always keep that
    // value as the first choice, even if a newer detail additionally carries
    // `server_hosts`.
    prepend_unique_host(&mut server_hosts, &server_host);

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
        server_hosts,
        session_cookie: cookie,
        uid,
    })
}

fn prepend_unique_host(hosts: &mut Vec<String>, host: &str) {
    let host = host.trim();
    if host.is_empty() {
        return;
    }
    hosts.retain(|candidate| !candidate.eq_ignore_ascii_case(host));
    hosts.insert(0, host.to_string());
}

fn collect_server_hosts(data: &Value) -> Vec<String> {
    let mut hosts = Vec::new();

    for field in [
        "server_hosts",
        "host_list",
        "host_server_list",
        "server_list",
    ] {
        let Some(items) = data.get(field).and_then(Value::as_array) else {
            continue;
        };
        for item in items {
            // `parse_room_detail_from_data` stores the initial endpoint list
            // as strings in `raw.danmaku.server_hosts`; newer API responses
            // use `host_list`, while the legacy `getConf` endpoint calls the
            // same shape `host_server_list`. Accept all official spellings so
            // a reconnect can rotate through the refreshed gateways.
            let Some(host) = item
                .as_str()
                .or_else(|| item.get("host").and_then(Value::as_str))
            else {
                continue;
            };
            let host = host.trim();
            if host.is_empty()
                || hosts
                    .iter()
                    .any(|candidate: &String| candidate.eq_ignore_ascii_case(host))
            {
                continue;
            }
            hosts.push(host.to_string());
        }
        if !hosts.is_empty() {
            return hosts;
        }
    }

    if let Some(host) = data.get("host").and_then(Value::as_str) {
        prepend_unique_host(&mut hosts, host);
    }
    hosts
}

impl BilibiliDanmakuArgs {
    fn host_for_attempt(&self, attempt: u32) -> &str {
        if self.server_hosts.is_empty() {
            return &self.server_host;
        }
        let index = (attempt as usize) % self.server_hosts.len();
        &self.server_hosts[index]
    }

    fn refresh_cookie(&self) -> String {
        if self.session_cookie.is_empty() {
            return (!self.buvid.is_empty())
                .then(|| format!("buvid3={};", self.buvid))
                .unwrap_or_default();
        }
        if self.buvid.is_empty() || self.session_cookie.contains("buvid3=") {
            return self.session_cookie.clone();
        }
        format!("{}; buvid3={};", self.session_cookie, self.buvid)
    }

    fn apply_refreshed_connection(&mut self, data: &Value) -> Result<(), &'static str> {
        let token = data
            .get("token")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|token| !token.is_empty())
            .ok_or("B站没有返回弹幕 token")?;

        let mut hosts = collect_server_hosts(data);
        if hosts.is_empty() {
            // Keep a known-good host if an otherwise valid response omits the
            // optional list. This is common on some CDN edge responses.
            prepend_unique_host(&mut hosts, &self.server_host);
        }
        let primary = hosts.first().cloned().ok_or("B站没有返回弹幕服务器地址")?;

        self.token = token.to_string();
        self.server_host = primary;
        self.server_hosts = hosts;
        Ok(())
    }
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

/// The outcome carried by Bilibili's auth reply packet (op=8).
///
/// A few edge nodes omit the JSON body, which older clients have always
/// treated as a successful join. Preserve that compatibility while still
/// surfacing an explicit non-zero auth code so reconnect can refresh its
/// short-lived token instead of waiting for the server to close the socket.
fn auth_reply_result(data: &[u8]) -> Option<Result<(), i64>> {
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
            let body = &data[offset + 16..offset + packet_len];
            let code = serde_json::from_slice::<Value>(body)
                .ok()
                .and_then(|value| value.get("code").and_then(Value::as_i64));
            return Some(match code {
                Some(0) | None => Ok(()),
                Some(code) => Err(code),
            });
        }
        offset += packet_len;
    }
    None
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

// The Bilibili websocket carries image-emote metadata inline with a DANMU_MSG
// rather than requiring a separate pack download. Keep the payload bounded
// before it crosses the native/webview boundary.
const MAX_DANMAKU_CONTENT_SPANS: usize = 32;
const MAX_DANMAKU_EMOTE_TOKEN_BYTES: usize = 256;
const MAX_DANMAKU_EMOTE_URL_BYTES: usize = 2_048;

fn is_trusted_bilibili_image_host(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    ["hdslb.com", "bilibili.com", "biliimg.com"]
        .iter()
        .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
}

/// Convert Bilibili's protocol-relative/legacy HTTP image URL to HTTPS only
/// after its hostname has been constrained to Bilibili's image CDNs. This
/// applies to both message emotes and SC sender avatars.
fn safe_bilibili_image_url(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > MAX_DANMAKU_EMOTE_URL_BYTES
        || value.chars().any(char::is_control)
    {
        return None;
    }
    let source = if value.starts_with("//") {
        format!("https:{value}")
    } else {
        value.to_string()
    };
    let mut url = Url::parse(&source).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || !is_trusted_bilibili_image_host(url.host_str()?)
    {
        return None;
    }
    // Bilibili still sends HTTP in some legacy emote payloads. The trusted
    // hostname check above makes an in-place HTTPS upgrade safe and avoids
    // mixed-content failures in the desktop webview.
    url.set_scheme("https").ok()?;
    Some(url.into())
}

fn add_bilibili_emote(emotes: &mut HashMap<String, String>, key: &str, raw_url: Option<&Value>) {
    let key = key.trim();
    if key.is_empty()
        || key.len() > MAX_DANMAKU_EMOTE_TOKEN_BYTES
        || key.chars().any(char::is_control)
    {
        return;
    }
    let Some(url) = raw_url
        .and_then(Value::as_str)
        .and_then(safe_bilibili_image_url)
    else {
        return;
    };
    emotes.insert(key.to_string(), url);
}

fn add_bilibili_extra_emotes(emotes: &mut HashMap<String, String>, extra: &Value, message: &str) {
    let Some(items) = extra.get("emots").and_then(Value::as_object) else {
        return;
    };
    for (key, emot) in items {
        // The map can contain the whole room's currently available pack. Only
        // retain tokens that this particular comment actually references.
        if message.contains(key) {
            add_bilibili_emote(emotes, key, emot.get("url"));
        }
    }
}

/// Build ordered text/image spans following Simple Live's Bilibili decoder:
/// a one-off whole-message emote may be at `info[0][13].url`, while inline
/// emotes are keyed by token in JSON stored at `info[0][15].extra.emots`.
fn bilibili_content_spans(info: &[Value], message: &str) -> Option<Vec<DanmakuContentSpan>> {
    let metadata = info.first()?.as_array()?;
    let mut emotes = HashMap::<String, String>::new();

    if message.starts_with('[') && message.ends_with(']') {
        add_bilibili_emote(
            &mut emotes,
            message,
            metadata.get(13).and_then(|value| value.get("url")),
        );
    }

    if let Some(extra) = metadata.get(15).and_then(|value| value.get("extra")) {
        match extra {
            Value::String(serialized) if !serialized.is_empty() => {
                if let Ok(extra) = serde_json::from_str::<Value>(serialized) {
                    add_bilibili_extra_emotes(&mut emotes, &extra, message);
                }
            }
            Value::Object(_) => add_bilibili_extra_emotes(&mut emotes, extra, message),
            _ => {}
        }
    }

    if emotes.is_empty() {
        return None;
    }
    // Prefer the longest matching token so a future pack cannot make a
    // shorter alias consume the prefix of a distinct emote.
    let mut keys: Vec<&String> = emotes.keys().collect();
    keys.sort_unstable_by(|left, right| {
        right
            .len()
            .cmp(&left.len())
            .then_with(|| left.as_str().cmp(right.as_str()))
    });

    let mut spans = Vec::new();
    let mut text = String::new();
    let mut remaining = message;
    while !remaining.is_empty() {
        let matched = keys
            .iter()
            .copied()
            .find(|key| remaining.starts_with(key.as_str()));
        if let Some(key) = matched {
            if !text.is_empty() {
                spans.push(DanmakuContentSpan::Text {
                    text: std::mem::take(&mut text),
                });
            }
            let image_url = emotes.get(key)?.clone();
            spans.push(DanmakuContentSpan::Image { image_url });
            if spans.len() > MAX_DANMAKU_CONTENT_SPANS {
                return None;
            }
            remaining = &remaining[key.len()..];
            continue;
        }

        let character = remaining.chars().next()?;
        text.push(character);
        remaining = &remaining[character.len_utf8()..];
    }
    if !text.is_empty() {
        spans.push(DanmakuContentSpan::Text { text });
    }

    (spans
        .iter()
        .any(|span| matches!(span, DanmakuContentSpan::Image { .. }))
        && spans.len() <= MAX_DANMAKU_CONTENT_SPANS)
        .then_some(spans)
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
        avatar_url: data
            .get("user_info")
            .and_then(|user_info| user_info.get("face"))
            .and_then(Value::as_str)
            .and_then(safe_bilibili_image_url),
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
        let user_id = info
            .get(2)
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .map(json_stringish)
            .filter(|value| !value.trim().is_empty() && value != "0");
        let color = if color_num == 0 {
            None
        } else {
            Some(format!("#{:06x}", color_num & 0x00ff_ffff))
        };
        let spans = bilibili_content_spans(info, &message);
        return Some(DanmakuEvent {
            kind: DanmakuKind::Chat,
            user,
            is_self: false,
            user_id,
            content: message,
            color,
            spans,
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
        let user_id = data
            .get("uid")
            .or_else(|| data.pointer("/user_info/uid"))
            .map(json_stringish)
            .filter(|value| !value.trim().is_empty() && value != "0");
        return Some(DanmakuEvent {
            kind: DanmakuKind::SuperChat,
            user,
            is_self: false,
            user_id,
            content: message,
            color: None,
            spans: None,
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
        let user_id = data
            .get("uid")
            .map(json_stringish)
            .filter(|value| !value.trim().is_empty() && value != "0");
        return Some(DanmakuEvent {
            kind: DanmakuKind::Enter,
            user: user.clone(),
            is_self: false,
            user_id,
            content: format!("{user} 进入直播间"),
            color: None,
            spans: None,
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
        let user_id = data
            .get("uid")
            .map(json_stringish)
            .filter(|value| !value.trim().is_empty() && value != "0");
        return Some(DanmakuEvent {
            kind: DanmakuKind::Gift,
            user,
            is_self: false,
            user_id,
            content: format!("投喂 {gift} x{num}"),
            color: None,
            spans: None,
            super_chat: None,
            ts: chrono::Utc::now().timestamp_millis(),
        });
    }

    None
}

const INBOUND_IDLE_TIMEOUT: Duration = Duration::from_secs(90);
const INBOUND_IDLE_CHECK_INTERVAL: Duration = Duration::from_secs(15);
const CLOSE_GRACE_PERIOD: Duration = Duration::from_secs(2);

struct ConnectionEnd {
    message_count: u64,
    authenticated: bool,
    reason: String,
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

fn reconnect_delay(attempt: u32) -> Duration {
    let multiplier = 1_u64 << attempt.min(5);
    let seconds = RECONNECT_INITIAL_DELAY
        .as_secs()
        .saturating_mul(multiplier)
        .min(RECONNECT_MAX_DELAY.as_secs());
    Duration::from_secs(seconds)
}

/// Advance gateway rotation on every reconnect while backing off only the
/// consecutive failures that never completed websocket authentication.
fn next_reconnect_state(
    host_attempt: u32,
    pre_auth_failures: u32,
    authenticated: bool,
) -> (u32, u32) {
    (
        host_attempt.wrapping_add(1),
        if authenticated {
            0
        } else {
            pre_auth_failures.saturating_add(1)
        },
    )
}

/// Fetch WBI signing keys from `nav`.
///
/// `nav` answers `code = -101` ("not logged in") for anonymous sessions but
/// still carries `wbi_img`, so the code is deliberately ignored here.
async fn fetch_wbi_keys(client: &Client, cookie: &str) -> Result<(String, String), String> {
    let mut request = client
        .get(NAV_URL)
        .header("user-agent", crate::sites::bilibili::DEFAULT_USER_AGENT)
        .header("referer", crate::sites::bilibili::DEFAULT_REFERER);
    if !cookie.is_empty() {
        request = request.header("cookie", cookie);
    }
    let text = request
        .send()
        .await
        .map_err(|error| format!("请求 B站 WBI 密钥失败: {error}"))?
        .text()
        .await
        .map_err(|error| format!("读取 B站 WBI 密钥失败: {error}"))?;
    crate::sites::bilibili::parse_wbi_keys(&text).map_err(|error| error.to_string())
}

async fn request_connection_info(
    client: &Client,
    cookie: &str,
    url: &str,
    query: &[(&str, String)],
) -> Result<Value, String> {
    let mut request = client
        .get(url)
        .query(query)
        .header("user-agent", crate::sites::bilibili::DEFAULT_USER_AGENT)
        .header("referer", crate::sites::bilibili::DEFAULT_REFERER)
        .header("origin", "https://live.bilibili.com");
    if !cookie.is_empty() {
        request = request.header("cookie", cookie);
    }

    let response = request
        .send()
        .await
        .map_err(|error| format!("请求 B站弹幕信息失败: {error}"))?;
    let status = response.status();
    let body = response
        .json::<Value>()
        .await
        .map_err(|error| format!("解析 B站弹幕信息失败: {error}"))?;
    if !status.is_success() {
        return Err(format!("B站弹幕信息 HTTP {status}"));
    }
    let code = body.get("code").and_then(Value::as_i64).unwrap_or(-1);
    if code != 0 {
        return Err(format!("B站弹幕信息返回 code={code}"));
    }
    body.get("data")
        .cloned()
        .ok_or_else(|| "B站弹幕信息缺少 data".to_string())
}

async fn refresh_connection_info(
    client: &Client,
    args: &mut BilibiliDanmakuArgs,
) -> Result<(), String> {
    let cookie = args.refresh_cookie();

    // `getDanmuInfo` always returns -352 when unsigned; sign it first.
    let keys = fetch_wbi_keys(client, &cookie).await;
    match keys {
        Ok((img_key, sub_key)) => {
            let mut params = std::collections::BTreeMap::new();
            params.insert("id".into(), args.room_id.to_string());
            params.insert("type".into(), "0".into());
            let signed = crate::sites::bilibili::wbi_sign_params(
                params,
                &img_key,
                &sub_key,
                crate::sites::bilibili::now_unix(),
            );
            let query: Vec<(&str, String)> = signed
                .iter()
                .map(|(k, v)| (k.as_str(), v.clone()))
                .collect();

            let modern = request_connection_info(client, &cookie, DANMAKU_INFO_URL, &query).await;
            match modern {
                Ok(data) => match args.apply_refreshed_connection(&data) {
                    Ok(()) => return Ok(()),
                    Err(error) => {
                        tracing::warn!(
                            reason = error,
                            room_id = args.room_id,
                            "bilibili signed getDanmuInfo refresh data unusable; trying legacy endpoint"
                        );
                    }
                },
                Err(error) => {
                    tracing::warn!(error = %error, room_id = args.room_id, "bilibili signed getDanmuInfo refresh failed; trying legacy endpoint");
                }
            }
        }
        Err(error) => {
            tracing::warn!(
                error = %error,
                room_id = args.room_id,
                "bilibili WBI key fetch failed; skipping signed endpoint and trying legacy"
            );
        }
    }

    let legacy = request_connection_info(
        client,
        &cookie,
        LEGACY_DANMAKU_INFO_URL,
        &[
            ("room_id", args.room_id.to_string()),
            ("platform", "web".to_string()),
        ],
    )
    .await?;
    args.apply_refreshed_connection(&legacy)
        .map_err(str::to_string)
}

async fn run_connection(
    events: &DanmakuEventSender,
    args: &BilibiliDanmakuArgs,
    host: &str,
) -> ConnectionEnd {
    let url = format!("wss://{host}/sub");
    let (ws, _) = match connect_async_tls_with_config(&url, None, false, None).await {
        Ok(connection) => connection,
        Err(error) => {
            return ConnectionEnd {
                message_count: 0,
                authenticated: false,
                reason: format!("连接失败: {error}"),
            };
        }
    };
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
    if let Err(error) = write.send(Message::Binary(join_pkt.into())).await {
        return ConnectionEnd {
            message_count: 0,
            authenticated: false,
            reason: format!("认证发送失败: {error}"),
        };
    }

    let mut heartbeat = time::interval(HEARTBEAT_INTERVAL);
    // When a busy frame takes longer than one interval to decode, the default
    // `Burst` policy would send several heartbeats back-to-back. Bilibili can
    // close such a connection as malformed/rate-limited, so skip missed ticks.
    heartbeat.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
    heartbeat.tick().await;
    let mut idle_check = time::interval(INBOUND_IDLE_CHECK_INTERVAL);
    idle_check.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
    idle_check.tick().await;

    let mut auth_ok = false;
    let mut msg_count: u64 = 0;
    let mut last_inbound = time::Instant::now();
    let reason = loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                let hb = encode_packet(b"", 2);
                if let Err(error) = write.send(Message::Binary(hb.into())).await {
                    break format!("心跳发送失败: {error}");
                }
            }
            _ = idle_check.tick() => {
                if last_inbound.elapsed() >= INBOUND_IDLE_TIMEOUT {
                    break format!("超过 {} 秒未收到服务器数据", INBOUND_IDLE_TIMEOUT.as_secs());
                }
            }
            message = read.next() => {
                match message {
                    Some(Ok(message)) => {
                        last_inbound = time::Instant::now();
                        match message {
                            Message::Binary(bin) => {
                                if !auth_ok {
                                    match auth_reply_result(&bin) {
                                        Some(Ok(())) => {
                                            auth_ok = true;
                                            emit_system(events, "弹幕服务器连接成功");
                                        }
                                        Some(Err(code)) => break format!("认证被 B站拒绝（code={code}）"),
                                        None => {}
                                    }
                                }
                                decode_packets_with(&bin, &mut |ev| {
                                    // First payload can arrive before an op=8 reply.
                                    // Treat it as a healthy connection and announce that
                                    // state before forwarding the first chat event.
                                    if !auth_ok {
                                        auth_ok = true;
                                        emit_system(events, "弹幕服务器连接成功");
                                    }
                                    msg_count += 1;
                                    emit_event(events, ev);
                                });
                            }
                            Message::Text(text) => {
                                decode_packets_with(text.as_bytes(), &mut |ev| {
                                    if !auth_ok {
                                        auth_ok = true;
                                        emit_system(events, "弹幕服务器连接成功");
                                    }
                                    msg_count += 1;
                                    emit_event(events, ev);
                                });
                            }
                            Message::Ping(payload) => {
                                if let Err(error) = write.send(Message::Pong(payload)).await {
                                    break format!("Pong 发送失败: {error}");
                                }
                            }
                            Message::Close(_) => break "服务器关闭连接".to_string(),
                            _ => {}
                        }
                    }
                    Some(Err(error)) => break format!("读取失败: {error}"),
                    None => break "服务器已关闭连接".to_string(),
                }
            }
        }
    };

    // Explicitly finish the local half as well; otherwise a sequence of
    // reconnects can leave native TLS/WebSocket resources pending until their
    // drop tasks get scheduled under load.
    let _ = time::timeout(CLOSE_GRACE_PERIOD, write.close()).await;
    ConnectionEnd {
        message_count: msg_count,
        authenticated: auth_ok,
        reason,
    }
}

pub async fn run_loop(events: DanmakuEventSender, mut args: BilibiliDanmakuArgs) -> AppResult<()> {
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

    let refresh_client = crate::http_client::default_client();
    // Keep host rotation separate from pre-auth backoff.  A healthy socket
    // resets the latter, but it must not pin every later reconnect to the
    // first backup gateway after the primary closes a long-lived connection.
    let mut host_attempt = 0_u32;
    let mut pre_auth_failures = 0_u32;
    let mut total_messages = 0_u64;

    loop {
        let host = args.host_for_attempt(host_attempt).to_string();
        if total_messages == 0 && host_attempt == 0 {
            emit_system(&events, "正在连接弹幕服务器…");
        } else {
            emit_system(&events, "正在重连弹幕服务器…");
        }

        let ended = run_connection(&events, &args, &host).await;
        total_messages = total_messages.saturating_add(ended.message_count);
        tracing::warn!(
            host = %host,
            received = ended.message_count,
            total_received = total_messages,
            authenticated = ended.authenticated,
            reason = %ended.reason,
            "bilibili danmaku connection interrupted; scheduling reconnect"
        );

        // A socket that had authenticated is a fresh failure sequence: retry
        // promptly. Consecutive failures before auth back off exponentially.
        let delay = reconnect_delay(pre_auth_failures);
        emit_system(
            &events,
            format!(
                "弹幕连接中断，{} 秒后自动重连（已收 {total_messages} 条）",
                delay.as_secs()
            ),
        );
        time::sleep(delay).await;

        // Tokens and edge hosts are short-lived. Refreshing before each retry
        // handles token expiry and lets us leave an unhealthy gateway, while
        // retaining the previous values if Bilibili's metadata endpoint is
        // temporarily unavailable.
        if let Err(error) = refresh_connection_info(&refresh_client, &mut args).await {
            tracing::warn!(error = %error, room_id = args.room_id, "bilibili danmaku refresh failed; using previous connection info");
        }
        // Always advance independently of the backoff counter.  In
        // particular, authenticated disconnects reset backoff but still need
        // to try the next Bilibili edge rather than retrying one host forever.
        (host_attempt, pre_auth_failures) =
            next_reconnect_state(host_attempt, pre_auth_failures, ended.authenticated);
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    use super::*;

    fn response_server(status: &str, body: &str) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let status = status.to_owned();
        let body = body.to_owned();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 1_024];
            let header_end = loop {
                let read = stream.read(&mut buffer).unwrap();
                assert!(read > 0, "request ended before headers");
                request.extend_from_slice(&buffer[..read]);
                if let Some(index) = request
                    .windows(4)
                    .position(|window| window == b"\r\n\r\n")
                    .map(|index| index + 4)
                {
                    break index;
                }
            };
            let headers = std::str::from_utf8(&request[..header_end]).unwrap();
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            while request.len() < header_end + content_length {
                let read = stream.read(&mut buffer).unwrap();
                assert!(read > 0, "request ended before body");
                request.extend_from_slice(&buffer[..read]);
            }

            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).unwrap();
            String::from_utf8(request).unwrap()
        });
        (format!("http://{address}/msg/send"), server)
    }

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
        assert_eq!(ev.user_id.as_deref(), Some("1"));
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
    fn parse_danmu_msg_keeps_bilibili_image_emotes_in_order() {
        let mut metadata = vec![Value::Null; 16];
        metadata[3] = serde_json::json!(16777215);
        metadata[15] = serde_json::json!({
            "extra": serde_json::json!({
                "emots": {
                    "[鸣潮·共鸣与群星_问号]": {
                        "url": "//i0.hdslb.com/bfs/emote/wuthering-question.png"
                    },
                    "[Ave Mujica_怎么突然]": {
                        "url": "http://i0.hdslb.com/bfs/emote/ave-mujica.png"
                    }
                }
            })
            .to_string()
        });
        let payload = serde_json::json!({
            "cmd": "DANMU_MSG",
            "info": [
                metadata,
                "前缀[鸣潮·共鸣与群星_问号]中间[Ave Mujica_怎么突然]后缀",
                [1, "alice", 0]
            ]
        });

        let event = parse_message_json(&payload.to_string()).unwrap();
        assert_eq!(
            event.spans,
            Some(vec![
                DanmakuContentSpan::Text {
                    text: "前缀".into()
                },
                DanmakuContentSpan::Image {
                    image_url: "https://i0.hdslb.com/bfs/emote/wuthering-question.png".into()
                },
                DanmakuContentSpan::Text {
                    text: "中间".into()
                },
                DanmakuContentSpan::Image {
                    image_url: "https://i0.hdslb.com/bfs/emote/ave-mujica.png".into()
                },
                DanmakuContentSpan::Text {
                    text: "后缀".into()
                },
            ])
        );
    }

    #[test]
    fn parse_danmu_msg_reads_one_off_emote_metadata_and_rejects_untrusted_url() {
        let mut metadata = vec![Value::Null; 14];
        metadata[13] = serde_json::json!({
            // A real live-emote URL shape: unlike inline pack emotes, live
            // messages can use `/bfs/live/` and legacy HTTP.
            "url": "http://i0.hdslb.com/bfs/live/b3495aaa935b045bfc2e1d52738ea7b124e0d552.png"
        });
        let payload = serde_json::json!({
            "cmd": "DANMU_MSG",
            "info": [metadata, "[单独表情]", [1, "alice", 0]]
        });
        let event = parse_message_json(&payload.to_string()).unwrap();
        assert_eq!(
            event.spans,
            Some(vec![DanmakuContentSpan::Image {
                image_url:
                    "https://i0.hdslb.com/bfs/live/b3495aaa935b045bfc2e1d52738ea7b124e0d552.png"
                        .into()
            }])
        );

        let mut unsafe_metadata = vec![Value::Null; 16];
        unsafe_metadata[15] = serde_json::json!({
            "extra": serde_json::json!({
                "emots": {"[单独表情]": {"url": "https://evil.example/emote.png"}}
            })
            .to_string()
        });
        let unsafe_payload = serde_json::json!({
            "cmd": "DANMU_MSG",
            "info": [unsafe_metadata, "[单独表情]", [1, "alice", 0]]
        });
        assert!(
            parse_message_json(&unsafe_payload.to_string())
                .unwrap()
                .spans
                .is_none()
        );
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
            "user_info": {
              "uname": "SC 用户",
              "face": "//i0.hdslb.com/bfs/face/sc-user.jpg"
            }
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
        assert_eq!(
            info.avatar_url.as_deref(),
            Some("https://i0.hdslb.com/bfs/face/sc-user.jpg")
        );
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
            "duration": 999999,
            "user_info": {"face": "https://evil.example/avatar.jpg"}
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
        assert_eq!(args.server_hosts, ["broadcastlv.chat.bilibili.com"]);
        assert_eq!(args.session_cookie, "DedeUserID=1732227; SESSDATA=x");
    }

    #[test]
    fn args_keep_all_bilibili_hosts_for_reconnect_rotation() {
        let raw = serde_json::json!({
            "room_id": 12345,
            "danmaku": {
                "token": "tok",
                "server_host": "primary.example",
                "server_hosts": [
                    "primary.example",
                    "backup.example",
                    "BACKUP.example",
                    ""
                ]
            }
        });
        let args = args_from_raw("12345", &raw).unwrap();

        assert_eq!(args.server_hosts, ["primary.example", "backup.example"]);
        assert_eq!(args.host_for_attempt(0), "primary.example");
        assert_eq!(args.host_for_attempt(1), "backup.example");
        assert_eq!(args.host_for_attempt(2), "primary.example");
    }

    #[test]
    fn refreshed_connection_replaces_token_and_hosts() {
        let raw = serde_json::json!({
            "room_id": 12345,
            "danmaku": {
                "token": "old-token",
                "server_host": "old.example"
            }
        });
        let mut args = args_from_raw("12345", &raw).unwrap();
        let fresh = serde_json::json!({
            "token": "fresh-token",
            "host_list": [
                {"host": "new-primary.example"},
                {"host": "new-backup.example"}
            ]
        });

        args.apply_refreshed_connection(&fresh).unwrap();

        assert_eq!(args.token, "fresh-token");
        assert_eq!(args.server_host, "new-primary.example");
        assert_eq!(
            args.server_hosts,
            ["new-primary.example", "new-backup.example"]
        );
    }

    #[test]
    fn refreshed_connection_accepts_legacy_get_conf_hosts() {
        let raw = serde_json::json!({
            "room_id": 12345,
            "danmaku": {
                "token": "old-token",
                "server_host": "old.example"
            }
        });
        let mut args = args_from_raw("12345", &raw).unwrap();
        let fresh = serde_json::json!({
            "token": "fresh-token",
            "host_server_list": [
                {"host": "legacy-primary.example", "wss_port": 443},
                {"host": "legacy-backup.example", "wss_port": 443}
            ]
        });

        args.apply_refreshed_connection(&fresh).unwrap();

        assert_eq!(args.token, "fresh-token");
        assert_eq!(args.server_host, "legacy-primary.example");
        assert_eq!(
            args.server_hosts,
            ["legacy-primary.example", "legacy-backup.example"]
        );
    }

    #[test]
    fn reconnect_backoff_is_bounded() {
        assert_eq!(reconnect_delay(0), Duration::from_secs(1));
        assert_eq!(reconnect_delay(1), Duration::from_secs(2));
        assert_eq!(reconnect_delay(5), Duration::from_secs(30));
        assert_eq!(reconnect_delay(u32::MAX), Duration::from_secs(30));
    }

    #[test]
    fn authenticated_disconnects_rotate_hosts_without_carrying_backoff() {
        let (next_host, next_failures) = next_reconnect_state(0, 4, true);
        assert_eq!(next_host, 1);
        assert_eq!(next_failures, 0);

        let (third_host, next_failures) = next_reconnect_state(next_host, next_failures, true);
        assert_eq!(third_host, 2);
        assert_eq!(next_failures, 0);

        let (after_failed_host, failures) = next_reconnect_state(third_host, next_failures, false);
        assert_eq!(after_failed_host, 3);
        assert_eq!(failures, 1);
    }

    #[test]
    fn auth_reply_distinguishes_rejection_from_success() {
        let success = encode_packet(br#"{"code":0}"#, 8);
        let rejected = encode_packet(br#"{"code":-101}"#, 8);

        assert!(matches!(auth_reply_result(&success), Some(Ok(()))));
        assert!(matches!(auth_reply_result(&rejected), Some(Err(-101))));
    }

    #[test]
    fn cookie_value_parses() {
        let c = "a=1; DedeUserID=42; b=2";
        assert_eq!(cookie_value(c, "DedeUserID").as_deref(), Some("42"));
        assert_eq!(
            cookie_value("Cookie: SESSDATA=session; bili_jct=csrf", "SESSDATA").as_deref(),
            Some("session")
        );
    }

    #[test]
    fn outgoing_send_requires_complete_login_cookie() {
        assert!(!has_send_credentials("SESSDATA=abc"));
        assert!(!has_send_credentials("bili_jct=csrf"));
        assert!(has_send_credentials("SESSDATA=abc; bili_jct=csrf"));
        assert!(has_send_credentials("Cookie: SESSDATA=abc; bili_jct=csrf"));
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
        assert!(normalize_outgoing_message(&"😀".repeat(10)).is_ok());
        assert!(normalize_outgoing_message(&"😀".repeat(11)).is_err());
        assert!(normalize_outgoing_message(&"中".repeat(20)).is_ok());
        assert!(normalize_outgoing_message(&"e\u{301}".repeat(10)).is_ok());
        assert!(normalize_outgoing_message(&"e\u{301}".repeat(11)).is_err());
    }

    #[tokio::test]
    async fn outgoing_send_posts_authenticated_form() {
        let (url, server) = response_server("200 OK", r#"{"code":0}"#);
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();

        send_chat_to_url(
            &client,
            "SESSDATA=session; bili_jct=csrf-token",
            "123",
            "hello",
            &url,
        )
        .await
        .unwrap();

        let request = server.join().unwrap();
        let headers = request.to_ascii_lowercase();
        assert!(headers.starts_with("post /msg/send http/1.1\r\n"));
        assert!(headers.contains("cookie: sessdata=session; bili_jct=csrf-token"));
        assert!(headers.contains("origin: https://live.bilibili.com"));
        assert!(headers.contains("referer: https://live.bilibili.com"));
        assert!(request.contains("roomid=123"));
        assert!(request.contains("msg=hello"));
        assert!(request.contains("mode=1"));
        assert!(request.contains("csrf=csrf-token"));
        assert!(request.contains("csrf_token=csrf-token"));
    }

    #[tokio::test]
    async fn outgoing_send_maps_http_rate_limit() {
        let (url, server) = response_server("429 Too Many Requests", r#"{"code":-1}"#);
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();

        let error = send_chat_to_url(
            &client,
            "SESSDATA=session; bili_jct=csrf-token",
            "123",
            "hello",
            &url,
        )
        .await
        .unwrap_err();

        assert_eq!(error.code, "bilibili_send_rate_limited");
        assert!(error.retryable);
        server.join().unwrap();
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
