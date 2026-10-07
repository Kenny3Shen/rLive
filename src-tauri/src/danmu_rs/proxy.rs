//! 站点弹幕共用的 HTTP CONNECT 代理工具。

use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use reqwest::Url;
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufStream},
    net::TcpStream,
    time,
};
use tokio_tungstenite::MaybeTlsStream;

use crate::error::{AppError, AppResult};

/// 由各站点提供的错误构造器，保证共享逻辑产生的错误码、
/// 消息与可重试标记和站点原先的手写实现逐字一致。
pub(crate) struct ProxyCredentialErrors {
    /// user-info 中出现非法的百分号编码序列。
    pub invalid_encoding: fn() -> AppError,
    /// 只提供了用户名或只提供了密码。
    pub incomplete_credentials: fn() -> AppError,
}

/// 解码 URL 的 user-info 部分且不把 `+` 当作空格。代理凭据属于 URL 组成部分
/// 而非表单数据，下面的 Basic 认证会安全地对结果字节重新编码。
///
/// 刻意不用 `percent_encoding`：它对非法序列按字面字节放行，
/// 而这里必须在用户拼错凭据时明确报错。
pub(crate) fn percent_decode_proxy_credential(
    value: &str,
    errors: &ProxyCredentialErrors,
) -> AppResult<Vec<u8>> {
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
            return Err((errors.invalid_encoding)());
        };
        let Some(low) = bytes.get(index + 2).and_then(|byte| hex(*byte)) else {
            return Err((errors.invalid_encoding)());
        };
        decoded.push((high << 4) | low);
        index += 3;
    }
    Ok(decoded)
}

pub(crate) fn proxy_authorization(
    url: &Url,
    errors: &ProxyCredentialErrors,
) -> AppResult<Option<String>> {
    let username = url.username();
    let password = url.password();
    if username.is_empty() && password.is_none() {
        return Ok(None);
    }
    let password = password.ok_or_else(errors.incomplete_credentials)?;

    let mut credentials = percent_decode_proxy_credential(username, errors)?;
    credentials.push(b':');
    credentials.extend(percent_decode_proxy_credential(password, errors)?);
    Ok(Some(STANDARD.encode(credentials)))
}

/// 构造标准的 HTTP CONNECT 请求字节。
pub(crate) fn connect_request(target: &str, authorization: Option<&str>) -> Vec<u8> {
    let mut request =
        format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\nProxy-Connection: Keep-Alive\r\n");
    if let Some(credential) = authorization {
        request.push_str("Proxy-Authorization: Basic ");
        request.push_str(credential);
        request.push_str("\r\n");
    }
    request.push_str("\r\n");
    request.into_bytes()
}

pub(crate) const PROXY_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_PROXY_RESPONSE_HEADER_BYTES: usize = 16 * 1024;

#[derive(Clone, Copy)]
enum ProxyScheme {
    Http,
    Https,
}

#[derive(Clone, Copy)]
struct ProxyContext {
    site: &'static str,
    name: &'static str,
}

impl ProxyContext {
    fn error(self, message: impl std::fmt::Display) -> AppError {
        AppError::new(
            format!("{}_danmaku_proxy", self.site),
            format!("{} 弹幕{message}", self.name),
        )
        .with_site(self.site)
    }

    fn connection_error(self, message: impl std::fmt::Display) -> AppError {
        self.error(message).retryable()
    }
}

/// 只保存连接所需字段，避免原始代理 URL 或凭据被写入日志。
pub(crate) struct ConnectProxy {
    scheme: ProxyScheme,
    host: String,
    port: u16,
    authorization: Option<String>,
    context: ProxyContext,
}

