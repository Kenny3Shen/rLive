//! Shared HTTP client builder for live-site backends.

use std::sync::OnceLock;
use std::time::Duration;

use reqwest::{Client, ClientBuilder};

use crate::error::{AppError, AppResult};

static DEFAULT_CLIENT: OnceLock<Client> = OnceLock::new();

/// Apply the user-selected HTTP(S) proxy to a client builder.
///
/// Keeping this in one place is important because live-site metadata and the
/// localhost media relay use different timeout policies, but both must take
/// the same route to a region-restricted service such as Twitch.
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

/// Shared client policy with rustls, compression, and an optional HTTP proxy.
fn client_builder(proxy: Option<&str>) -> AppResult<ClientBuilder> {
    let builder = Client::builder()
        .use_rustls_tls()
        .gzip(true)
        .brotli(true)
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .pool_max_idle_per_host(4)
        .user_agent(crate::sites::bilibili::DEFAULT_USER_AGENT);

    with_proxy(builder, proxy)
}

/// Build a reqwest client with rustls, gzip/brotli, and optional HTTP proxy.
pub fn build_client(proxy: Option<&str>) -> AppResult<Client> {
    client_builder(proxy)?
        .build()
        .map_err(|_| AppError::new("http_client_build", "网络客户端初始化失败"))
}

/// Select the shared direct client or a fresh client bound to a saved proxy.
///
/// A reqwest client contains its own proxy policy, so a proxy-enabled request
/// must never reuse the process-wide direct client. Empty values deliberately
/// retain the direct client's connection pool.
pub fn client_for_proxy(proxy: Option<&str>) -> AppResult<Client> {
    let proxy = proxy.map(str::trim).filter(|value| !value.is_empty());
    match proxy {
        Some(proxy) => build_client(Some(proxy)),
        None => Ok(default_client()),
    }
}

/// Build a client for requests that carry a secret and must not follow a
/// server-selected destination (for example a Cookie-bearing signer request).
pub fn build_no_redirect_client(proxy: Option<&str>) -> AppResult<Client> {
    client_builder(proxy)?
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| AppError::new("http_client_build", "网络客户端初始化失败"))
}

/// Shared default client (no proxy). Cheap to clone (internally Arc).
pub fn default_client() -> Client {
    DEFAULT_CLIENT
        .get_or_init(|| {
            build_client(None).unwrap_or_else(|_| {
                Client::builder()
                    .use_rustls_tls()
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

    use super::{build_no_redirect_client, client_for_proxy};

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
            // HTTP proxies receive an absolute URL. If the client had made a
            // direct request, this loopback listener would never see it.
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
}
