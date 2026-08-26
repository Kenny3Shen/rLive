use std::collections::HashMap;
use std::io::Read;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use reqwest::{Client, Url};
use serde_json::Value;
use tokio::net::TcpStream;
use tokio::time;
use tokio_tungstenite::{
    client_async_tls_with_config,
    tungstenite::{Message, client::IntoClientRequest, http::HeaderValue},
};

use crate::danmu_rs::reconnect::{Decision, DisconnectReason, ReconnectPolicy};
use crate::danmu_rs::{DanmakuEventSender, emit_event};
use crate::error::{AppError, AppResult};
use crate::models::live::{DanmakuContentSpan, DanmakuEvent, DanmakuKind, SuperChatInfo};

#[derive(Clone)]
pub struct BilibiliDanmakuArgs {
    pub room_id: i64,
    pub token: String,
    pub buvid: String,
    pub server_host: String,
    /// `getDanmuInfo` 返回的全部 websocket 主机，主用节点在前。Bilibili 会定期
    /// 下线个别边缘节点，因此长连接房间需要恢复时，保留完整列表很重要。
    pub server_hosts: Vec<String>,
    /// 用于获取原始弹幕 token 的会话。它绝不离开后端；
    /// 重连时仅用它向 Bilibili 刷新短时效 token 与主机列表。
    session_cookie: String,
    /// 观众的 mid（DedeUserID）。匿名时使用 0。
    pub uid: i64,
}

/// 若存在，返回复制来的浏览器 `Cookie:` header 中值的部分。
fn cookie_header_value(cookie: &str) -> &str {
    let cookie = cookie.trim();
    match cookie.get(..7) {
        Some(prefix) if prefix.eq_ignore_ascii_case("cookie:") => cookie[7..].trim(),
        _ => cookie,
    }
}

