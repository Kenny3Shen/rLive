//! 基于 WebSocket 的 Twitch 匿名 IRC 聊天。
//!
//! Twitch 允许使用其文档中的 `justinfan` 匿名身份进行只读聊天。
//! 接收公开频道消息无需用户 OAuth token 或已保存的 Cookie。

use std::collections::HashMap;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use native_tls::TlsConnector as NativeTlsConnector;
use reqwest::Url;
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufStream},
    net::TcpStream,
    time,
};
use tokio_native_tls::TlsConnector;
use tokio_tungstenite::{
    WebSocketStream, client_async_tls_with_config, connect_async, tungstenite::Message,
};

use crate::danmu_rs::proxy::{ProxyCredentialErrors, connect_request, proxy_authorization};
use crate::danmu_rs::reconnect::{Decision, DisconnectReason, ReconnectPolicy};
use crate::danmu_rs::{DanmakuEventSender, emit_event, emit_system};
use crate::error::{AppError, AppResult};
use crate::models::live::{DanmakuContentSpan, DanmakuEvent, DanmakuKind};

const IRC_WS_URL: &str = "wss://irc-ws.chat.twitch.tv:443";
const IRC_CONNECT_AUTHORITY: &str = "irc-ws.chat.twitch.tv:443";
const PROXY_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_PROXY_RESPONSE_HEADER_BYTES: usize = 16 * 1024;

#[derive(Clone, Copy)]
enum ProxyScheme {
    Http,
    Https,
}

/// 供匿名 IRC 客户端使用的、已净化的 HTTP CONNECT 代理配置。
///
/// 刻意不保留原始设置：除了避免无意中记录凭据之外，
/// WebSocket 路径只需要一个地址
/// 和一个可选的、已编码好的 `Proxy-Authorization` 取值。
struct ConnectProxy {
    scheme: ProxyScheme,
    host: String,
    port: u16,
    authorization: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TwitchDanmakuArgs {
    pub channel_login: String,
    /// 7TV 频道表情集按数字 Twitch 用户 ID 查询。房间详情已携带它，
    /// 因此不需额外的 Twitch 请求。
    pub broadcaster_id: Option<String>,
}

pub fn args_from_raw(room_id: &str, raw: &Value) -> AppResult<TwitchDanmakuArgs> {
    let login = raw
        .get("login")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(room_id)
        .trim()
        .to_ascii_lowercase();
    if login.is_empty()
        || login.len() > 25
        || !login
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return Err(
            AppError::new("twitch_danmaku_bad_channel", "Twitch 弹幕频道名无效")
                .with_site("twitch"),
        );
    }
    Ok(TwitchDanmakuArgs {
        channel_login: login,
        broadcaster_id: raw
            .get("broadcaster_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| {
                !value.is_empty() && value.len() <= 20 && value.bytes().all(|b| b.is_ascii_digit())
            })
            .map(str::to_owned),
    })
}

fn decode_tag_value(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(character) = chars.next() {
        if character != '\\' {
            output.push(character);
            continue;
        }
        match chars.next() {
            Some('s') => output.push(' '),
            Some(':') => output.push(';'),
            Some('r') => output.push('\r'),
            Some('n') => output.push('\n'),
            Some('\\') => output.push('\\'),
            Some(other) => output.push(other),
            None => output.push('\\'),
        }
    }
    output
}

fn tag_value<'a>(tags: Option<&'a str>, key: &str) -> Option<&'a str> {
    tags?.split(';').find_map(|pair| {
        let (candidate, value) = pair.split_once('=')?;
        (candidate == key).then_some(value)
    })
}

/// 表情图片的官方 CDN 模板。`2.0` 是双倍尺寸（56px），
/// 在聊天字号的 1.35 倍下仍然清晰。
const EMOTE_CDN_BASE: &str = "https://static-cdn.jtvnw.net/emoticons/v2";
const MAX_EMOTE_ID_BYTES: usize = 64;
const MAX_CONTENT_SPANS: usize = 32;

