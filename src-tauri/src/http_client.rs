//! Shared HTTP client builder for live-site backends.

use std::sync::OnceLock;
use std::time::Duration;

use reqwest::Client;

use crate::error::{AppError, AppResult};

static DEFAULT_CLIENT: OnceLock<Client> = OnceLock::new();

/// Build a reqwest client with rustls, gzip/brotli, and optional HTTP proxy.
pub fn build_client(proxy: Option<&str>) -> AppResult<Client> {
    let mut builder = Client::builder()
        .use_rustls_tls()
        .gzip(true)
        .brotli(true)
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .pool_max_idle_per_host(4)
        .user_agent(crate::sites::bilibili::DEFAULT_USER_AGENT);

    if let Some(proxy_url) = proxy.filter(|p| !p.trim().is_empty()) {
        let proxy = reqwest::Proxy::all(proxy_url).map_err(|e| {
            AppError::new("proxy_invalid", format!("invalid proxy `{proxy_url}`: {e}"))
        })?;
        builder = builder.proxy(proxy);
    }

    builder
        .build()
        .map_err(|e| AppError::new("http_client_build", e.to_string()))
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
