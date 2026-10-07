//! 直播站点后端共享的 HTTP 客户端构建器。

use std::sync::OnceLock;
use std::time::Duration;

use reqwest::{Client, ClientBuilder, Url};

use crate::error::{AppError, AppResult};
use crate::proxy::ProxyRoute;

static DEFAULT_CLIENT: OnceLock<Client> = OnceLock::new();
static DIRECT_CLIENT: OnceLock<Client> = OnceLock::new();

/// 把一条代理路由应用到客户端构建器上。
///
/// 集中在一处很重要：直播站点元数据请求与本机媒体中继采用不同的超时策略，
/// 但访问 Twitch 这类有地区限制的服务时，
/// 两者必须走同一条路由。
///
/// 三种模式在这里统一落地：
/// - 自定义：显式地址；
/// - 关闭：`no_proxy()`，连同环境变量与系统代理一起忽略；
/// - 自动：逐个 scheme 应用解析出的系统代理，并按绕过列表排除主机。
///
/// 「自动」不能用 `reqwest` 自带的系统代理探测：那个功能只在构建期启用、
/// 且解析结果无法复用到录制与弹幕隧道，还会把 `NO_PROXY` 之外的绕过规则
/// 与自定义地址混在一起。
pub(crate) fn with_route(builder: ClientBuilder, route: &ProxyRoute) -> AppResult<ClientBuilder> {
    // 先清除构建器已有代理和隐式系统探测。自定义模式也不继承 NO_PROXY。
    let builder = builder.no_proxy();
    match route {
        ProxyRoute::Direct | ProxyRoute::System(None) => Ok(builder),
        ProxyRoute::Custom(proxy_url) => {
            let proxy = reqwest::Proxy::all(proxy_url.as_str())
                .map_err(|_| AppError::new("proxy_invalid", "代理地址无效"))?;
            Ok(builder.proxy(proxy))
        }
        ProxyRoute::System(Some(_)) => {
            // reqwest::NoProxy 不理解 Windows 的 <local>/通配符；统一使用
            // ProxyRoute 的匹配器，让 HTTP、CONNECT 与录制的绕过行为一致。
            let route = route.clone();
            Ok(builder.proxy(reqwest::Proxy::custom(move |url| {
                route.upstream_for_url(url).map(str::to_owned)
            })))
        }
    }
}

/// 共享客户端策略：native-tls、压缩与连接池参数，不含代理决策。
fn base_builder() -> ClientBuilder {
    Client::builder()
        .use_native_tls()
        .gzip(true)
        .brotli(true)
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .pool_max_idle_per_host(4)
        .user_agent(crate::sites::bilibili::DEFAULT_USER_AGENT)
}

/// 共享客户端策略：native-tls、压缩，以及给定的代理路由。
fn client_builder(route: &ProxyRoute) -> AppResult<ClientBuilder> {
    with_route(base_builder(), route)
}

/// 构建带 native-tls、gzip/brotli 与给定代理路由的 reqwest 客户端。
pub fn build_client(route: &ProxyRoute) -> AppResult<Client> {
    client_builder(route)?
        .build()
        .map_err(|_| AppError::new("http_client_build", "网络客户端初始化失败"))
}

/// 在共享直连客户端与绑定给定路由的新客户端之间做选择。
///
/// reqwest 客户端自带代理策略，因此任何显式路由的请求绝不能复用进程级
/// 直连客户端。只有确定直连且系统无代理时才保留直连客户端的连接池。
pub fn client_for_route(route: &ProxyRoute) -> AppResult<Client> {
    match route {
        ProxyRoute::Direct => Ok(direct_client()),
        ProxyRoute::System(None) => Ok(direct_client()),
        _ => build_client(route),
    }
}

/// 构建长时间运行的直播录制所用的原始 HTTP/1.1 客户端。
///
/// 与 API 请求不同，健康的直播响应可以无限期保持打开，
/// 因此该客户端刻意不设总超时。自动内容解码同样关闭：
/// 媒体字节必须按 CDN 发送的原样写入，
/// 即使 CDN 错误地附加了 Content-Encoding 头。
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
pub fn recording_stream_client_for_route(route: &ProxyRoute) -> AppResult<Client> {
    with_route(
        Client::builder()
            .use_native_tls()
            .gzip(false)
            .brotli(false)
            .http1_only()
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(45))
            .pool_max_idle_per_host(2)
            .user_agent(crate::sites::bilibili::DEFAULT_USER_AGENT),
        route,
    )?
    .build()
    .map_err(|_| AppError::new("http_client_build", "录制网络客户端初始化失败"))
}