/// 把 IRC `emotes` 标签（`25:0-4,12-16/1902:6-10`）展开为有序的文本/图片片段。
///
/// 标签里的下标按 code point 计数且可能与实际消息不一致（`/me` 动作消息带有
/// `\x01ACTION` 包裹）。任何越界、重叠或过长的负载都返回 `None`，
/// 让调用方回退到纯文本，而不是切出错位的片段。
fn emote_spans(tags: Option<&str>, content: &str) -> Option<Vec<DanmakuContentSpan>> {
    let raw = tag_value(tags, "emotes").filter(|value| !value.is_empty())?;
    let mut ranges = Vec::new();
    for entry in raw.split('/') {
        let (id, positions) = entry.split_once(':')?;
        if id.is_empty()
            || id.len() > MAX_EMOTE_ID_BYTES
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        {
            return None;
        }
        for position in positions.split(',') {
            let (start, end) = position.split_once('-')?;
            let start = start.parse::<usize>().ok()?;
            let end = end.parse::<usize>().ok()?;
            if end < start {
                return None;
            }
            ranges.push((start, end, id));
        }
    }
    ranges.sort_unstable_by_key(|(start, _, _)| *start);

    let offsets: Vec<usize> = content.char_indices().map(|(index, _)| index).collect();
    let mut spans = Vec::new();
    let mut cursor = 0;
    for (start, end, id) in ranges {
        if start < cursor || end >= offsets.len() {
            return None;
        }
        if start > cursor {
            spans.push(DanmakuContentSpan::Text {
                text: content[offsets[cursor]..offsets[start]].to_owned(),
            });
        }
        spans.push(DanmakuContentSpan::Image {
            image_url: format!("{EMOTE_CDN_BASE}/{id}/default/dark/2.0"),
            // 官方表情与文字同行混排，保持内联尺寸。
            large: false,
        });
        cursor = end + 1;
    }
    if cursor < offsets.len() {
        spans.push(DanmakuContentSpan::Text {
            text: content[offsets[cursor]..].to_owned(),
        });
    }
    (spans.len() <= MAX_CONTENT_SPANS).then_some(spans)
}

/// 7TV 表情名到图片 URL 的查找表。空表示第三方表情不可用；
/// 此时消息按纯文本渲染。
type SevenTvEmotes = HashMap<String, String>;

const SEVEN_TV_GLOBAL_SET_URL: &str = "https://7tv.io/v3/emote-sets/global";
const SEVEN_TV_CDN_PREFIX: &str = "https://cdn.7tv.app/emote/";
/// 单个频道的表情集上限为 1000，加上全局集给一点余量。超过就不再收，
/// 避免异常响应把内存和逐条匹配开销推高。
const MAX_SEVEN_TV_EMOTES: usize = 2_048;
const MAX_SEVEN_TV_NAME_BYTES: usize = 64;
const SEVEN_TV_TIMEOUT: Duration = Duration::from_secs(10);

/// 从一个 7TV emote set 负载收集 `name → url`。
///
/// 只接受 `host.url` 落在官方 CDN 前缀下的条目：URL 直接进 img 标签，
/// 因此不能让响应里的任意主机名穿透过来。图片固定取 `2x.webp`（64px），
/// 与官方表情的 2.0 档一致；WebP 也是三种可选格式里动图体积最小的一档。
fn collect_seven_tv_set(emotes: &mut SevenTvEmotes, set: &Value) {
    let Some(items) = set.get("emotes").and_then(Value::as_array) else {
        return;
    };
    for item in items {
        if emotes.len() >= MAX_SEVEN_TV_EMOTES {
            return;
        }
        // 顶层 `name` 是该表情集里的别名，主播可以改；`data.name` 是原名。
        // 聊天消息里出现的是别名，所以以顶层为准。
        let Some(name) = item
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| {
                !name.is_empty()
                    && name.len() <= MAX_SEVEN_TV_NAME_BYTES
                    && !name.chars().any(|c| c.is_whitespace() || c.is_control())
            })
        else {
            continue;
        };
        let Some(host) = item.get("data").and_then(|data| data.get("host")) else {
            continue;
        };
        // `host.url` 是协议相对的（`//cdn.7tv.app/emote/<id>`）。
        let Some(base) = host
            .get("url")
            .and_then(Value::as_str)
            .map(|url| {
                url.trim()
                    .trim_start_matches("https:")
                    .trim_start_matches("//")
            })
            .map(|url| format!("https://{url}"))
            .filter(|url| url.starts_with(SEVEN_TV_CDN_PREFIX) && !url.contains(['?', '#', '\\']))
        else {
            continue;
        };
        // 该表情实际提供哪些文件由响应决定，不能假定 2x 一定存在。
        let has_file = |wanted: &str| {
            host.get("files")
                .and_then(Value::as_array)
                .is_some_and(|files| {
                    files
                        .iter()
                        .any(|file| file.get("name").and_then(Value::as_str) == Some(wanted))
                })
        };
        let file = if has_file("2x.webp") {
            "2x.webp"
        } else if has_file("1x.webp") {
            "1x.webp"
        } else {
            continue;
        };
        emotes.insert(name.to_owned(), format!("{base}/{file}"));
    }
}

