//! 斗鱼弹幕 —— 二进制分帧承载的 STT 文本。
//!
//! WS：`wss://danmuproxy.douyu.com:8501..=8506`
//! 登录／加入／心跳都是被封装成小端数据包的 STT 字符串。
//!
//! 注意：斗鱼的弹幕代理端口只提供静态 RSA 的 AES-GCM 套件，因此这里的
//! `None` 始终意味着 native-tls 连接器。

use std::collections::BTreeSet;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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
    WebSocketStream, client_async_tls_with_config, connect_async, tungstenite::Message,
};
use uuid::Uuid;

use crate::danmu_rs::proxy::{ProxyCredentialErrors, connect_request, proxy_authorization};
use crate::danmu_rs::reconnect::{Decision, DisconnectReason, ReconnectPolicy};
use crate::danmu_rs::{DanmakuEventSender, emit_event, emit_system};
use crate::error::{AppError, AppResult};
use crate::models::live::{DanmakuEvent, DanmakuKind};

/// 官方代理端口（默认 8506，失败时轮换）。
const SERVER_PORTS: &[u16] = &[8506, 8505, 8504, 8503, 8502, 8501];
const CLIENT_TO_SERVER: u16 = 689;
const SERVER_TO_CLIENT: u16 = 690;
const HEARTBEAT_SECS: u64 = 45;
/// 取自当前第一方 Web 房间客户端的观测值。它们是协议标识符，
/// 不是 rLive 的发布版本号。
const LOGIN_PROTOCOL_VERSION: &str = "20220825";
const LOGIN_APP_VERSION: &str = "218101901";
const LOGIN_VK_SALT: &str = r#"r5*^5;}2#${XF[h+;'./.Q'1;,-]f'p["#;
const SEND_LOGIN_TIMEOUT: Duration = Duration::from_secs(8);
const SEND_RESULT_OBSERVE_TIMEOUT: Duration = Duration::from_secs(3);
const SEND_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_PROXY_RESPONSE_BYTES: usize = 16 * 1024;
const MAX_SEND_ENCRYPTION_TOKEN_BYTES: usize = 256;
const MAX_SEND_ENCRYPTION_KEY_VERSION_BYTES: usize = 64;
// 第一方客户端从网络响应中收到这个数字，并为每个取值做一次 MD5 运算。
// 这里为合法的轮换保留充足上限，同时防止格式错误的响应
// 把一次明确的单条发送变成无界的 CPU 任务。
const MAX_SEND_ENCRYPTION_ITERATIONS: u32 = 10_000;
/// 房间可能施加更短的账号级限制。这个客户端侧的上限
/// 只是手工编写纯文本消息的防御性约束。
const MAX_OUTGOING_CHAT_UTF16_UNITS: usize = 100;
const SEND_PROXY_DISCOVERY_URL: &str = "https://www.douyu.com/swf_api/getProxyServer";
const SEND_ENCRYPTION_URL: &str = "https://www.douyu.com/wgapi/livenc/liveweb/websec/getEncryption";
const SEND_PROXY_HOST: &str = "wsproxy.douyu.com";
const SEND_PROXY_PORTS: &[u16] = &[6671, 6672, 6673, 6674, 6675];
const SEND_BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// 斗鱼数据包由四字节外层长度加上如下固定头部组成：
// 重复的长度（4）、消息类型（2）、加密/保留位（2）。
// 声明的长度还包含 body 之后那个一字节的 NUL 结束符。
const PACKET_HEADER_LEN: usize = 12;
const PACKET_TRAILER_LEN: usize = 1;
const MIN_PACKET_FULL_LEN: usize = 4 + 2 + 1 + 1 + PACKET_TRAILER_LEN;
// 弹幕 STT 消息通常很小。设置有限上限可避免损坏的长度字段
// 让热路径反复检查一个巨大的负载，
// 同时仍为合法控制包留出充足空间。
const MAX_PACKET_FULL_LEN: usize = 256 * 1024;
// 在本地头部损坏后仍能恢复出后续的合法数据包，但不要把任意大的
// 无效 WebSocket 二进制帧变成无界的逐字节 CPU 扫描。
const MAX_PACKET_RESYNC_BYTES: usize = 4 * 1024;