impl ConnectProxy {
    /// 根据当前代理路由与目标站点构造隧道配置。
    ///
    /// 「关闭」返回 `None`（直连）；「自动」在目标主机命中绕过列表或系统没有
    /// 配置代理时也返回 `None`，否则用系统代理建立 CONNECT 隧道。
    pub(crate) fn from_route(
        route: &crate::proxy::ProxyRoute,
        authority: &str,
        site: &'static str,
        name: &'static str,
    ) -> AppResult<Option<Self>> {
        Self::from_setting(route.upstream_for_authority(authority), site, name)
    }

    pub(crate) fn from_setting(
        proxy: Option<&str>,
        site: &'static str,
        name: &'static str,
    ) -> AppResult<Option<Self>> {
        let Some(raw) = proxy.map(str::trim).filter(|value| !value.is_empty()) else {
            return Ok(None);
        };
        let context = ProxyContext { site, name };
        // 与 reqwest 一致，未写 scheme 的本地代理按 HTTP 解释。
        let normalized = if raw.contains("://") {
            raw.to_owned()
        } else {
            format!("http://{raw}")
        };
        let url = Url::parse(&normalized)
            .map_err(|_| context.error("代理地址无效，请使用 HTTP(S) 地址"))?;
        let scheme = match url.scheme() {
            "http" => ProxyScheme::Http,
            "https" => ProxyScheme::Https,
            _ => {
                return Err(context.error("仅支持 HTTP(S) 代理；请使用 http:// 或 https:// 地址"));
            }
        };
        let host = url
            .host_str()
            .filter(|host| !host.is_empty())
            .ok_or_else(|| context.error("代理地址缺少主机名"))?
            .to_owned();
        if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
            return Err(context.error("代理地址不能包含路径、查询参数或片段"));
        }
        let port = url
            .port_or_known_default()
            .ok_or_else(|| context.error("代理地址缺少端口"))?;
        let authorization = proxy_authorization(
            &url,
            &ProxyCredentialErrors {
                invalid_encoding: || AppError::new("proxy_invalid_encoding", "代理账号编码无效"),
                incomplete_credentials: || {
                    AppError::new(
                        "proxy_incomplete_credentials",
                        "代理账号需同时提供用户名和密码，或移除账号信息",
                    )
                },
            },
        )
        .map_err(|error| context.error(error.message))?;

        Ok(Some(Self {
            scheme,
            host,
            port,
            authorization,
            context,
        }))
    }

    /// 目标域名交给代理解析；BufStream 保留与响应头一起到达的隧道数据。
    pub(crate) async fn open_tunnel(
        &self,
        authority: &str,
        tune_socket: Option<fn(&TcpStream)>,
    ) -> AppResult<BufStream<MaybeTlsStream<TcpStream>>> {
        let context = self.context;
        let stream = time::timeout(
            PROXY_CONNECT_TIMEOUT,
            TcpStream::connect((self.host.as_str(), self.port)),
        )
        .await
        .map_err(|_| context.connection_error("代理连接超时"))?
        .map_err(|error| context.connection_error(format!("代理连接失败: {error}")))?;
        if let Some(tune_socket) = tune_socket {
            tune_socket(&stream);
        }

        let stream = match self.scheme {
            ProxyScheme::Http => MaybeTlsStream::Plain(stream),
            ProxyScheme::Https => {
                let native = native_tls::TlsConnector::new()
                    .map_err(|error| context.error(format!("代理 TLS 初始化失败: {error}")))?;
                let tls = tokio_native_tls::TlsConnector::from(native);
                let stream = time::timeout(PROXY_CONNECT_TIMEOUT, tls.connect(&self.host, stream))
                    .await
                    .map_err(|_| context.connection_error("代理 TLS 握手超时"))?
                    .map_err(|error| {
                        context.connection_error(format!("代理 TLS 握手失败: {error}"))
                    })?;
                MaybeTlsStream::NativeTls(stream)
            }
        };
        time::timeout(
            PROXY_CONNECT_TIMEOUT,
            establish_connect_tunnel(stream, authority, self),
        )
        .await
        .map_err(|_| context.connection_error("代理 CONNECT 超时"))?
    }
}