/// 拉取全局表情集与该频道的表情集。
///
/// 两个请求都是尽力而为：7TV 是 Twitch 之外的第三方服务，任一失败只会让对应
/// 表情退回文本显示，不影响聊天连接。多数频道没有 7TV 账号，频道集返回 404
/// 属于正常情况。
async fn fetch_seven_tv_emotes(broadcaster_id: Option<&str>, proxy: Option<&str>) -> SevenTvEmotes {
    let Ok(client) = crate::http_client::client_for_proxy(proxy) else {
        return SevenTvEmotes::new();
    };
    let get = |url: String| {
        let client = client.clone();
        async move {
            let response = time::timeout(SEVEN_TV_TIMEOUT, client.get(&url).send())
                .await
                .ok()?
                .ok()?;
            if !response.status().is_success() {
                return None;
            }
            time::timeout(SEVEN_TV_TIMEOUT, response.json::<Value>())
                .await
                .ok()?
                .ok()
        }
    };

    let channel_url = broadcaster_id.map(|id| format!("https://7tv.io/v3/users/twitch/{id}"));
    let (global, channel) = match channel_url {
        Some(url) => {
            let (global, channel) = tokio::join!(get(SEVEN_TV_GLOBAL_SET_URL.to_owned()), get(url));
            (global, channel)
        }
        None => (get(SEVEN_TV_GLOBAL_SET_URL.to_owned()).await, None),
    };

    let mut emotes = SevenTvEmotes::new();
    if let Some(global) = &global {
        collect_seven_tv_set(&mut emotes, global);
    }
    // 频道集后收：同名时覆盖全局条目，与 7TV 客户端的优先级一致。
    if let Some(channel) = channel.as_ref().and_then(|user| user.get("emote_set")) {
        collect_seven_tv_set(&mut emotes, channel);
    }
    emotes
}

/// 把已有片段里的文本部分按空白切词，命中 7TV 表情名的整词替换为图片。
///
/// 7TV 表情不进 IRC 标签，只以普通单词出现在消息里，因此只能靠名字匹配。
/// 匹配限定为完整的空白分隔词：子串匹配会把 `Kappa` 从 `Kappapride` 里
/// 切出来。
fn apply_seven_tv_spans(
    spans: Vec<DanmakuContentSpan>,
    emotes: &SevenTvEmotes,
) -> Vec<DanmakuContentSpan> {
    if emotes.is_empty() {
        return spans;
    }
    let mut output = Vec::with_capacity(spans.len());
    for span in spans {
        let DanmakuContentSpan::Text { text } = &span else {
            output.push(span);
            continue;
        };
        if !text
            .split_whitespace()
            .any(|word| emotes.contains_key(word))
        {
            output.push(span);
            continue;
        }
        // 保留原始空白：按分隔符切开后逐词判断，未命中的词连同其前导空白
        // 攒进当前文本片段。
        let mut pending = String::new();
        let mut rest = text.as_str();
        while !rest.is_empty() {
            let word_start = rest
                .find(|c: char| !c.is_whitespace())
                .unwrap_or(rest.len());
            let (separator, after) = rest.split_at(word_start);
            let word_end = after.find(char::is_whitespace).unwrap_or(after.len());
            let (word, tail) = after.split_at(word_end);
            match emotes.get(word) {
                Some(image_url) => {
                    pending.push_str(separator);
                    if !pending.is_empty() {
                        output.push(DanmakuContentSpan::Text {
                            text: std::mem::take(&mut pending),
                        });
                    }
                    output.push(DanmakuContentSpan::Image {
                        image_url: image_url.clone(),
                        // 7TV 第三方表情按大表情渲染：飘屏占两条车道并放大。
                        large: true,
                    });
                }
                None => {
                    pending.push_str(separator);
                    pending.push_str(word);
                }
            }
            rest = tail;
        }
        if !pending.is_empty() {
            output.push(DanmakuContentSpan::Text { text: pending });
        }
    }
    output.truncate(MAX_CONTENT_SPANS);
    output
}

/// 先按官方 `emotes` 标签分段，再在剩下的文本里匹配 7TV 表情。
///
/// 两者叠加而非二选一：一条消息可以同时包含官方表情和 7TV 表情。官方标签
/// 携带精确下标，因此先行；7TV 只能靠名字匹配，只在文本片段上做，不会
/// 碰到已识别的官方表情。
fn content_spans(
    tags: Option<&str>,
    content: &str,
    seven_tv: &SevenTvEmotes,
) -> Option<Vec<DanmakuContentSpan>> {
    let official = emote_spans(tags, content);
    if seven_tv.is_empty() {
        return official;
    }
    // 没有官方表情时以整条文本为起点，让 7TV 匹配仍能生效。
    let base = official.unwrap_or_else(|| {
        vec![DanmakuContentSpan::Text {
            text: content.to_owned(),
        }]
    });
    let spans = apply_seven_tv_spans(base, seven_tv);
    // 全是文本就不必带片段：前端会直接用 content 渲染。
    spans
        .iter()
        .any(|span| matches!(span, DanmakuContentSpan::Image { .. }))
        .then_some(spans)
}

fn safe_color(value: Option<&str>) -> Option<String> {
    let value = value?;
    (value.len() == 7
        && value.starts_with('#')
        && value.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit))
    .then(|| value.to_ascii_uppercase())
}