/// 从 cookie header 字符串中提取 `key=value`。
fn cookie_value(cookie: &str, key: &str) -> Option<String> {
    let cookie = cookie_header_value(cookie);
    for part in cookie.split(';') {
        let part = part.trim();
        if let Some((k, v)) = part.split_once('=')
            && k.trim().eq_ignore_ascii_case(key)
        {
            let v = v.trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

const SEND_CHAT_URL: &str = "https://api.live.bilibili.com/msg/send";
/// 当前普通 Web 输入框的默认上限，按 UTF-16 码元计。
const MAX_OUTGOING_CHAT_UTF16_UNITS: usize = 20;
const DANMAKU_INFO_URL: &str = "https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo";
/// 较老的官方 token 接口不需要 WBI 签名密钥，因此当带签名的 `getDanmuInfo`
/// 调用或其密钥获取失败时，它仍然可用。
const LEGACY_DANMAKU_INFO_URL: &str = "https://api.live.bilibili.com/room/v1/Danmu/getConf";
/// `getDanmuInfo` 所需 WBI 签名密钥的来源。
const NAV_URL: &str = "https://api.bilibili.com/x/web-interface/nav";
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);

/// 保存的浏览器 Cookie 是否包含 Bilibili 直播聊天写入接口所需的两个值。
/// 这里刻意只向调用方暴露一个布尔值；
/// Cookie 与 CSRF 值都不会离开后端。
pub fn has_send_credentials(cookie: &str) -> bool {
    cookie_value(cookie, "SESSDATA").is_some() && cookie_value(cookie, "bili_jct").is_some()
}

/// 发送一条由用户发起的普通滚动 Bilibili 弹幕。
///
/// 这里刻意不做重试，也不产生乐观的本地事件。超时仍可能意味着 Bilibili
/// 已接受该消息，而房间的正常 WebSocket 才是其最终回显的事实来源。
pub async fn send_chat(
    client: &Client,
    cookie: &str,
    room_id: &str,
    message: &str,
) -> AppResult<()> {
    send_chat_to_url(client, cookie, room_id, message, SEND_CHAT_URL).await
}

/// 供 HTTP 契约测试使用的、可注入接口地址的内部变体。
/// 公开的发送函数刻意固定指向 Bilibili 的直播聊天接口。
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

/// 在消耗手动发送冷却之前校验用户编写的普通消息。发送函数会重复这套校验，
/// 作为对将来 Tauri 命令之外调用方的纵深防御。
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
    // 较旧的缓存房间详情只包含 `server_host`。始终把该值作为首选，
    // 即使更新的详情额外携带了 `server_hosts`。
    prepend_unique_host(&mut server_hosts, &server_host);

    // 加入包中的 `uid` 是**观众**的 mid，绝不是主播的房间 uid。
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
            // `parse_room_detail_from_data` 会把初始节点列表以字符串形式存入
            // `raw.danmaku.server_hosts`；更新的 API 响应使用 `host_list`，
            // 而旧的 `getConf` 接口把同样的结构称为 `host_server_list`。
            // 这里接受所有官方写法，
            // 使重连能够在刷新后的网关之间轮换。
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
            return if !self.buvid.is_empty() {
                format!("buvid3={};", self.buvid)
            } else {
                Default::default()
            };
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
            // 当一个本来有效的响应缺少这个可选列表时，保留已知可用的主机。
            // 这在部分 CDN 边缘响应中很常见。
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
    buf.extend_from_slice(&16u16.to_be_bytes()); // header 长度
    buf.extend_from_slice(&0u16.to_be_bytes()); // 协议版本（发送时用 JSON）
    buf.extend_from_slice(&operation.to_be_bytes());
    buf.extend_from_slice(&1u32.to_be_bytes()); // 序号
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
        // 兜底：流式解压失败时改用整缓冲区 API。
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

/// 仅供测试使用的分配式包装，内部是流式数据包解码器。
#[cfg(test)]
fn decode_packets(data: &[u8]) -> Vec<DanmakuEvent> {
    let mut out = Vec::new();
    decode_packets_with(data, &mut |event| out.push(event));
    out
}

/// 把数据包缓冲区直接解码进调用方持有的 sink。
///
/// websocket 循环可以在解码出每个事件时立即发出，
/// 避免为每个繁忙房间的帧都创建一个短命的 `Vec<DanmakuEvent>`。
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
            // 心跳应答／人气值 —— 忽略
            3 => {}
            // 认证应答 —— 忽略（在 run_loop 中处理）
            8 => {}
            // 通知／弹幕数据
            5 => {
                match protocol_version {
                    // 压缩帧会展开为嵌套数据包（header + body）。它们必然要
                    // 持有一个解压缓冲区，但递归解码器是从中流式发出事件，
                    // 而不是再分配一个事件向量。
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
                    // 原始 JSON 负载直接借用 websocket 帧；
                    // 在高流量房间里，复制它们曾是可测量的
                    // 内存分配来源。
                    _ => parse_notify_body_with(body, emit),
                }
            }
            _ => {}
        }
    }
}

/// Bilibili 认证应答包（op=8）携带的结果。
///
/// 少数边缘节点不返回 JSON body，老客户端一向把这种情况当作加入成功。
/// 这里保留该兼容行为，同时仍暴露明确的非零认证码，
/// 使重连可以刷新其短时效 token，
/// 而不是等服务器关闭套接字。
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
    // 一个 WS body 可能包含多个由控制字节粘连在一起的 JSON 对象。
    for part in text.split(|c: char| c.is_control()) {
        let part = part.trim();
        if part.len() > 2
            && part.starts_with('{')
            && let Some(ev) = parse_message_json(part)
        {
            emit(ev);
            emitted = true;
        }
    }
    // 兜底：把整个 body 当作单个 JSON
    if !emitted {
        let trimmed = text.trim();
        if trimmed.starts_with('{')
            && let Some(ev) = parse_message_json(trimmed)
        {
            emit(ev);
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

// Bilibili 的 websocket 会把图片表情元数据随 DANMU_MSG 一起内联下发，
// 而不要求单独下载表情包。在它跨越原生/webview 边界之前先限制其大小。
const MAX_DANMAKU_CONTENT_SPANS: usize = 32;
const MAX_DANMAKU_EMOTE_TOKEN_BYTES: usize = 256;
const MAX_DANMAKU_EMOTE_URL_BYTES: usize = 2_048;

fn is_trusted_bilibili_image_host(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    ["hdslb.com", "bilibili.com", "biliimg.com"]
        .iter()
        .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
}

/// 只有在主机名已被限定为 Bilibili 的图片 CDN 之后，才把其协议相对或旧式
/// HTTP 图片 URL 转换为 HTTPS。这对消息表情和 SC 发送者头像都适用。
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
    // Bilibili 在部分旧表情数据中仍下发 HTTP。上面对可信主机名的检查
    // 使就地升级为 HTTPS 是安全的，也避免了桌面 webview 的混合内容失败。
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
        // 该映射可能包含整个房间当前可用的表情包。
        // 只保留这条评论实际引用到的 token。
        if message.contains(key) {
            add_bilibili_emote(emotes, key, emot.get("url"));
        }
    }
}