async fn read_proxy_response_line<S>(
    stream: &mut BufStream<S>,
    read_bytes: &mut usize,
    context: ProxyContext,
) -> AppResult<Vec<u8>>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let remaining = MAX_PROXY_RESPONSE_HEADER_BYTES.saturating_sub(*read_bytes);
    if remaining == 0 {
        return Err(context.connection_error("代理 CONNECT 响应头过大"));
    }
    let mut line = Vec::new();
    let mut limited = (&mut *stream).take(remaining as u64);
    let received = limited
        .read_until(b'\n', &mut line)
        .await
        .map_err(|error| context.connection_error(format!("代理响应读取失败: {error}")))?;
    *read_bytes = read_bytes.saturating_add(received);
    if received == 0 {
        return Err(context.connection_error("代理在 CONNECT 响应前关闭了连接"));
    }
    if !line.ends_with(b"\r\n") {
        return Err(context.connection_error("代理返回了无效的 CONNECT 响应"));
    }
    Ok(line)
}

async fn establish_connect_tunnel<S>(
    stream: S,
    authority: &str,
    proxy: &ConnectProxy,
) -> AppResult<BufStream<S>>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut stream = BufStream::new(stream);
    let context = proxy.context;
    let request = connect_request(authority, proxy.authorization.as_deref());
    stream
        .write_all(&request)
        .await
        .map_err(|error| context.connection_error(format!("代理 CONNECT 请求发送失败: {error}")))?;
    stream
        .flush()
        .await
        .map_err(|error| context.connection_error(format!("代理 CONNECT 请求发送失败: {error}")))?;

    let mut read_bytes = 0;
    let status_line = read_proxy_response_line(&mut stream, &mut read_bytes, context).await?;
    let status_line = std::str::from_utf8(&status_line)
        .map_err(|_| context.connection_error("代理返回了无效的 CONNECT 响应"))?;
    let mut parts = status_line.split_ascii_whitespace();
    let valid_version = matches!(parts.next(), Some("HTTP/1.0" | "HTTP/1.1"));
    let status = parts.next().and_then(|value| value.parse::<u16>().ok());
    let Some(status) = status.filter(|_| valid_version) else {
        return Err(context.connection_error("代理返回了无效的 CONNECT 响应"));
    };
    if status != 200 {
        return Err(context.error(format!("代理拒绝 CONNECT（HTTP {status}）")));
    }

    loop {
        let line = read_proxy_response_line(&mut stream, &mut read_bytes, context).await?;
        if line == b"\r\n" {
            return Ok(stream);
        }
    }
}