/// 把一条 Twitch IRC `PRIVMSG` 解码为通用的直播聊天负载。
///
/// IRC 服务器可能把多条以 CRLF 分隔的行放进同一个 WebSocket 消息，
/// 因此调用方要先拆分传输帧再交给这个解析器。
pub fn parse_privmsg(line: &str, seven_tv: &SevenTvEmotes) -> Option<DanmakuEvent> {
    let line = line.trim_end_matches('\r');
    let (tags, rest) = if let Some(after_tag) = line.strip_prefix('@') {
        let (tags, rest) = after_tag.split_once(' ')?;
        (Some(tags), rest)
    } else {
        (None, line)
    };
    let rest = rest.strip_prefix(':')?;
    let (prefix, command) = rest.split_once(' ')?;
    let command = command.strip_prefix("PRIVMSG ")?;
    let (_, content) = command.split_once(" :")?;
    if content.is_empty() {
        return None;
    }
    let nick = prefix.split('!').next().unwrap_or_default();
    let display_name = tag_value(tags, "display-name")
        .map(decode_tag_value)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| nick.to_owned());
    if display_name.is_empty() {
        return None;
    }
    Some(DanmakuEvent {
        kind: DanmakuKind::Chat,
        user: display_name,
        is_self: false,
        user_id: tag_value(tags, "user-id")
            .map(str::to_owned)
            .filter(|value| !value.is_empty() && value != "0"),
        content: content.to_owned(),
        color: safe_color(tag_value(tags, "color")),
        spans: content_spans(tags, content, seven_tv),
        super_chat: None,
        ts: chrono::Utc::now().timestamp_millis(),
    })
}

async fn send_irc<S>(
    write: &mut futures_util::stream::SplitSink<WebSocketStream<S>, Message>,
    line: String,
) -> AppResult<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    write
        .send(Message::Text(line.into()))
        .await
        .map_err(|error| {
            AppError::new(
                "twitch_danmaku_send",
                format!("Twitch IRC 发送失败: {error}"),
            )
            .with_site("twitch")
            .retryable()
        })
}

fn proxy_error(message: impl Into<String>) -> AppError {
    AppError::new("twitch_danmaku_proxy", message).with_site("twitch")
}

fn proxy_connection_error(message: impl Into<String>) -> AppError {
    proxy_error(message).retryable()
}

fn websocket_connection_error(error: impl std::fmt::Display) -> AppError {
    AppError::new(
        "twitch_danmaku_connect",
        format!("Twitch IRC 连接失败: {error}"),
    )
    .with_site("twitch")
    .retryable()
}

/// 解析与站点请求相同的、面向用户的 HTTP(S) 代理设置。
///
/// `reqwest::Proxy` 会把缺失的 scheme 视为 HTTP，因此这里保留该宽松行为，
/// 以兼容此前保存的 `127.0.0.1:7890` 之类设置。SOCKS 代理 URL 会被明确拒绝：
/// 本连接使用符合标准的 HTTP CONNECT 隧道，
/// 绝不能悄悄绕过用户选择的代理。
fn proxy_from_setting(proxy: Option<&str>) -> AppResult<Option<ConnectProxy>> {
    let Some(raw) = proxy.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let normalized = if raw.contains("://") {
        raw.to_owned()
    } else {
        format!("http://{raw}")
    };
    let url = Url::parse(&normalized)
        .map_err(|_| proxy_error("Twitch 弹幕代理地址无效，请使用 HTTP(S) 地址"))?;
    let scheme = match url.scheme() {
        "http" => ProxyScheme::Http,
        "https" => ProxyScheme::Https,
        _ => {
            return Err(proxy_error(
                "Twitch 弹幕仅支持 HTTP(S) 代理；请使用 http:// 或 https:// 地址",
            ));
        }
    };
    let host = url
        .host_str()
        .filter(|host| !host.is_empty())
        .ok_or_else(|| proxy_error("Twitch 弹幕代理地址缺少主机名"))?
        .to_owned();
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err(proxy_error(
            "Twitch 弹幕代理地址不能包含路径、查询参数或片段",
        ));
    }
    let port = url
        .port_or_known_default()
        .ok_or_else(|| proxy_error("Twitch 弹幕代理地址缺少端口"))?;

    Ok(Some(ConnectProxy {
        scheme,
        host,
        port,
        authorization: proxy_authorization(
            &url,
            &ProxyCredentialErrors {
                invalid_encoding: || proxy_error("Twitch 弹幕代理账号编码无效"),
                incomplete_credentials: || {
                    proxy_error("Twitch 弹幕代理账号需同时提供用户名和密码，或移除账号信息")
                },
            },
        )?,
    }))
}

async fn connect_proxy_tcp(proxy: &ConnectProxy) -> AppResult<TcpStream> {
    time::timeout(
        PROXY_CONNECT_TIMEOUT,
        TcpStream::connect((proxy.host.as_str(), proxy.port)),
    )
    .await
    .map_err(|_| proxy_connection_error("Twitch 弹幕代理连接超时"))?
    .map_err(|error| proxy_connection_error(format!("Twitch 弹幕代理连接失败: {error}")))
}