#[derive(Debug, Clone)]
pub struct DouyuDanmakuArgs {
    pub room_id: String,
}

/// 用于认证当前斗鱼 STT 聊天会话的浏览器 cookie 取值。Web 客户端会在普通聊天
/// 数据包中同时提供账号身份和设备身份；只接受历史上那三个登录字段，
/// 会让本地预检看起来就绪，
/// 却产出一个被网关静默丢弃的数据包。
///
/// 不要派生 `Debug`：调用方绝不能无意间把这些值写进日志或 Tauri 错误负载。
/// 它们只在用户明确发起的一次发送期间，从本地账号存储中复制出来。
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

/// 经过认证的业务 websocket 的公开发现响应（有文档记载）。它刻意与弹幕读取
/// 服务器区分开：把 Cookie 派生的 STT 登录包发给读取网关既无法正确认证，
/// 也无法安全重试。
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

/// 仅用于短时效网关挑战的公钥材料。它绝不包含用户的 Cookie 或 JWT，
/// 但仍应保持在本地：暴露它会让将来的协议变更
/// 过于容易被指纹识别。
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

/// 已净化的 HTTP CONNECT 配置。不要保留源 URL，
/// 它可能包含代理凭据，绝不能进入 tracing 输出。
struct SendHttpProxy {
    host: String,
    port: u16,
    authorization: Option<String>,
}

/// 该接口返回的端口既出现过 JSON 数字也出现过十进制字符串。
/// 两种形态都接受，然后在打开 WebSocket 之前
/// 把最终取值限制在固定白名单内。
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

/// 从浏览器风格的 Cookie header 中读取指定字段，且不记录其值。
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
            // STT 网关使用的 Cookie 字段都是简短的不透明 token。
            // 在它变成 websocket 帧之前先拒绝异常的手工输入，
            // 同时把真实取值保留在本地。
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
    // 较旧的浏览器会话和部分扫码流程使用带下划线包裹的写法。
    // 两种形式都接受，使用户可以直接粘贴完整的 Cookie header，
    // 而不必手工编辑 token。
    let ltkid = cookie_value_any(cookie, &["acf_ltkid", "_acf_ltkid_", "acf_ltkid_"])?;
    // 不要自行编造设备 id。它同时用于登录校验和与发出的 `dy` 字段，
    // 而每次请求随机生成会破坏浏览器会话绑定。`acf_devid` 出现在较新的
    // 导出 Cookie 中；`acf_did` / `dy_did` 由 Web 客户端自己生成。
    let did = cookie_value_any(cookie, &["acf_did", "dy_did", "acf_devid"])?;
    let biz = cookie_value_any(cookie, &["acf_biz"])?;
    // 普通聊天会话使用 DM 作用域的 token，而不是通用的 Web JWT。
    // 不要回退到 `acf_jwt_token`：它的受众不同。
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

/// 保存的浏览器 Cookie 是否具备认证用户发起的普通聊天提交所需的会话字段。
pub fn has_send_credentials(cookie: &str) -> bool {
    credentials_from_cookie(cookie).is_some()
}

/// 在命令占用其短暂冷却之前，校验手工编写的普通聊天消息。
/// 斗鱼会在这个保守的本地安全约束之上再施加账号／房间级限制。
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

/// 转义单个 STT 字段值。协议把 `@=` 和 `/` 用作结构分隔符，
/// 因此发出的用户文本和不透明 Cookie 值在放入数据包之前必须先编码。
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
    let vk = hex::encode(Md5::digest(vk_input.as_bytes()));
    // 字段顺序对齐当前浏览器房间客户端。网关在多数情况下对顺序是宽容的，
    // 但保持一致可让抓取到的协议契约便于复核，
    // 也避免依赖旧解析器的行为。
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
        // 让声明的浏览器字段与下面设置的 User-Agent 请求头保持一致。
        // 它们不是用户可控的指纹输入。
        ("dmbt", "chrome"),
        ("dmbv", "126"),
    ])
}

