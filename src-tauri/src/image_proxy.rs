//! Localhost HTTP proxy that attaches CDN Referer / UA headers to WebView
//! image loads.
//!
//! Bilibili / Douyu / Huya / Douyin image CDNs reject requests that lack a
//! platform Referer, and the WebView cannot attach one to an `<img>` tag. The
//! frontend routes remote image URLs through this loopback server, which
//! forwards with the appropriate headers and returns the full body with an
//! explicit `Content-Length` (the Windows WebView mis-handles chunked
//! responses for small image bodies). Started lazily on first use and kept
//! for the app lifetime.

use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Mutex;

use reqwest::Url;
use tauri::async_runtime::JoinHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::watch;

use crate::error::{AppError, AppResult};

/// Hosts the proxy is willing to fetch. The frontend rewrites only these CDNs
/// (`shouldProxyHost` in `src/shared/api/imageProxy.ts`), so this allowlist
/// keeps the loopback server from becoming a general-purpose open proxy.
const ALLOWED_IMAGE_HOSTS: &[&str] = &[
    "douyucdn.cn",
    "douyu.com",
    "hdslb.com",
    "bilibili.com",
    "huya.com",
    "msstatic.com",
    "douyin.com",
    "douyinpic.com",
    "douyinliving.com",
    "byteimg.com",
    "jtvnw.net",
    "twitch.tv",
];

/// Images are small; the bound also prevents a malicious local page from
/// turning this listener into a memory-buffering downloader.
const MAX_IMAGE_BYTES: usize = 16 * 1024 * 1024;
const IMAGE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

pub struct ImageProxy {
    state: Mutex<Option<ImageProxyInner>>,
    port: AtomicU16,
}

struct ImageProxyInner {
    shutdown: watch::Sender<bool>,
    task: JoinHandle<()>,
}

impl Default for ImageProxy {
    fn default() -> Self {
        Self::new()
    }
}

impl ImageProxy {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(None),
            port: AtomicU16::new(0),
        }
    }

    pub fn stop(&self) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(inner) = state.take() {
            let _ = inner.shutdown.send(true);
            inner.task.abort();
        }
        self.port.store(0, Ordering::Release);
    }

    /// Idempotent: returns the existing loopback origin when already running.
    pub async fn start(&self) -> AppResult<String> {
        self.start_with_allowlist(ALLOWED_IMAGE_HOSTS).await
    }

    /// `start` with an explicit upstream allowlist (tests use loopback hosts).
    async fn start_with_allowlist(&self, hosts: &'static [&'static str]) -> AppResult<String> {
        let port = self.port.load(Ordering::Acquire);
        if port != 0 {
            return Ok(Self::base_url(port));
        }

        // Bind outside the lock so a concurrent second call merely drops its
        // uninstalled listener instead of waiting on a held mutex.
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| {
                AppError::new("image_proxy_bind", format!("bind localhost failed: {e}")).retryable()
            })?;
        let port = listener
            .local_addr()
            .map_err(|e| AppError::new("image_proxy_bind", e.to_string()))?
            .port();

        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.is_some() {
            // Another call won the race; drop this listener and reuse it.
            let port = self.port.load(Ordering::Acquire);
            return Ok(Self::base_url(port));
        }

        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let task = tauri::async_runtime::spawn(run_image_proxy(listener, hosts, shutdown_rx));
        *state = Some(ImageProxyInner {
            shutdown: shutdown_tx,
            task,
        });
        self.port.store(port, Ordering::Release);
        Ok(Self::base_url(port))
    }

    fn base_url(port: u16) -> String {
        format!("http://127.0.0.1:{port}")
    }
}

fn referer_for(host: &str) -> Option<&'static str> {
    if host.ends_with("douyucdn.cn") || host.ends_with("douyu.com") {
        Some("https://www.douyu.com/")
    } else if host.ends_with("hdslb.com") || host.ends_with("bilibili.com") {
        Some("https://live.bilibili.com/")
    } else if host.ends_with("huya.com") || host.ends_with("msstatic.com") {
        Some("https://www.huya.com/")
    } else if host.ends_with("douyin.com")
        || host.ends_with("douyinpic.com")
        || host.ends_with("douyinliving.com")
        || host.ends_with("byteimg.com")
    {
        Some("https://www.douyin.com/")
    } else {
        None
    }
}

fn host_is_allowed(host: &str, allowed_hosts: &'static [&'static str]) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    allowed_hosts
        .iter()
        .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
}