async fn read_proxy_response_line<S>(
    stream: &mut BufStream<S>,
    read_bytes: &mut usize,
) -> AppResult<Vec<u8>>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let remaining = MAX_PROXY_RESPONSE_HEADER_BYTES.saturating_sub(*read_bytes);
    if remaining == 0 {
        return Err(proxy_connection_error("Twitch 弹幕代理 CONNECT 响应头过大"));
    }
    let mut line = Vec::new();
    // 否则 `read_until` 会不断扩张目标缓冲区直到找到换行。本地代理同样是
    // 不可信的网络对端，因此在分配之前先限制每行响应
    // 以及完整响应头的长度。
    let mut limited = (&mut *stream).take(remaining as u64);
    let received = limited
        .read_until(b'\n', &mut line)
        .await
        .map_err(|error| proxy_connection_error(format!("Twitch 弹幕代理响应读取失败: {error}")))?;
    *read_bytes = read_bytes.saturating_add(received);
    if received == 0 {
        return Err(proxy_connection_error(
            "Twitch 弹幕代理在 CONNECT 响应前关闭了连接",
        ));
    }
    if *read_bytes > MAX_PROXY_RESPONSE_HEADER_BYTES {
        return Err(proxy_connection_error("Twitch 弹幕代理 CONNECT 响应头过大"));
    }
    if !line.ends_with(b"\r\n") {
        return Err(proxy_connection_error(
            "Twitch 弹幕代理返回了无效的 CONNECT 响应",
        ));
    }
    Ok(line)
}

async fn establish_connect_tunnel<S>(stream: S, proxy: &ConnectProxy) -> AppResult<BufStream<S>>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut stream = BufStream::new(stream);
    let request = connect_request(IRC_CONNECT_AUTHORITY, proxy.authorization.as_deref());
    stream.write_all(&request).await.map_err(|error| {
        proxy_connection_error(format!("Twitch 弹幕代理 CONNECT 请求发送失败: {error}"))
    })?;
    stream.flush().await.map_err(|error| {
        proxy_connection_error(format!("Twitch 弹幕代理 CONNECT 请求发送失败: {error}"))
    })?;

    let mut read_bytes = 0;
    let status_line = read_proxy_response_line(&mut stream, &mut read_bytes).await?;
    let status_line = std::str::from_utf8(&status_line)
        .map_err(|_| proxy_connection_error("Twitch 弹幕代理返回了无效的 CONNECT 响应"))?;
    let mut parts = status_line.split_ascii_whitespace();
    let valid_version = matches!(parts.next(), Some("HTTP/1.0" | "HTTP/1.1"));
    let status = parts.next().and_then(|value| value.parse::<u16>().ok());
    let Some(status) = status.filter(|_| valid_version) else {
        return Err(proxy_connection_error(
            "Twitch 弹幕代理返回了无效的 CONNECT 响应",
        ));
    };
    if status != 200 {
        return Err(proxy_error(format!(
            "Twitch 弹幕代理拒绝 CONNECT（HTTP {status}）"
        )));
    }

    loop {
        let line = read_proxy_response_line(&mut stream, &mut read_bytes).await?;
        if line == b"\r\n" {
            return Ok(stream);
        }
    }
}

async fn open_http_tunnel(proxy: &ConnectProxy) -> AppResult<BufStream<TcpStream>> {
    let stream = connect_proxy_tcp(proxy).await?;
    time::timeout(
        PROXY_CONNECT_TIMEOUT,
        establish_connect_tunnel(stream, proxy),
    )
    .await
    .map_err(|_| proxy_connection_error("Twitch 弹幕代理 CONNECT 超时"))?
}

async fn open_https_tunnel(
    proxy: &ConnectProxy,
) -> AppResult<BufStream<tokio_native_tls::TlsStream<TcpStream>>> {
    let stream = connect_proxy_tcp(proxy).await?;
    let native = NativeTlsConnector::new()
        .map_err(|error| proxy_error(format!("Twitch 弹幕代理 TLS 初始化失败: {error}")))?;
    let tls = TlsConnector::from(native);
    let stream = time::timeout(PROXY_CONNECT_TIMEOUT, tls.connect(&proxy.host, stream))
        .await
        .map_err(|_| proxy_connection_error("Twitch 弹幕代理 TLS 握手超时"))?
        .map_err(|error| {
            proxy_connection_error(format!("Twitch 弹幕代理 TLS 握手失败: {error}"))
        })?;
    time::timeout(
        PROXY_CONNECT_TIMEOUT,
        establish_connect_tunnel(stream, proxy),
    )
    .await
    .map_err(|_| proxy_connection_error("Twitch 弹幕代理 CONNECT 超时"))?
}

