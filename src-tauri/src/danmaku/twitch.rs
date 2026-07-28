//! Anonymous Twitch IRC chat over WebSocket.
//!
//! Twitch permits read-only chat with the documented `justinfan` anonymous
//! identity. No user OAuth token or saved Cookie is needed to receive public
//! channel messages.

use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::{SinkExt, StreamExt};
use reqwest::Url;
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufStream},
    net::TcpStream,
    time,
};
use tokio_tungstenite::{WebSocketStream, client_async_tls, connect_async, tungstenite::Message};

use crate::danmaku::{DanmakuEventSender, emit_event};
use crate::error::{AppError, AppResult};
use crate::models::live::{DanmakuEvent, DanmakuKind};

const IRC_WS_URL: &str = "wss://irc-ws.chat.twitch.tv:443";
const IRC_CONNECT_AUTHORITY: &str = "irc-ws.chat.twitch.tv:443";
const PROXY_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_PROXY_RESPONSE_HEADER_BYTES: usize = 16 * 1024;

#[derive(Clone, Copy)]
enum ProxyScheme {
    Http,
    Https,
}

/// Sanitised HTTP CONNECT proxy configuration for the anonymous IRC client.
///
/// The source setting is deliberately not retained: aside from avoiding
/// accidental credential logging, the WebSocket path only needs an address
/// and an optional already-encoded `Proxy-Authorization` value.
struct ConnectProxy {
    scheme: ProxyScheme,
    host: String,
    port: u16,
    authorization: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TwitchDanmakuArgs {
    pub channel_login: String,
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

fn safe_color(value: Option<&str>) -> Option<String> {
    let value = value?;
    (value.len() == 7
        && value.starts_with('#')
        && value.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit))
    .then(|| value.to_ascii_uppercase())
}

/// Decode one Twitch IRC `PRIVMSG` into the common live-chat payload.
///
/// The IRC server can put multiple CRLF-delimited lines into one WebSocket
/// message, so callers split the transport frame before feeding this parser.
pub fn parse_privmsg(line: &str) -> Option<DanmakuEvent> {
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
        spans: None,
        super_chat: None,
        ts: chrono::Utc::now().timestamp_millis(),
    })
}

fn system_event(content: impl Into<String>) -> DanmakuEvent {
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
    }
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

/// Decode the percent-encoded URL user-info component without treating `+`
/// as a space (URL credentials are not form data).
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
            return Err(proxy_error("Twitch 弹幕代理账号编码无效"));
        };
        let Some(low) = bytes.get(index + 2).and_then(|byte| hex(*byte)) else {
            return Err(proxy_error("Twitch 弹幕代理账号编码无效"));
        };
        decoded.push((high << 4) | low);
        index += 3;
    }
    Ok(decoded)
}

fn proxy_authorization(url: &Url) -> AppResult<Option<String>> {
    let username = url.username();
    let password = url.password();
    if username.is_empty() && password.is_none() {
        return Ok(None);
    }
    let password = password
        .ok_or_else(|| proxy_error("Twitch 弹幕代理账号需同时提供用户名和密码，或移除账号信息"))?;

    let mut credentials = percent_decode_proxy_credential(username)?;
    credentials.push(b':');
    credentials.extend(percent_decode_proxy_credential(password)?);
    Ok(Some(STANDARD.encode(credentials)))
}