/// 按 Bilibili Web 客户端的解码方式构建有序的文本/图片片段：
/// 整条消息级的一次性表情可能位于 `info[0][13].url`，
/// 而内联表情按 token 存放在 `info[0][15].extra.emots` 的 JSON 中。
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
    // 优先匹配最长的 token，避免将来的表情包让较短的别名
    // 吃掉另一个表情的前缀。
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

/// Bilibili 以 CSS 风格的十六进制字符串提供卡片颜色。解码保持严格，
/// 因为该值随后会作为内联样式用于客户端。
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
    // 让命令名保持对 `serde_json::Value` 的借用。每个 websocket 负载都会检查它，
    // 而只有其中一部分会变成 UI 事件。
    let cmd = obj.get("cmd")?.as_str()?;
    // 较新的 cmd 形如 "DANMU_MSG:4:0:0:0"
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
            .first()
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
    /// 当网关明确拒绝加入凭据时设置。token 是短时效的，因此第一次被拒值得
    /// 刷新后重试；换成新 token 后再次被拒，说明 Cookie 本身已失效。
    auth_rejected: bool,
    reason: String,
    connected_for: Duration,
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

/// 从 `nav` 获取 WBI 签名密钥。
///
/// 对匿名会话，`nav` 会返回 `code = -101`（"未登录"），但仍携带
/// `wbi_img`，因此这里刻意忽略该 code。
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

    // 未签名时 `getDanmuInfo` 始终返回 -352；先签名再请求。
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

/// 弹幕套接字在内核开始探测对端之前可以空闲多久。
///
/// 繁忙房间里 Bilibili 会持续推送聊天，但安静房间加上 30 秒的应用层心跳，
/// 仍会让套接字空闲到足以让 NAT 与防火墙中间设备淘汰其转换表项。
/// 一旦发生，对端会用 RST 回应下一次写入，读半边在 Windows 上把它报为
/// `os error 10054`（WSAECONNRESET）—— 一次应用层从未宣告的断开。
/// 内核 keepalive 能让映射保持活跃，
/// 并在有限时间内暴露真正不可用的链路。
const TCP_KEEPALIVE_IDLE: Duration = Duration::from_secs(30);
const TCP_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(10);

/// 为刚建立连接的弹幕套接字应用 keepalive 与 `TCP_NODELAY`。
///
/// 从拨号过程中拆分出来，使这组选项能对真实套接字做断言：
/// 读代码并不能证明内核确实接受了这些参数。
fn tune_danmaku_socket(stream: &TcpStream) {
    // 聊天帧很小且对延迟敏感，不要等待 Nagle 算法。
    let _ = stream.set_nodelay(true);
    let keepalive = socket2::TcpKeepalive::new()
        .with_time(TCP_KEEPALIVE_IDLE)
        .with_interval(TCP_KEEPALIVE_INTERVAL);
    // 尽力而为：某个平台拒绝单个 keepalive 参数时，
    // 不应因此让连接不可用。
    let _ = socket2::SockRef::from(stream).set_tcp_keepalive(&keepalive);
}

/// 为弹幕套接字打开 TCP 传输，并启用 keepalive 与 `TCP_NODELAY`。
///
/// `connect_async` 会用内核默认值拨号，在 Windows 上意味着 keepalive 完全关闭。
/// 在这里自行构造套接字，是 TLS 握手消费该流之前唯一能设置这些选项的位置。
async fn open_danmaku_tcp(host: &str) -> std::io::Result<TcpStream> {
    let stream = TcpStream::connect((host, 443)).await?;
    tune_danmaku_socket(&stream);
    Ok(stream)
}