async fn run_irc_session<S>(
    events: &DanmakuEventSender,
    args: &TwitchDanmakuArgs,
    seven_tv: &SevenTvEmotes,
    socket: WebSocketStream<S>,
) -> AppResult<SessionEnd>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (mut write, mut read) = socket.split();
    let guest_number =
        chrono::Utc::now().timestamp_millis().unsigned_abs() % 90_000_000 + 10_000_000;
    send_irc(
        &mut write,
        "CAP REQ :twitch.tv/tags twitch.tv/commands".into(),
    )
    .await?;
    send_irc(&mut write, "PASS SCHMOOPIIE".into()).await?;
    send_irc(&mut write, format!("NICK justinfan{guest_number}")).await?;
    send_irc(&mut write, format!("JOIN #{}", args.channel_login)).await?;

    emit_system(events, "Twitch 弹幕服务器连接成功");
    let connected_at = Instant::now();
    let mut message_count = 0_u64;
    while let Some(message) = read.next().await {
        match message {
            Ok(Message::Text(text)) => {
                for line in text.lines() {
                    if let Some(ping) = line.strip_prefix("PING") {
                        send_irc(&mut write, format!("PONG{ping}")).await?;
                        continue;
                    }
                    if let Some(event) = parse_privmsg(line, seven_tv) {
                        message_count += 1;
                        emit_event(events, event);
                    }
                }
            }
            Ok(Message::Ping(payload)) => {
                write.send(Message::Pong(payload)).await.map_err(|error| {
                    AppError::new(
                        "twitch_danmaku_pong",
                        format!("Twitch PONG 发送失败: {error}"),
                    )
                    .with_site("twitch")
                    .retryable()
                })?;
            }
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(_) => {}
        }
    }
    emit_system(
        events,
        format!("Twitch 弹幕连接结束（已收 {message_count} 条）"),
    );
    Ok(SessionEnd {
        messages: message_count,
        connected_for: connected_at.elapsed(),
    })
}

/// 一次进入聊天循环的 IRC 会话的结果。
struct SessionEnd {
    messages: u64,
    connected_for: Duration,
}