/// Parse the same user-facing HTTP(S) proxy setting used by site requests.
///
/// `reqwest::Proxy` accepts a missing scheme as HTTP, so retain that friendly
/// behavior for previously saved `127.0.0.1:7890` settings. SOCKS proxy URLs
/// are rejected explicitly: this connection uses a standards-compliant HTTP
/// CONNECT tunnel and must not silently bypass a user's selected proxy.
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
        authorization: proxy_authorization(&url)?,
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
    // `read_until` otherwise grows its destination until it finds a newline.
    // A local proxy is still an untrusted network peer, so cap each response
    // line and the complete response header before allocating it.
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
    let mut request = format!(
        "CONNECT {IRC_CONNECT_AUTHORITY} HTTP/1.1\r\nHost: {IRC_CONNECT_AUTHORITY}\r\nProxy-Connection: Keep-Alive\r\n"
    );
    if let Some(authorization) = &proxy.authorization {
        request.push_str("Proxy-Authorization: Basic ");
        request.push_str(authorization);
        request.push_str("\r\n");
    }
    request.push_str("\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|error| {
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
    let connector = tokio_native_tls::native_tls::TlsConnector::new()
        .map(tokio_native_tls::TlsConnector::from)
        .map_err(|error| proxy_error(format!("Twitch 弹幕代理 TLS 初始化失败: {error}")))?;
    let stream = time::timeout(
        PROXY_CONNECT_TIMEOUT,
        connector.connect(&proxy.host, stream),
    )
    .await
    .map_err(|_| proxy_connection_error("Twitch 弹幕代理 TLS 握手超时"))?
    .map_err(|error| proxy_connection_error(format!("Twitch 弹幕代理 TLS 握手失败: {error}")))?;
    time::timeout(
        PROXY_CONNECT_TIMEOUT,
        establish_connect_tunnel(stream, proxy),
    )
    .await
    .map_err(|_| proxy_connection_error("Twitch 弹幕代理 CONNECT 超时"))?
}

async fn run_irc_session<S>(
    events: DanmakuEventSender,
    args: TwitchDanmakuArgs,
    socket: WebSocketStream<S>,
) -> AppResult<()>
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

    emit_event(&events, system_event("Twitch 弹幕服务器连接成功"));
    let mut message_count = 0_u64;
    while let Some(message) = read.next().await {
        match message {
            Ok(Message::Text(text)) => {
                for line in text.lines() {
                    if let Some(ping) = line.strip_prefix("PING") {
                        send_irc(&mut write, format!("PONG{ping}")).await?;
                        continue;
                    }
                    if let Some(event) = parse_privmsg(line) {
                        message_count += 1;
                        emit_event(&events, event);
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
    emit_event(
        &events,
        system_event(format!("Twitch 弹幕连接结束（已收 {message_count} 条）")),
    );
    Ok(())
}

pub async fn run_loop(
    events: DanmakuEventSender,
    args: TwitchDanmakuArgs,
    proxy: Option<String>,
) -> AppResult<()> {
    emit_event(
        &events,
        system_event(format!(
            "正在连接 Twitch 弹幕服务器… #{}",
            args.channel_login
        )),
    );
    match proxy_from_setting(proxy.as_deref())? {
        None => {
            let (socket, _) = connect_async(IRC_WS_URL)
                .await
                .map_err(websocket_connection_error)?;
            run_irc_session(events, args, socket).await
        }
        Some(proxy) => match proxy.scheme {
            ProxyScheme::Http => {
                let stream = open_http_tunnel(&proxy).await?;
                let (socket, _) =
                    time::timeout(PROXY_CONNECT_TIMEOUT, client_async_tls(IRC_WS_URL, stream))
                        .await
                        .map_err(|_| proxy_connection_error("Twitch 弹幕 WebSocket 握手超时"))?
                        .map_err(websocket_connection_error)?;
                run_irc_session(events, args, socket).await
            }
            ProxyScheme::Https => {
                let stream = open_https_tunnel(&proxy).await?;
                let (socket, _) =
                    time::timeout(PROXY_CONNECT_TIMEOUT, client_async_tls(IRC_WS_URL, stream))
                        .await
                        .map_err(|_| proxy_connection_error("Twitch 弹幕 WebSocket 握手超时"))?
                        .map_err(websocket_connection_error)?;
                run_irc_session(events, args, socket).await
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    use super::*;

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
    fn rejects_non_chat_and_unsafe_colors() {
        assert!(parse_privmsg("PING :tmi.twitch.tv").is_none());
        let line = "@color=red;display-name=viewer :viewer!x PRIVMSG #channel :hello";
        assert!(parse_privmsg(line).unwrap().color.is_none());
    }

    #[test]
    fn gets_channel_from_room_raw() {
        let args =
            args_from_raw("fallback", &serde_json::json!({ "login": "Creator_One" })).unwrap();
        assert_eq!(args.channel_login, "creator_one");
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