/// 用于携带机密且绝不跟随服务端选定目标的请求
/// （例如带 Cookie 的签名请求）的客户端。
pub fn build_no_redirect_client(route: &ProxyRoute) -> AppResult<Client> {
    client_builder(route)?
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| AppError::new("http_client_build", "网络客户端初始化失败"))
}

/// 明确不走任何代理的客户端，包括进程环境变量与系统代理。
///
/// 当已配置的代理出口被平台风控拒绝、需要换直连重试时，
/// 必须用这个客户端，否则回退会再次落到同一条出口。克隆开销低（内部为 Arc）。
pub fn direct_client() -> Client {
    DIRECT_CLIENT
        .get_or_init(|| {
            base_builder().no_proxy().build().unwrap_or_else(|_| {
                Client::builder()
                    .use_native_tls()
                    .no_proxy()
                    .timeout(Duration::from_secs(20))
                    .build()
                    .expect("fallback reqwest client")
            })
        })
        .clone()
}

/// 共享默认客户端（完全直连）。
///
/// 它与 [`direct_client`] 是同一个实例：调用方要么已经解析出路由，
/// 要么明确需要一条不受设置影响的出口，不存在「隐式跟随系统」的第三种语义。
/// 克隆开销低（内部为 Arc）。
pub fn default_client() -> Client {
    DEFAULT_CLIENT.get_or_init(direct_client).clone()
}

/// 记录请求失败时保留根因和安全的 endpoint，但移除 query、fragment 与 user-info。
/// Bilibili 的 WBI 参数可能包含短时签名值，不能直接使用 reqwest 的错误字符串。
pub(crate) fn describe_request_error(error: &reqwest::Error) -> String {
    let endpoint = error.url().map(safe_request_url);
    let mut causes = Vec::new();
    let mut current = std::error::Error::source(error);
    while let Some(cause) = current {
        let text = cause.to_string();
        if !text.is_empty() && !causes.iter().any(|seen| seen == &text) {
            causes.push(text);
        }
        current = cause.source();
    }
    let root = if causes.is_empty() {
        "request failed".to_string()
    } else {
        causes.join(": ")
    };
    match endpoint {
        Some(endpoint) => format!("{root} (url={endpoint})"),
        None => root,
    }
}