fn chat_request_body(
    message: &str,
    credentials: &DouyuSendCredentials,
    timestamp: DouyuSendTimestamp,
) -> String {
    // 这是从当前 Web 房间客户端观测到的普通文本负载。特别地，`dy`、`sender`、
    // `tts` 和 `cst` 属于普通消息的账号／设备上下文；旧的
    // receiver/scope/pid 形态在 TCP 层会被接受，但可能被静默丢弃。
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

/// 按斗鱼二进制协议把 STT body 封装成帧。
pub fn serialize_packet(body: &str) -> Vec<u8> {
    let body_bytes = body.as_bytes();
    // 长度字段覆盖：second_len(4) + type(2) + enc(1) + rsv(1) + body + nul(1)
    let full_len = (4 + 2 + 1 + 1 + body_bytes.len() + 1) as u32;
    let mut out = Vec::with_capacity(4 + full_len as usize);
    out.extend_from_slice(&full_len.to_le_bytes());
    out.extend_from_slice(&full_len.to_le_bytes());
    out.extend_from_slice(&CLIENT_TO_SERVER.to_le_bytes());
    out.push(0); // 加密位
    out.push(0); // 保留位
    out.extend_from_slice(body_bytes);
    out.push(0); // 末尾 NUL
    out
}

/// 返回位于 `offset` 处、格式正确的数据包的 body 及总字节长度。
///
/// 两个长度字段、已知的数据包类型和末尾 NUL 都是低成本检查，
/// 能在从合法 WebSocket 帧中损坏的数据包之后重新同步时
/// 大幅减少误判。
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
        // 这个解析器只理解明文 STT。拒绝非零标志位
        // 也让有界重同步过程中出现伪头部的可能性
        // 显著降低。
        || encryption != 0
        || reserved != 0
    {
        return None;
    }

    // `full` 不含第一个长度字段。它包含重复的长度／类型／标志位、
    // body 以及末尾的 NUL。
    let total = 4usize.checked_add(full)?;
    let packet_end = offset.checked_add(total)?;
    if packet_end > data.len() || data[packet_end - 1] != 0 {
        return None;
    }

    let body_len = full.checked_sub(MIN_PACKET_FULL_LEN)?;
    let body_start = header_end;
    let body_end = body_start.checked_add(body_len)?;
    // body 必须正好在协议的 NUL 结束符之前结束。
    if body_end != packet_end - PACKET_TRAILER_LEN {
        return None;
    }
    Some((total, &data[body_start..body_end]))
}

/// 遍历二进制缓冲区中零个或多个 UTF-8 STT body 字符串。
///
/// 斗鱼代理常把多个协议数据包合并进单个 WS 帧。把它保持为借用式的迭代器
/// 风格辅助函数，可让实时连接在不为每个 body 分配 `String` 的前提下
/// 丢弃无关数据包（尤其是 `uenter`）。遇到格式错误的数据包时前进一个字节
/// 并搜索下一个校验通过的头部，因此它无法把同一个 WebSocket 帧中
/// 后续的合法聊天包藏住。
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

        if let Ok(stt) = std::str::from_utf8(body)
            && !stt.is_empty()
        {
            visit(stt);
        }
        offset += total;
        resync_bytes = 0;
    }
}

/// 仅供测试使用的便捷包装，内部是借用式数据包遍历器。
#[cfg(test)]
fn deserialize_packets(data: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    for_each_packet(data, |body| out.push(body.to_owned()));
    out
}

/// 反转义斗鱼 STT 的 `@S` / `@A` 序列。
pub fn unescape_slash_at(s: &str) -> String {
    s.replace("@S", "/").replace("@A", "@")
}

/// 在不构造 map 的前提下读取消息类型。斗鱼把 `type` 作为第一个字段发送，
/// 但仍保留通用兜底，使格式错误／字段乱序的数据包
/// 维持此前解析器的行为。
fn stt_type(stt: &str) -> Option<&str> {
    if let Some(rest) = stt.strip_prefix("type@=")
        && let Some(value) = rest.split('/').next().filter(|value| !value.is_empty())
    {
        return Some(value);
    }

    stt.split('/').find_map(|field| {
        let (key, value) = field.split_once("@=")?;
        (key == "type" && !value.is_empty()).then_some(value)
    })
}

/// 只有确实存在 STT 转义语法时才对取值做解码。
fn decode_value(value: &str) -> String {
    if value.contains("@S") || value.contains("@A") {
        unescape_slash_at(value)
    } else {
        value.to_owned()
    }
}