async fn run_connection(
    events: &DanmakuEventSender,
    args: &BilibiliDanmakuArgs,
    host: &str,
) -> ConnectionEnd {
    let url = format!("wss://{host}/sub");
    // 如今 Bilibili 的边缘节点在 upgrade 之后会立即重置不带类浏览器请求头的
    // `/sub` 套接字，表现为瞬间 `received=0`、始终无法认证的重连循环。
    // 这里与其他弹幕后端保持一致，在握手时带上 Origin / User-Agent
    // （以及可用时的会话 cookie）。
    let mut request = match url.as_str().into_client_request() {
        Ok(request) => request,
        Err(error) => {
            return ConnectionEnd {
                message_count: 0,
                authenticated: false,
                auth_rejected: false,
                reason: format!("构造连接请求失败: {error}"),
                connected_for: Duration::ZERO,
            };
        }
    };
    {
        let headers = request.headers_mut();
        headers.insert(
            "Origin",
            HeaderValue::from_static("https://live.bilibili.com"),
        );
        headers.insert(
            "User-Agent",
            HeaderValue::from_static(crate::sites::bilibili::DEFAULT_USER_AGENT),
        );
        if let Ok(cookie) = HeaderValue::from_str(&args.refresh_cookie())
            && !cookie.is_empty()
        {
            headers.insert("Cookie", cookie);
        }
    }
    let socket = match open_danmaku_tcp(host).await {
        Ok(socket) => socket,
        Err(error) => {
            return ConnectionEnd {
                message_count: 0,
                authenticated: false,
                auth_rejected: false,
                reason: format!("连接失败: {error}"),
                connected_for: Duration::ZERO,
            };
        }
    };
    let (ws, _) = match client_async_tls_with_config(request, socket, None, None).await {
        Ok(connection) => connection,
        Err(error) => {
            return ConnectionEnd {
                message_count: 0,
                authenticated: false,
                auth_rejected: false,
                reason: format!("连接失败: {error}"),
                connected_for: Duration::ZERO,
            };
        }
    };
    let connected_at = time::Instant::now();
    let (mut write, mut read) = ws.split();

    // 认证／加入。`uid` 必须是观众 mid（或 0）。
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
            auth_rejected: false,
            reason: format!("认证发送失败: {error}"),
            connected_for: connected_at.elapsed(),
        };
    }

    let mut heartbeat = time::interval(HEARTBEAT_INTERVAL);
    // 当某个繁忙帧的解码耗时超过一个心跳间隔时，默认的 `Burst` 策略会连续
    // 发出多个心跳。Bilibili 可能把这种连接当作格式错误或超频而关闭，
    // 因此跳过错过的 tick。
    heartbeat.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
    heartbeat.tick().await;
    let mut idle_check = time::interval(INBOUND_IDLE_CHECK_INTERVAL);
    idle_check.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
    idle_check.tick().await;

    let mut auth_ok = false;
    let mut auth_rejected = false;
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
                                        Some(Err(code)) => {
                                            auth_rejected = true;
                                            break format!("认证被 B站拒绝（code={code}）");
                                        }
                                        None => {}
                                    }
                                }
                                decode_packets_with(&bin, &mut |ev| {
                                    // 第一个负载可能早于 op=8 应答到达。
                                    // 把它视为连接健康，并在转发第一条聊天事件之前
                                    // 先宣告该状态。
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

    // 同时显式收尾本地半边；否则连续多次重连可能让原生 TLS/WebSocket
    // 资源一直挂着，直到高负载下它们的 drop 任务被调度。
    let _ = time::timeout(CLOSE_GRACE_PERIOD, write.close()).await;
    ConnectionEnd {
        message_count: msg_count,
        authenticated: auth_ok,
        auth_rejected,
        reason,
        connected_for: connected_at.elapsed(),
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
    // 主机轮换与重连策略保持独立：即使是被 Bilibili 关闭的健康套接字，
    // 也应该尝试下一个边缘节点，
    // 而不是把后续所有尝试都钉在同一个网关上。
    let mut host_attempt = 0_u32;
    // token 是短时效的，因此第一次被拒值得刷新一次；用刚获取的 token 再次被拒，
    // 说明凭据本身不被接受，再怎么重试都不会改变结果。
    let mut token_refreshed_after_rejection = false;
    let mut policy = ReconnectPolicy::with_defaults("bilibili");

    loop {
        let host = args.host_for_attempt(host_attempt).to_string();
        if policy.attempts() == 0 {
            emit_system(&events, "正在连接弹幕服务器…");
        } else {
            emit_system(&events, "正在重连弹幕服务器…");
        }

        let ended = run_connection(&events, &args, &host).await;
        tracing::warn!(
            host = %host,
            received = ended.message_count,
            authenticated = ended.authenticated,
            auth_rejected = ended.auth_rejected,
            reason = %ended.reason,
            "bilibili danmaku connection interrupted; scheduling reconnect"
        );

        let reason = if ended.auth_rejected && token_refreshed_after_rejection {
            DisconnectReason::fatal(format!(
                "{}（请在设置中重新保存 B 站 Cookie）",
                ended.reason
            ))
        } else if ended.authenticated || ended.message_count > 0 {
            DisconnectReason::dropped(
                ended.message_count,
                ended.connected_for,
                ended.reason.clone(),
            )
        } else {
            DisconnectReason::transient(ended.reason.clone())
        };
        let rejected = ended.auth_rejected;

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

        // token 和边缘主机都是短时效的。每次重试前刷新既能应对 token 过期，
        // 也能让我们离开不健康的网关，同时在 Bilibili 的元数据接口
        // 暂时不可用时保留此前的取值。
        match refresh_connection_info(&refresh_client, &mut args).await {
            Ok(()) => {
                if rejected {
                    token_refreshed_after_rejection = true;
                }
            }
            Err(error) => {
                tracing::warn!(error = %error, room_id = args.room_id, "bilibili danmaku refresh failed; using previous connection info");
            }
        }
        host_attempt = host_attempt.wrapping_add(1);
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

    /// 这里要防的 RST（`os error 10054`）来自中间设备丢弃空闲映射，
    /// 因此只有内核确实接受了这些选项，修复才算真实生效。
    /// 对活动套接字做断言，而不是相信 setter 已被调用。
    #[tokio::test]
    async fn a_danmaku_socket_gets_keepalive_and_nodelay() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let accepted = tokio::spawn(async move { listener.accept().await.unwrap() });
        let stream = tokio::net::TcpStream::connect(address).await.unwrap();
        let _server = accepted.await.unwrap();

        // 基线：两个选项默认都是关闭的，因此下面的断言观察的是这次调用，
        // 而不是恰好匹配的内核默认值。
        assert!(!stream.nodelay().unwrap(), "nodelay is on before tuning");
        assert!(
            !socket2::SockRef::from(&stream).keepalive().unwrap(),
            "keepalive is on before tuning"
        );

        tune_danmaku_socket(&stream);

        assert!(stream.nodelay().unwrap(), "nodelay was not applied");
        let socket = socket2::SockRef::from(&stream);
        assert!(socket.keepalive().unwrap(), "keepalive was not enabled");
        // 真正让 NAT 映射保持活跃的是空闲时间与探测间隔；
        // 只启用 keepalive 而沿用内核 2 小时默认值是不够的。
        assert_eq!(socket.tcp_keepalive_time().unwrap(), TCP_KEEPALIVE_IDLE);
        #[cfg(not(target_os = "windows"))]
        assert_eq!(
            socket.tcp_keepalive_interval().unwrap(),
            TCP_KEEPALIVE_INTERVAL
        );
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
            // 一个真实的直播表情 URL 形态：与内联表情包不同，
            // 直播消息可能使用 `/bfs/live/` 和旧式 HTTP。
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
        // 构造嵌套的 op=5 JSON 数据包，并以 zlib 压缩为外层 ver=2 的 body。
        let inner_json = br#"{"cmd":"DANMU_MSG","info":[[0,1,25,0],"nested",[1,"carol",0]]}"#;
        let inner = encode_packet(inner_json, 5);
        use flate2::Compression;
        use flate2::write::ZlibEncoder;
        use std::io::Write;
        let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
        enc.write_all(&inner).unwrap();
        let compressed = enc.finish().unwrap();

        // 外层数据包：ver=2, op=5
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