fn safe_request_url(url: &Url) -> String {
    let mut safe = url.clone();
    let _ = safe.set_username("");
    let _ = safe.set_password(None);
    safe.set_query(None);
    safe.set_fragment(None);
    safe.to_string()
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    use reqwest::Url;

    use super::{
        build_no_redirect_client, client_for_route, describe_request_error,
        recording_stream_client_for_route,
    };
    use crate::proxy::ProxyRoute;

    #[test]
    fn request_error_endpoint_drops_credentials_and_query() {
        let url =
            Url::parse("https://user:secret@example.test/path?token=private#fragment").unwrap();
        assert_eq!(super::safe_request_url(&url), "https://example.test/path");
    }

    #[tokio::test]
    async fn request_error_keeps_a_network_root_cause_without_query_values() {
        struct FailingDns;

        impl reqwest::dns::Resolve for FailingDns {
            fn resolve(&self, _name: reqwest::dns::Name) -> reqwest::dns::Resolving {
                Box::pin(async {
                    Err(
                        std::io::Error::new(std::io::ErrorKind::NotFound, "test DNS lookup failed")
                            .into(),
                    )
                })
            }
        }

        let error = reqwest::Client::builder()
            .no_proxy()
            .dns_resolver(std::sync::Arc::new(FailingDns))
            .build()
            .unwrap()
            .get("http://user:secret@bilibili.invalid/path?token=private#fragment")
            .header("cookie", "SESSDATA=private")
            .send()
            .await
            .unwrap_err();
        let text = describe_request_error(&error);
        assert!(text.contains("test DNS lookup failed"), "{text}");
        assert!(text.contains("http://bilibili.invalid/path"));
        assert!(!text.contains("private"));
        assert!(!text.contains("secret"));
        assert!(!text.contains("fragment"));
    }

    #[tokio::test]
    async fn no_redirect_client_returns_the_signer_redirect_response() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            stream
                .write_all(
                    b"HTTP/1.1 307 Temporary Redirect\r\nLocation: http://example.invalid/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
        });

        let response = build_no_redirect_client(&ProxyRoute::Direct)
            .unwrap()
            .get(format!("http://{address}/sign"))
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), reqwest::StatusCode::TEMPORARY_REDIRECT);
        server.join().unwrap();
    }

    #[tokio::test]
    async fn configured_proxy_receives_live_site_http_requests() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 2048];
            let length = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..length]);
            // HTTP 代理收到的是绝对 URL。如果客户端发起的是直连请求，
            // 这个回环监听器将永远看不到它。
            assert!(request.starts_with("GET http://twitch.invalid/gql HTTP/1.1"));
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 9\r\nConnection: close\r\n\r\nvia-proxy",
                )
                .unwrap();
        });

        let client = client_for_route(&ProxyRoute::Custom(format!("http://{address}"))).unwrap();
        let response = client
            .get("http://twitch.invalid/gql")
            .send()
            .await
            .unwrap();

        assert_eq!(response.text().await.unwrap(), "via-proxy");
        server.join().unwrap();
    }

    /// 只为子进程设置环境，不在并行测试进程里修改全局环境。
    #[test]
    fn explicit_routes_ignore_environment_in_an_isolated_process() {
        const MARKER: &str = "RLIVE_PROXY_ENV_TEST";
        if std::env::var_os(MARKER).is_none() {
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "http_client::tests::explicit_routes_ignore_environment_in_an_isolated_process",
                    "--nocapture",
                ])
                .env(MARKER, "1");
            for name in [
                "http_proxy",
                "HTTP_PROXY",
                "https_proxy",
                "HTTPS_PROXY",
                "all_proxy",
                "ALL_PROXY",
            ] {
                command.env(name, "http://127.0.0.1:1");
            }
            let output = command
                .env("no_proxy", "")
                .env("NO_PROXY", "")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            // 自定义模式必须忽略 NO_PROXY=*，不能被环境强制改成直连。
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "http_client::tests::configured_proxy_receives_live_site_http_requests",
                    "--nocapture",
                ])
                .env("no_proxy", "*")
                .env("NO_PROXY", "*")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = [0; 2048];
                let _ = socket.read(&mut bytes).await.unwrap();
                socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\ndirect",
                    )
                    .await
                    .unwrap();
            });
            let response = client_for_route(&ProxyRoute::Direct)
                .unwrap()
                .get(url)
                .send()
                .await
                .unwrap();
            assert_eq!(response.text().await.unwrap(), "direct");
            server.await.unwrap();
        });
    }

    /// 「关闭」的客户端必须落到明确无代理的构建路径上。
    ///
    /// 这里不去改写进程环境变量：测试是并行跑的，`http_proxy` 是进程级的，
    /// 改它会让同时在跑的 `proxy::system_proxy()` 用例随机失败。
    /// 环境变量与系统代理是否真的被忽略，由 `proxy::tests` 在纯函数层面锁定，
    /// 这里只确认 `Direct` 与 `System(None)` 都复用同一个无代理客户端。
    #[test]
    fn direct_routes_reuse_the_shared_direct_client() {
        // `default_client` 与 `direct_client` 共享同一份实例，因此两次取回的
        // 句柄必须指向同一个连接池；代理路由绝不会落到这条路径上。
        let first = super::direct_client();
        let second = super::client_for_route(&ProxyRoute::Direct).unwrap();
        let third = super::client_for_route(&ProxyRoute::System(None)).unwrap();
        // `reqwest::Client` 没有相等比较，但它们的调试输出里带着同一个池指纹。
        let fingerprint = |client: &reqwest::Client| format!("{:?}", client);
        assert_eq!(fingerprint(&first), fingerprint(&second));
        assert_eq!(fingerprint(&first), fingerprint(&third));
    }

    /// 「自动」按绕过列表放行主机，同时把其他主机送到系统代理。
    #[tokio::test]
    async fn system_route_honors_the_bypass_list() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let origin = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let length = stream.read(&mut request).unwrap();
            assert!(
                String::from_utf8_lossy(&request[..length]).starts_with("GET /bypassed HTTP/1.1"),
                "a bypassed host must be reached directly"
            );
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nbypassed",
                )
                .unwrap();
        });

        let route = ProxyRoute::System(Some(crate::proxy::SystemProxy {
            http: Some("http://127.0.0.1:1".into()),
            https: None,
            bypass: vec!["127.*".into()],
        }));
        let response = client_for_route(&route)
            .unwrap()
            .get(format!("http://{address}/bypassed"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.text().await.unwrap(), "bypassed");
        origin.join().unwrap();
    }

    #[tokio::test]
    async fn recording_client_preserves_raw_content_encoded_bytes() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 9\r\nConnection: close\r\n\r\nraw-media",
                )
                .unwrap();
        });

        let bytes = recording_stream_client_for_route(&ProxyRoute::Direct)
            .unwrap()
            .get(format!("http://{address}/live.flv"))
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();

        assert_eq!(bytes.as_ref(), b"raw-media");
        server.join().unwrap();
    }
}