/// 部分上游中继变体把进房通知编码为 `chatmsg`，而不是常规的高频 `uenter`
/// 数据包。它们在聊天界面没有价值，此前会以
/// "某某进入直播间"之类的文本跨越 IPC 边界。
/// 这个检查放在借用的 STT 字段上，
/// 先于转义解码和分配 [`DanmakuEvent`]。
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

    // 只检查真正构成聊天事件所需的字段。旧的通用 HashMap 解析器会为每个数据包
    // 的每个字段都做分配，包括繁忙房间里嘈杂的
    // 进房／心跳／控制包。
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
    // 读取弹幕颜色字段（getColor）
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
        // `uenter` 是高频的房间在场通知，不是用户聊天。在 JSON/IPC/UI 处理之前
        // 就抑制它，可以去掉诸如"xxx 进入直播间"的消息，同时为其他站点实现
        // 保留 `Enter` 事件类型，也为斗鱼保留正常的聊天／礼物事件。
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

/// 让 Cookie 派生的登录包只发往斗鱼为业务 websocket 流量公布的那类端点。
/// 发现接口的响应即使来自可信的 HTTPS 源，也被当作不可信输入：
/// 只有预期的主机和已知的少量端口才可能收到该数据包。
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
            // 请求 URL 是固定的且不含账号数据。不要包含配置的代理 URL、
            // Cookie 或原始响应 body。
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
    let urls = parse_send_proxy_urls(payload).inspect_err(|error| {
        tracing::warn!(
            %attempt_id,
            room_id,
            stage = "server_discovery_validate",
            error_code = %error.code,
            "douyu send server discovery response was rejected"
        );
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

    // 第一方客户端在发送 `livreq` 之前，会用这两个值计算一次签名来预热其密钥
    // 缓存。首次签名不会被发送，但校验这两个值可以确保在使用该响应的
    // `cpp.danmu` 密钥参与服务器挑战之前，其结构与长度都在预期范围内。
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

/// 只获取公开的、短时效的网关挑战密钥。这个接口刻意不带用户 Cookie 请求：
/// 官方 Web 协议是从浏览器设备 id 派生它的，
/// 而账号认证仍留在 STT `loginreq` 数据包内部。
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
    encryption_key_from_response(response).inspect_err(|error| {
        tracing::warn!(
            %attempt_id,
            room_id,
            stage = "encryption_validate",
            error_code = %error.code,
            "douyu send encryption response was rejected"
        );
    })
}

fn md5_hex(value: impl AsRef<[u8]>) -> String {
    hex::encode(Md5::digest(value.as_ref()))
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

/// 解析与普通 HTTP 请求相同的、面向用户的代理设置。websocket 传输是
/// HTTP CONNECT 隧道，因此 SOCKS 与 HTTPS 代理端点会被明确拒绝，
/// 而不是静默绕过该设置。缺少 scheme 的旧式 `127.0.0.1:7890` 仍视为 HTTP。
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
        authorization: proxy_authorization(
            &proxy,
            &ProxyCredentialErrors {
                invalid_encoding: || proxy_error("斗鱼弹幕代理账号编码无效"),
                incomplete_credentials: || {
                    proxy_error("斗鱼弹幕代理账号需同时提供用户名和密码，或移除账号信息")
                }
            },
        )?,
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
        .write_all(&connect_request(&target, proxy.authorization.as_deref()))
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
    // 在本客户端开始 TLS 握手之前，CONNECT 对端不可能合法地发来隧道内的 TLS
    // 数据。遇到含义不明的响应时直接拒绝，
    // 而不是静默丢弃 TLS 之后需要检查的字节。
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
        // 类浏览器请求头能提高部分边缘节点的接受率。
        if let Ok(v) = HeaderValue::from_str("https://www.douyu.com/") {
            headers.insert("Origin", v);
        }
        if let Ok(v) = HeaderValue::from_str(SEND_BROWSER_USER_AGENT) {
            headers.insert("User-Agent", v);
        }
        // 这里绝不要提供 `Sec-WebSocket-Protocol` 子协议：弹幕代理从不回显它，
        // 而 tungstenite（遵循 RFC 6455）随后会以
        // `SecWebSocketSubProtocolError::NoSubProtocol` 拒绝握手。
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

#[derive(Debug, Clone, PartialEq, Eq)]
enum SendGatewayReply {
    Login { user_id: Option<String> },
    EncryptionChallenge(SendGatewayChallenge),
    EncryptionChallengeInvalid,
    ChatAccepted,
    Rejected(Option<String>),
}

fn safe_gateway_code(stt: &str) -> Option<String> {
    // `chatres` 在 `res` 中报告结果；`error` 数据包通常使用 `code`。
    // 把 `res` 放在前面，避免合并帧中的拒绝结果仅因为没有 `code`
    // 就被误判为一次成功的聊天确认。
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
        // 业务网关用 `chatres` 数据包确认普通文本提交。只有 `res=0` 才是肯定确认。
        // 缺少 `res` 的数据包只说明该套接字收到了相关更新，
        // 并不表示平台已接受该消息。
        "chatres" => match stt_field(stt, "res").map(str::trim) {
            Some("0") => Some(SendGatewayReply::ChatAccepted),
            Some(_) => Some(SendGatewayReply::Rejected(safe_gateway_code(stt))),
            None => None,
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
        // 代理可能把多个 STT 数据包合并进一个 WebSocket 帧。同一帧中，终态的拒绝
        // 必须优先于更早出现的看似成功的数据包，
        // 使客户端绝不会报告虚假的发送成功。
        let terminal = matches!(
            &candidate,
            SendGatewayReply::Rejected(_) | SendGatewayReply::EncryptionChallengeInvalid
        );
        if terminal || reply.is_none() {
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
    // 不要把它标记为可重试。WebSocket 写入可能已经到达斗鱼，
    // 因此自动或条件反射式的重试会带来重复发送的风险。
    AppError::new(
        "douyu_send_unknown",
        "发送请求已提交，但未收到斗鱼确认；请到直播间确认是否显示",
    )
    .with_site("douyu")
}

/// 认证一次短时效 websocket 会话，并提交一条普通的斗鱼聊天消息。
///
/// 这里刻意不做自动重试，也不产生乐观的本地事件。只有收到
/// `chatres(res=0)` 之后才报告写入成功；写入后出现任何不确定情况时，
/// 调用方都会收到明确的未知状态，
/// 使其不会因后台重试而意外重复发送消息。
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
    // 失败诊断用这个 id 关联各阶段。Cookie 字段与发出的文本
    // 都不得进入持久化日志。
    let attempt_id = Uuid::new_v4();
    let login = login_request_body(room_id, &credentials, current_unix_seconds()?);

    let ws = match connect_douyu_send_ws(proxy, room_id, &attempt_id).await {
        Ok(ws) => ws,
        Err(error) => {
            // `connect_douyu_ws` 会记录各端口各自的失败。这里保留最终的安全错误码，
            // 以便把它们与本次发送尝试关联起来。
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

    // 当前 Web 房间在 `loginres` 之后要求这个挑战。获取公钥时刻意不带 Cookie
    // 请求头；账号会话已在上面的 STT 登录包中完成认证。
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

    // `send` 会刷出完整的 WebSocket 帧。此后不要自动重试：
    // 即使后续读取失败，平台也可能已经接受了该消息。
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
        // 这里读取路径上的每个错误都是拨号或传输失败，因此都映射为临时性原因；
        // 由策略决定这串失败何时结束。
        Err(error) => DisconnectReason::transient(error.message),
    }
}

async fn connect_and_read(
    events: &DanmakuEventSender,
    args: &DouyuDanmakuArgs,
) -> Result<DisconnectReason, AppError> {
    emit_system(events, "正在连接弹幕服务器…");

    let ws = connect_douyu_ws().await?;
    let (mut write, mut read) = ws.split();

    // 登录 + 加入弹幕组
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

    emit_system(events, "弹幕服务器连接成功");

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
                        // 部分代理可能下发文本帧；直接尝试按 STT 解析。
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
        // 这个循环退出时不保留传输层原因；策略会退回到其稳定的概要描述。
        detail: None,
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
        assert_eq!(send_gateway_reply_from_stt("type@=chatres/cd@=1/"), None);
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
            String::from_utf8(connect_request(
                "wsproxy.douyu.com:6671",
                proxy.authorization.as_deref(),
            ))
            .unwrap();
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
        // 重复长度字段不匹配：必须忽略该数据包，
        // 而不能让它的 body 被当作后续的头部来解释。
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