pub async fn run_loop(
    events: DanmakuEventSender,
    args: TwitchDanmakuArgs,
    proxy: Option<String>,
) -> AppResult<()> {
    // 代理设置格式错误属于本地配置问题：每次重试都会以同样方式失败，
    // 因此直接报错而不是进入循环。
    let proxy_setting = proxy.clone();
    let proxy = proxy_from_setting(proxy.as_deref())?;

    // 7TV 表情表每个会话取一次，重连时复用：一两小时内主播改表情集的概率很低，
    // 不值得让每次断线重试都多背两个第三方请求。与 Twitch 请求走同一份代理
    // 设置：需要代理才能访问 Twitch 的网络环境里，7TV 同样访问不到。
    let seven_tv =
        fetch_seven_tv_emotes(args.broadcaster_id.as_deref(), proxy_setting.as_deref()).await;

    let mut policy = ReconnectPolicy::with_defaults("twitch");
    loop {
        let reason = match connect_and_run(&events, &args, &seven_tv, proxy.as_ref()).await {
            Ok(end) => DisconnectReason::Dropped {
                messages: end.messages,
                connected_for: end.connected_for,
                // IRC 循环退出时不保留传输层原因。
                detail: None,
            },
            // 拨号、隧道和 IRC 传输失败都是可恢复的；
            // 由策略决定这串失败何时算持续太久。
            Err(error) => DisconnectReason::transient(error.message),
        };
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

async fn connect_and_run(
    events: &DanmakuEventSender,
    args: &TwitchDanmakuArgs,
    seven_tv: &SevenTvEmotes,
    proxy: Option<&ConnectProxy>,
) -> AppResult<SessionEnd> {
    emit_system(events, "正在连接 Twitch 弹幕服务器…");
    match proxy {
        None => {
            let (socket, _) = connect_async(IRC_WS_URL)
                .await
                .map_err(websocket_connection_error)?;
            run_irc_session(events, args, seven_tv, socket).await
        }
        Some(proxy) => match proxy.scheme {
            ProxyScheme::Http => {
                let stream = open_http_tunnel(proxy).await?;
                let (socket, _) = time::timeout(
                    PROXY_CONNECT_TIMEOUT,
                    client_async_tls_with_config(IRC_WS_URL, stream, None, None),
                )
                .await
                .map_err(|_| proxy_connection_error("Twitch 弹幕 WebSocket 握手超时"))?
                .map_err(websocket_connection_error)?;
                run_irc_session(events, args, seven_tv, socket).await
            }
            ProxyScheme::Https => {
                let stream = open_https_tunnel(proxy).await?;
                let (socket, _) = time::timeout(
                    PROXY_CONNECT_TIMEOUT,
                    client_async_tls_with_config(IRC_WS_URL, stream, None, None),
                )
                .await
                .map_err(|_| proxy_connection_error("Twitch 弹幕 WebSocket 握手超时"))?
                .map_err(websocket_connection_error)?;
                run_irc_session(events, args, seven_tv, socket).await
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    use super::*;

    /// 绝大多数解析断言与第三方表情无关；用空表调用，让这些用例不必关心 7TV。
    fn parse_privmsg(line: &str) -> Option<DanmakuEvent> {
        super::parse_privmsg(line, &SevenTvEmotes::new())
    }

    #[test]
    fn extracts_a_tagged_privmsg() {
        let line = "@badge-info=;color=#1e90ff;display-name=viewer\\sname;user-id=42 :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #channel :hello Twitch";
        let event = parse_privmsg(line).unwrap();
        assert_eq!(event.user, "viewer name");
        assert_eq!(event.user_id.as_deref(), Some("42"));
        assert_eq!(event.content, "hello Twitch");
        assert_eq!(event.color.as_deref(), Some("#1E90FF"));
    }

    #[test]
    fn builds_image_spans_from_the_emotes_tag() {
        let line = "@display-name=viewer;emotes=1902:6-10,12-16/25:0-4 :viewer!x PRIVMSG #channel :Kappa Keepo Keepo";
        assert_eq!(
            parse_privmsg(line).unwrap().spans.unwrap(),
            vec![
                DanmakuContentSpan::Image {
                    image_url: format!("{EMOTE_CDN_BASE}/25/default/dark/2.0"),
                    large: false,
                },
                DanmakuContentSpan::Text { text: " ".into() },
                DanmakuContentSpan::Image {
                    image_url: format!("{EMOTE_CDN_BASE}/1902/default/dark/2.0"),
                    large: false,
                },
                DanmakuContentSpan::Text { text: " ".into() },
                DanmakuContentSpan::Image {
                    image_url: format!("{EMOTE_CDN_BASE}/1902/default/dark/2.0"),
                    large: false,
                },
            ],
        );

        // 尾部文本、多字节前缀与缺失标签都各自保持稳定。
        let trailing = "@display-name=viewer;emotes=25:2-6 :viewer!x PRIVMSG #channel :好 Kappa 呀";
        assert_eq!(
            parse_privmsg(trailing).unwrap().spans.unwrap(),
            vec![
                DanmakuContentSpan::Text {
                    text: "好 ".into()
                },
                DanmakuContentSpan::Image {
                    image_url: format!("{EMOTE_CDN_BASE}/25/default/dark/2.0"),
                    large: false,
                },
                DanmakuContentSpan::Text {
                    text: " 呀".into()
                },
            ],
        );
        let line = "@display-name=viewer;emotes= :viewer!x PRIVMSG #channel :hello";
        assert!(parse_privmsg(line).unwrap().spans.is_none());
    }

    #[test]
    fn drops_emote_spans_for_out_of_range_or_hostile_tags() {
        for tags in [
            "emotes=25:0-99",
            "emotes=25:5-1",
            "emotes=25:0-4,2-6",
            "emotes=../evil:0-4",
            "emotes=25:zero-four",
        ] {
            let line =
                format!("@display-name=viewer;{tags} :viewer!x PRIVMSG #channel :Kappa Keepo");
            assert!(parse_privmsg(&line).unwrap().spans.is_none(), "{tags}");
        }
    }

    #[test]
    fn rejects_non_chat_and_unsafe_colors() {
        assert!(parse_privmsg("PING :tmi.twitch.tv").is_none());
        let line = "@color=red;display-name=viewer :viewer!x PRIVMSG #channel :hello";
        assert!(parse_privmsg(line).unwrap().color.is_none());
    }

    fn seven_tv_set(name: &str, host_url: &str) -> Value {
        serde_json::json!({
            "emotes": [{
                "name": name,
                "data": {
                    "host": {
                        "url": host_url,
                        "files": [
                            { "name": "1x.webp" },
                            { "name": "2x.webp" },
                        ],
                    },
                },
            }],
        })
    }

    #[test]
    fn collects_seven_tv_emotes_and_prefers_the_2x_webp_file() {
        let mut emotes = SevenTvEmotes::new();
        collect_seven_tv_set(
            &mut emotes,
            &seven_tv_set("GAMBA", "//cdn.7tv.app/emote/01G3"),
        );
        assert_eq!(
            emotes.get("GAMBA").map(String::as_str),
            Some("https://cdn.7tv.app/emote/01G3/2x.webp"),
        );
    }

    #[test]
    fn collect_seven_tv_set_rejects_foreign_hosts_and_missing_webp() {
        // 响应里的主机名不可信：URL 直接进 img 标签。
        for host in [
            "//evil.example/emote/1",
            "//cdn.7tv.app.evil.example/emote/1",
            "https://cdn.7tv.app/emote/1?x=1",
        ] {
            let mut emotes = SevenTvEmotes::new();
            collect_seven_tv_set(&mut emotes, &seven_tv_set("Evil", host));
            assert!(emotes.is_empty(), "{host}");
        }

        // 名字带空白永远匹配不到切词结果，不收。
        let mut emotes = SevenTvEmotes::new();
        collect_seven_tv_set(
            &mut emotes,
            &seven_tv_set("two words", "//cdn.7tv.app/emote/1"),
        );
        assert!(emotes.is_empty());

        // 没有可用的 webp 档时跳过该表情。
        let mut emotes = SevenTvEmotes::new();
        collect_seven_tv_set(
            &mut emotes,
            &serde_json::json!({
                "emotes": [{
                    "name": "OnlyGif",
                    "data": { "host": {
                        "url": "//cdn.7tv.app/emote/1",
                        "files": [{ "name": "2x.gif" }],
                    } },
                }],
            }),
        );
        assert!(emotes.is_empty());
    }

    #[test]
    fn matches_seven_tv_emotes_as_whole_words_only() {
        let emotes = SevenTvEmotes::from([(
            "WideHard".to_owned(),
            "https://cdn.7tv.app/emote/1/2x.webp".to_owned(),
        )]);
        let line = "@display-name=viewer :viewer!x PRIVMSG #channel :look WideHard now";
        assert_eq!(
            super::parse_privmsg(line, &emotes).unwrap().spans.unwrap(),
            vec![
                DanmakuContentSpan::Text {
                    text: "look ".into(),
                },
                DanmakuContentSpan::Image {
                    image_url: "https://cdn.7tv.app/emote/1/2x.webp".into(),
                    large: true,
                },
                DanmakuContentSpan::Text {
                    text: " now".into(),
                },
            ],
        );

        // 子串不算命中，因此整条消息不带片段。
        let embedded = "@display-name=viewer :viewer!x PRIVMSG #channel :WideHardest";
        assert!(
            super::parse_privmsg(embedded, &emotes)
                .unwrap()
                .spans
                .is_none()
        );
    }

    #[test]
    fn layers_seven_tv_emotes_onto_official_emote_spans() {
        let emotes = SevenTvEmotes::from([(
            "GAMBA".to_owned(),
            "https://cdn.7tv.app/emote/2/2x.webp".to_owned(),
        )]);
        let line = "@display-name=viewer;emotes=25:0-4 :viewer!x PRIVMSG #channel :Kappa and GAMBA";
        assert_eq!(
            super::parse_privmsg(line, &emotes).unwrap().spans.unwrap(),
            vec![
                DanmakuContentSpan::Image {
                    image_url: format!("{EMOTE_CDN_BASE}/25/default/dark/2.0"),
                    large: false,
                },
                DanmakuContentSpan::Text {
                    text: " and ".into(),
                },
                DanmakuContentSpan::Image {
                    image_url: "https://cdn.7tv.app/emote/2/2x.webp".into(),
                    large: true,
                },
            ],
        );
    }

    #[test]
    fn gets_channel_from_room_raw() {
        let args =
            args_from_raw("fallback", &serde_json::json!({ "login": "Creator_One" })).unwrap();
        assert_eq!(args.channel_login, "creator_one");
        assert_eq!(args.broadcaster_id, None);

        // 房间详情携带的数字 ID 是 7TV 频道表情集的查询键。
        let with_id = args_from_raw(
            "fallback",
            &serde_json::json!({ "login": "creator", "broadcaster_id": "71092938" }),
        )
        .unwrap();
        assert_eq!(with_id.broadcaster_id.as_deref(), Some("71092938"));

        // 非数字值不能拼进第三方请求路径。
        let hostile = args_from_raw(
            "fallback",
            &serde_json::json!({ "login": "creator", "broadcaster_id": "../../evil" }),
        )
        .unwrap();
        assert_eq!(hostile.broadcaster_id, None);
    }

    #[test]
    fn parses_http_and_https_proxy_settings_without_retaining_raw_credentials() {
        let http = proxy_from_setting(Some("viewer%40name:pa%3Ass@127.0.0.1:7890"))
            .unwrap()
            .unwrap();
        assert!(matches!(http.scheme, ProxyScheme::Http));
        assert_eq!(http.host, "127.0.0.1");
        assert_eq!(http.port, 7890);
        assert_eq!(
            http.authorization.as_deref(),
            Some("dmlld2VyQG5hbWU6cGE6c3M=")
        );

        let https = proxy_from_setting(Some("https://localhost:8443/"))
            .unwrap()
            .unwrap();
        assert!(matches!(https.scheme, ProxyScheme::Https));
        assert_eq!(https.port, 8443);
        assert!(https.authorization.is_none());

        assert!(proxy_from_setting(Some("socks5://127.0.0.1:1080")).is_err());
        assert!(proxy_from_setting(Some("http://127.0.0.1:7890/extra")).is_err());
    }

    #[tokio::test]
    async fn http_proxy_tunnel_uses_connect_and_proxy_authentication() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 512];
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let received = stream.read(&mut buffer).unwrap();
                assert_ne!(received, 0);
                request.extend_from_slice(&buffer[..received]);
            }
            let request = String::from_utf8(request).unwrap();
            assert!(request.starts_with(
                "CONNECT irc-ws.chat.twitch.tv:443 HTTP/1.1\r\nHost: irc-ws.chat.twitch.tv:443\r\n"
            ));
            assert!(request.contains("Proxy-Authorization: Basic dmlld2VyOnNlY3JldA==\r\n"));
            stream
                .write_all(b"HTTP/1.1 200 Connection Established\r\nProxy-Agent: test\r\n\r\n")
                .unwrap();
        });

        let proxy = proxy_from_setting(Some(&format!("http://viewer:secret@{address}")))
            .unwrap()
            .unwrap();
        let tunnel = open_http_tunnel(&proxy).await.unwrap();
        drop(tunnel);
        server.join().unwrap();
    }
}