async fn run_image_proxy(
    listener: TcpListener,
    allowed_hosts: &'static [&'static str],
    mut shutdown: watch::Receiver<bool>,
) {
    let client = match reqwest::Client::builder()
        .use_native_tls()
        .timeout(IMAGE_TIMEOUT)
        .connect_timeout(std::time::Duration::from_secs(8))
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        )
        .build()
    {
        Ok(client) => client,
        Err(e) => {
            tracing::warn!(error = %e, "image proxy client build failed");
            return;
        }
    };

    loop {
        tokio::select! {
            _ = shutdown.changed() => {
                if *shutdown.borrow() {
                    break;
                }
            }
            accept = listener.accept() => {
                match accept {
                    Ok((mut socket, _)) => {
                        let client = client.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) =
                                handle_image_request(&mut socket, &client, allowed_hosts).await
                            {
                                tracing::debug!(%e, "image proxy request ended");
                            }
                        });
                    }
                    Err(e) => {
                        tracing::warn!(%e, "image proxy accept failed");
                        break;
                    }
                }
            }
        }
    }
}

async fn handle_image_request(
    socket: &mut tokio::net::TcpStream,
    client: &reqwest::Client,
    allowed_hosts: &'static [&'static str],
) -> Result<(), String> {
    let mut buf = [0u8; 4096];
    let n = socket
        .read(&mut buf)
        .await
        .map_err(|e| format!("read request: {e}"))?;
    if n == 0 {
        return Ok(());
    }
    let head = String::from_utf8_lossy(&buf[..n]);
    let first = head.lines().next().unwrap_or("");
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");

    if method == "OPTIONS" {
        return write_response_bytes(
            socket,
            204,
            "No Content",
            "text/plain; charset=utf-8",
            &[],
        )
        .await;
    }
    if method != "GET" && method != "HEAD" {
        return write_response_bytes(
            socket,
            405,
            "Method Not Allowed",
            "text/plain; charset=utf-8",
            &[],
        )
        .await;
    }

    let raw_url = target
        .strip_prefix("/img?")
        .or_else(|| target.strip_prefix("/img"))
        .and_then(|query| query.split('&').find_map(|pair| pair.strip_prefix("url=")))
        .unwrap_or_default();

    let upstream_url = match parse_image_url(raw_url) {
        Some(url) => url,
        None => {
            return write_response_bytes(
                socket,
                400,
                "Bad Request",
                "text/plain; charset=utf-8",
                &[],
            )
            .await;
        }
    };

    if !host_is_allowed(upstream_url.host_str().unwrap_or_default(), allowed_hosts) {
        return write_response_bytes(socket, 403, "Forbidden", "text/plain; charset=utf-8", &[])
            .await;
    }

    let mut request = client.get(upstream_url.clone());
    if let Some(referer) = referer_for(upstream_url.host_str().unwrap_or_default()) {
        request = request.header("referer", referer);
    }

    let upstream = request
        .send()
        .await
        .map_err(|e| format!("upstream: {e}"))?;
    let status = upstream.status().as_u16();
    let status_reason = upstream.status().canonical_reason().unwrap_or("Error");
    let content_type = upstream
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    if method == "HEAD" {
        return write_response_bytes(socket, status, status_reason, &content_type, &[]).await;
    }

    if !upstream.status().is_success() {
        let body = upstream.text().await.unwrap_or_default();
        let body = body.chars().take(512).collect::<String>();
        return write_response_bytes(
            socket,
            status,
            status_reason,
            "text/plain; charset=utf-8",
            body.as_bytes(),
        )
        .await;
    }

    let bytes = upstream.bytes().await.map_err(|e| format!("body: {e}"))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return write_response_bytes(
            socket,
            502,
            "Bad Gateway",
            "text/plain; charset=utf-8",
            b"image too large",
        )
        .await;
    }

    // Full-body write with explicit Content-Length: the Windows WebView can
    // cut off chunked responses when a small image arrives fast.
    write_response_bytes(socket, status, status_reason, &content_type, &bytes).await
}

fn parse_image_url(raw: &str) -> Option<Url> {
    if raw.is_empty() {
        return None;
    }
    let decoded = percent_decode(raw);
    let url = Url::parse(&decoded).ok()?;
    matches!(url.scheme(), "http" | "https").then_some(url)
}