/// 按路由打开一条弹幕 WebSocket 的传输。
///
/// `proxy` 为 `None` 表示确定直连（关闭模式、自动模式命中绕过列表、或自动模式
/// 没有可用代理）。两个分支返回同一形状的 `BufStream<MaybeTlsStream>`，因此
/// 调用方可以无条件把结果交给 `client_async_tls_with_config`；直连分支同样
/// 应用 `tune_socket`，避免两条路径的套接字参数出现差异。
///
/// 错误返回为字符串：各站点的错误码、文案与重试提示不同，由调用方决定
/// 应该归类为“临时故障”还是面向用户的命令错误。
pub(crate) async fn open_websocket_transport(
    proxy: Option<&ConnectProxy>,
    host: &str,
    port: u16,
    tune_socket: Option<fn(&TcpStream)>,
) -> Result<BufStream<MaybeTlsStream<TcpStream>>, String> {
    let Some(proxy) = proxy else {
        let stream = time::timeout(PROXY_CONNECT_TIMEOUT, TcpStream::connect((host, port)))
            .await
            .map_err(|_| "连接弹幕服务器超时".to_owned())?
            .map_err(|error| format!("连接弹幕服务器失败: {error}"))?;
        if let Some(tune_socket) = tune_socket {
            tune_socket(&stream);
        }
        return Ok(BufStream::new(MaybeTlsStream::Plain(stream)));
    };
    proxy
        .open_tunnel(&format!("{host}:{port}"), tune_socket)
        .await
        .map_err(|error| error.message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_http_and_https_proxy_settings_without_retaining_raw_credentials() {
        let http = ConnectProxy::from_setting(
            Some("viewer%40name:pa%3Ass@127.0.0.1:7890"),
            "twitch",
            "Twitch",
        )
        .unwrap()
        .unwrap();
        assert!(matches!(http.scheme, ProxyScheme::Http));
        assert_eq!(http.host, "127.0.0.1");
        assert_eq!(http.port, 7890);
        assert_eq!(
            http.authorization.as_deref(),
            Some("dmlld2VyQG5hbWU6cGE6c3M=")
        );

        let https = ConnectProxy::from_setting(Some("https://localhost:8443/"), "bilibili", "B站")
            .unwrap()
            .unwrap();
        assert!(matches!(https.scheme, ProxyScheme::Https));
        assert_eq!(https.port, 8443);
        assert!(https.authorization.is_none());

        for setting in [
            "socks5://127.0.0.1:1080",
            "http://127.0.0.1:7890/extra",
            "http://viewer@127.0.0.1:7890",
            "http://viewer:pa%ZZss@127.0.0.1:7890",
        ] {
            let error = ConnectProxy::from_setting(Some(setting), "twitch", "Twitch")
                .err()
                .unwrap();
            assert_eq!(error.code, "twitch_danmaku_proxy");
            assert!(!error.retryable);
            assert!(!error.message.contains("viewer"));
        }
        assert!(
            ConnectProxy::from_setting(Some("  "), "bilibili", "B站")
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn tunnel_preserves_buffered_data_and_uses_proxy_authentication() {
        let (stream, mut server) = tokio::io::duplex(4096);
        let server = tokio::spawn(async move {
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(server.read_u8().await.unwrap());
            }
            let request = String::from_utf8(request).unwrap();
            assert!(
                request
                    .starts_with("CONNECT chat.invalid:443 HTTP/1.1\r\nHost: chat.invalid:443\r\n")
            );
            assert!(request.contains("Proxy-Authorization: Basic dmlld2VyOnNlY3JldA==\r\n"));
            server
                .write_all(
                    b"HTTP/1.1 200 Connection Established\r\nProxy-Agent: test\r\n\r\npayload",
                )
                .await
                .unwrap();
        });
        let proxy = ConnectProxy::from_setting(
            Some("http://viewer:secret@127.0.0.1:7890"),
            "bilibili",
            "B站",
        )
        .unwrap()
        .unwrap();
        let mut tunnel = establish_connect_tunnel(stream, "chat.invalid:443", &proxy)
            .await
            .unwrap();
        let mut payload = String::new();
        tunnel.read_to_string(&mut payload).await.unwrap();
        assert_eq!(payload, "payload");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn tunnel_rejects_failed_malformed_and_oversized_responses() {
        for response in [
            b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n".to_vec(),
            b"not-http 200 OK\r\n\r\n".to_vec(),
            vec![b'x'; MAX_PROXY_RESPONSE_HEADER_BYTES + 1],
        ] {
            let (stream, mut server) = tokio::io::duplex(32 * 1024);
            let server = tokio::spawn(async move {
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    request.push(server.read_u8().await.unwrap());
                }
                server.write_all(&response).await.unwrap();
            });
            let proxy = ConnectProxy::from_setting(Some("127.0.0.1:7890"), "bilibili", "B站")
                .unwrap()
                .unwrap();
            assert!(
                establish_connect_tunnel(stream, "chat.invalid:443", &proxy)
                    .await
                    .is_err()
            );
            server.await.unwrap();
        }
    }
}
