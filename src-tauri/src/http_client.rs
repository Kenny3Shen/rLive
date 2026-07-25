//! Shared HTTP client builder for live-site backends.

use std::sync::OnceLock;
use std::time::Duration;

use reqwest::{Client, ClientBuilder};

use crate::error::{AppError, AppResult};

static DEFAULT_CLIENT: OnceLock<Client> = OnceLock::new();

/// Shared client policy with rustls, compression, and an optional HTTP proxy.
fn client_builder(proxy: Option<&str>) -> AppResult<ClientBuilder> {
    let mut builder = Client::builder()
        .use_rustls_tls()
        .gzip(true)
        .brotli(true)
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .pool_max_idle_per_host(4)
        .user_agent(crate::sites::bilibili::DEFAULT_USER_AGENT);

    if let Some(proxy_url) = proxy.filter(|p| !p.trim().is_empty()) {
        let proxy = reqwest::Proxy::all(proxy_url)
            .map_err(|_| AppError::new("proxy_invalid", "代理地址无效"))?;
        builder = builder.proxy(proxy);
    }

    Ok(builder)
}

/// Build a reqwest client with rustls, gzip/brotli, and optional HTTP proxy.
pub fn build_client(proxy: Option<&str>) -> AppResult<Client> {
    client_builder(proxy)?
        .build()
        .map_err(|_| AppError::new("http_client_build", "网络客户端初始化失败"))
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

    use super::build_no_redirect_client;

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
}