/// Decode `%XX` escapes (the same set the frontend `encodeURIComponent`
/// produces). The URL parser below rejects any control byte it must not see.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let (Some(high), Some(low)) = (
                hex_value(bytes[index + 1]),
                hex_value(bytes[index + 2]),
            )
        {
            out.push((high << 4) | low);
            index += 3;
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

async fn write_response_bytes(
    socket: &mut tokio::net::TcpStream,
    status: u16,
    reason: &str,
    content_type: &str,
    body: &[u8],
) -> Result<(), String> {
    let header = if status == 204 {
        "HTTP/1.1 204 No Content\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Connection: close\r\n\r\n"
            .to_string()
    } else {
        format!(
            "HTTP/1.1 {status} {reason}\r\n\
             Content-Type: {content_type}\r\n\
             Access-Control-Allow-Origin: *\r\n\
             Cache-Control: private, max-age=86400\r\n\
             Connection: close\r\n\
             Content-Length: {}\r\n\r\n",
            body.len()
        )
    };
    socket
        .write_all(header.as_bytes())
        .await
        .map_err(|e| format!("write header: {e}"))?;
    if !body.is_empty() {
        socket
            .write_all(body)
            .await
            .map_err(|e| format!("write body: {e}"))?;
    }
    let _ = socket.flush().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{host_is_allowed, parse_image_url, referer_for, ALLOWED_IMAGE_HOSTS, ImageProxy};

    #[test]
    fn allowed_host_matching_uses_suffixes() {
        assert!(host_is_allowed("rpic.douyucdn.cn", ALLOWED_IMAGE_HOSTS));
        assert!(host_is_allowed("i0.hdslb.com", ALLOWED_IMAGE_HOSTS));
        assert!(host_is_allowed("huyaimg.msstatic.com", ALLOWED_IMAGE_HOSTS));
        assert!(host_is_allowed("p3-sign.douyinpic.com", ALLOWED_IMAGE_HOSTS));
        assert!(host_is_allowed("static-cdn.jtvnw.net", ALLOWED_IMAGE_HOSTS));
        assert!(!host_is_allowed("example.com", ALLOWED_IMAGE_HOSTS));
        assert!(!host_is_allowed("evil-hdslb.com", ALLOWED_IMAGE_HOSTS));
        assert!(!host_is_allowed("douyucdn.cn.evil.com", ALLOWED_IMAGE_HOSTS));
    }

    #[test]
    fn referer_is_picked_per_cdn() {
        assert_eq!(
            referer_for("rpic.douyucdn.cn"),
            Some("https://www.douyu.com/")
        );
        assert_eq!(
            referer_for("i0.hdslb.com"),
            Some("https://live.bilibili.com/")
        );
        assert_eq!(referer_for("static-cdn.jtvnw.net"), None);
    }

    #[test]
    fn image_url_parsing_requires_an_http_url() {
        assert!(parse_image_url("https%3A%2F%2Fi0.hdslb.com%2Fpic.png").is_some());
        assert!(parse_image_url("file%3A%2F%2F%2Fetc%2Fpasswd").is_none());
        assert!(parse_image_url("").is_none());
    }
    #[tokio::test]
    async fn proxy_returns_buffered_body_and_closes() {
        use std::io::{Read, Write};
        use std::net::TcpListener as StdTcpListener;
        use std::sync::{Arc, Mutex};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // Upstream image server: records the request, serves a binary body.
        let upstream = StdTcpListener::bind("127.0.0.1:0").unwrap();
        let upstream_addr = upstream.local_addr().unwrap();
        let headers_seen = Arc::new(Mutex::new(String::new()));
        let headers_seen_clone = headers_seen.clone();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = upstream.accept().unwrap();
            let mut request = [0_u8; 2048];
            let length = stream.read(&mut request).unwrap();
            *headers_seen_clone.lock().unwrap() =
                String::from_utf8_lossy(&request[..length]).to_ascii_lowercase();
            let body = b"\x89PNG-fake-image";
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    )
                    .as_bytes(),
                )
                .unwrap();
            stream.write_all(body).unwrap();
        });

        let proxy = ImageProxy::new();
        let base = proxy
            .start_with_allowlist(&["127.0.0.1"])
            .await
            .unwrap();
        // Explicitly build the URL-encoded form to exercise percent decoding.
        let encoded_upstream = format!("http://{upstream_addr}/pic.png")
            .as_bytes()
            .iter()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    (*b as char).to_string()
                }
                _ => format!("%{b:02X}"),
            })
            .collect::<String>();
        let target = format!("{base}/img?url={encoded_upstream}");

        let mut local = tokio::net::TcpStream::connect(base.trim_start_matches("http://"))
            .await
            .unwrap();
        // Origin-form request target (`/img?url=…`) like the WebView sends.
        let path = target.trim_start_matches(&base);
        local
            .write_all(
                format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                    .as_bytes(),
            )
            .await
            .unwrap();

        let mut response = Vec::new();
        let read_result = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            local.read_to_end(&mut response),
        )
        .await;

        proxy.stop();
        server.join().unwrap();
        assert!(read_result.is_ok(), "proxy did not answer in time");
        let response_text = String::from_utf8_lossy(&response);
        assert!(response_text.contains("200 OK"));
        assert!(response_text.contains("Content-Type: image/png"));
        assert!(response_text.contains("Content-Length: 15"));
        assert!(response.ends_with(b"\r\n\r\n\x89PNG-fake-image"));
        // Unknown hosts are allowed only under the test allowlist and receive
        // no platform Referer (see `referer_for`).
        let upstream_request = headers_seen.lock().unwrap();
        assert!(!upstream_request.contains("referer:"));
        assert!(upstream_request.contains("get /pic.png"));
    }
}
