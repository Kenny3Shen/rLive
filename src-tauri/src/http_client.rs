//! 直播站点后端共享的 HTTP 客户端构建器。

use std::sync::OnceLock;
use std::time::Duration;

use reqwest::{Client, ClientBuilder};

use crate::error::{AppError, AppResult};

static DEFAULT_CLIENT: OnceLock<Client> = OnceLock::new();

/// 把用户选择的 HTTP(S) 代理应用到客户端构建器上。
///
/// 集中在一处很重要：直播站点元数据请求与本机媒体中继采用不同的超时策略，
/// 但访问 Twitch 这类有地区限制的服务时，
/// 两者必须走同一条路由。
pub(crate) fn with_proxy(
    mut builder: ClientBuilder,
    proxy: Option<&str>,
) -> AppResult<ClientBuilder> {
    if let Some(proxy_url) = proxy.map(str::trim).filter(|value| !value.is_empty()) {
        let proxy = reqwest::Proxy::all(proxy_url)
            .map_err(|_| AppError::new("proxy_invalid", "代理地址无效"))?;
        builder = builder.proxy(proxy);
    }

    Ok(builder)
}

/// 共享客户端策略：native-tls、压缩，以及可选的 HTTP 代理。
fn client_builder(proxy: Option<&str>) -> AppResult<ClientBuilder> {
    let builder = Client::builder()
        .use_native_tls()
        .gzip(true)
        .brotli(true)
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .pool_max_idle_per_host(4)
        .user_agent(crate::sites::bilibili::DEFAULT_USER_AGENT);

    with_proxy(builder, proxy)
}

/// 构建带 native-tls、gzip/brotli 与可选 HTTP 代理的 reqwest 客户端。
pub fn build_client(proxy: Option<&str>) -> AppResult<Client> {
    client_builder(proxy)?
        .build()
        .map_err(|_| AppError::new("http_client_build", "网络客户端初始化失败"))
}

/// 在共享直连客户端与绑定已保存代理的新客户端之间做选择。
///
/// reqwest 客户端自带代理策略，因此启用代理的请求绝不能复用进程级
/// 直连客户端。空取值刻意保留直连客户端的连接池。
pub fn client_for_proxy(proxy: Option<&str>) -> AppResult<Client> {
    let proxy = proxy.map(str::trim).filter(|value| !value.is_empty());
    match proxy {
        Some(proxy) => build_client(Some(proxy)),
        None => Ok(default_client()),
    }
}

/// 构建长时间运行的直播录制所用的原始 HTTP/1.1 客户端。
///
/// 与 API 请求不同，健康的直播响应可以无限期保持打开，
/// 因此该客户端刻意不设总超时。自动内容解码同样关闭：
/// 媒体字节必须按 CDN 发送的原样写入，
/// 即使 CDN 错误地附加了 Content-Encoding 头。
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
pub fn recording_stream_client_for_proxy(proxy: Option<&str>) -> AppResult<Client> {
    with_proxy(
        Client::builder()
            .use_native_tls()
            .gzip(false)
            .brotli(false)
            .http1_only()
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(45))
            .pool_max_idle_per_host(2)
            .user_agent(crate::sites::bilibili::DEFAULT_USER_AGENT),
        proxy,
    )?
    .build()
    .map_err(|_| AppError::new("http_client_build", "录制网络客户端初始化失败"))
}

/// 用于携带机密且绝不跟随服务端选定目标的请求
/// （例如带 Cookie 的签名请求）的客户端。
pub fn build_no_redirect_client(proxy: Option<&str>) -> AppResult<Client> {
    client_builder(proxy)?
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| AppError::new("http_client_build", "网络客户端初始化失败"))
}

/// 共享默认客户端（无代理）。克隆开销低（内部为 Arc）。
pub fn default_client() -> Client {
    DEFAULT_CLIENT
        .get_or_init(|| {
            build_client(None).unwrap_or_else(|_| {
                Client::builder()
                    .use_native_tls()
                    .timeout(Duration::from_secs(20))
                    .build()
                    .expect("fallback reqwest client")
            })
        })
        .clone()
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    use super::{build_no_redirect_client, client_for_proxy, recording_stream_client_for_proxy};

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

        let response = build_no_redirect_client(None)
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

        let client = client_for_proxy(Some(&format!("http://{address}"))).unwrap();
        let response = client
            .get("http://twitch.invalid/gql")
            .send()
            .await
            .unwrap();

        assert_eq!(response.text().await.unwrap(), "via-proxy");
        server.join().unwrap();
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

        let bytes = recording_stream_client_for_proxy(None)
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
