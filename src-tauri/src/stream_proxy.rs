//! Localhost HTTP proxy that injects CDN headers for WebView media playback.
//!
//! Browser `<video>` / MSE cannot attach Bilibili `Referer` / `User-Agent` to
//! media requests. This proxy binds `127.0.0.1:0`, forwards the live URL with
//! the required headers, and returns a same-origin-friendly stream URL for
//! mpegts.js / hls.js — no mpv HWND.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Mutex;

use futures_util::StreamExt;
use tauri::async_runtime::JoinHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::watch;

use crate::error::{AppError, AppResult};

/// Active proxy endpoint (one per app — single-room desktop client).
pub struct StreamProxy {
    inner: Mutex<Option<ProxyInner>>,
    /// Last bound port (0 = none). Exposed for diagnostics.
    port: AtomicU16,
}

struct ProxyInner {
    port: u16,
    shutdown: watch::Sender<bool>,
    task: JoinHandle<()>,
}

impl Default for StreamProxy {
    fn default() -> Self {
        Self {
            inner: Mutex::new(None),
            port: AtomicU16::new(0),
        }
    }
}

impl StreamProxy {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn stop(&self) {
        let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(inner) = guard.take() {
            let _ = inner.shutdown.send(true);
            inner.task.abort();
        }
        self.port.store(0, Ordering::Release);
    }

    /// Start (or replace) a proxy for `url` with `headers`. Returns local play URL.
    pub async fn start(
        &self,
        url: String,
        headers: HashMap<String, String>,
    ) -> AppResult<String> {
        self.stop();
        // Give the aborted accept-loop a moment to drop the previous socket so
        // re-enter does not race a half-closed listener.
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;

        let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| {
            AppError::new("stream_proxy_bind", format!("bind localhost failed: {e}")).retryable()
        })?;
        let port = listener
            .local_addr()
            .map_err(|e| AppError::new("stream_proxy_bind", e.to_string()))?
            .port();

        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let task = tauri::async_runtime::spawn(async move {
            run_proxy_loop(listener, url, headers, shutdown_rx).await;
        });

        {
            let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            *guard = Some(ProxyInner {
                port,
                shutdown: shutdown_tx,
                task,
            });
        }
        self.port.store(port, Ordering::Release);
        Ok(format!("http://127.0.0.1:{port}/live"))
    }

    pub fn local_url(&self) -> Option<String> {
        let port = self.port.load(Ordering::Acquire);
        if port == 0 {
            None
        } else {
            Some(format!("http://127.0.0.1:{port}/live"))
        }
    }
}

async fn run_proxy_loop(
    listener: TcpListener,
    url: String,
    headers: HashMap<String, String>,
    mut shutdown: watch::Receiver<bool>,
) {
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
                        let url = url.clone();
                        let headers = headers.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) = handle_client(&mut socket, &url, &headers).await {
                                tracing::debug!(%e, "stream proxy client ended");
                            }
                        });
                    }
                    Err(e) => {
                        tracing::warn!(%e, "stream proxy accept failed");
                        break;
                    }
                }
            }
        }
    }
}

async fn handle_client(
    socket: &mut tokio::net::TcpStream,
    url: &str,
    headers: &HashMap<String, String>,
) -> Result<(), String> {
    // Read request head (we only need method/path; body unused for GET).
    let mut buf = vec![0u8; 4096];
    let n = socket
        .read(&mut buf)
        .await
        .map_err(|e| format!("read request: {e}"))?;
    if n == 0 {
        return Ok(());
    }
    let head = String::from_utf8_lossy(&buf[..n]);
    let first = head.lines().next().unwrap_or("");
    if first.starts_with("OPTIONS ") {
        let resp = concat!(
            "HTTP/1.1 204 No Content\r\n",
            "Access-Control-Allow-Origin: *\r\n",
            "Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n",
            "Access-Control-Allow-Headers: *\r\n",
            "Connection: close\r\n\r\n"
        );
        socket
            .write_all(resp.as_bytes())
            .await
            .map_err(|e| format!("write options: {e}"))?;
        return Ok(());
    }
    if !(first.starts_with("GET ") || first.starts_with("HEAD ")) {
        let resp = "HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n";
        let _ = socket.write_all(resp.as_bytes()).await;
        return Ok(());
    }

    // Live streams must not use the short site-API timeout.
    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .connect_timeout(std::time::Duration::from_secs(10))
        .pool_max_idle_per_host(2)
        .user_agent(crate::sites::bilibili::DEFAULT_USER_AGENT)
        .build()
        .map_err(|e| format!("client: {e}"))?;
    let mut req = client.get(url);
    for (k, v) in headers {
        req = req.header(k.as_str(), v.as_str());
    }
    // Avoid compressed bodies that confuse MSE demuxers.
    req = req.header("accept-encoding", "identity");

    let upstream = req.send().await.map_err(|e| format!("upstream: {e}"))?;
    let status = upstream.status().as_u16();
    let content_type = upstream
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    if first.starts_with("HEAD ") {
        let resp = format!(
            "HTTP/1.1 {status} OK\r\n\
             Content-Type: {content_type}\r\n\
             Access-Control-Allow-Origin: *\r\n\
             Cache-Control: no-cache\r\n\
             Connection: close\r\n\r\n"
        );
        socket
            .write_all(resp.as_bytes())
            .await
            .map_err(|e| format!("write head: {e}"))?;
        return Ok(());
    }

    if !upstream.status().is_success() {
        let body = upstream.text().await.unwrap_or_default();
        let resp = format!(
            "HTTP/1.1 {status} Error\r\n\
             Content-Type: text/plain; charset=utf-8\r\n\
             Access-Control-Allow-Origin: *\r\n\
             Connection: close\r\n\
             Content-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let _ = socket.write_all(resp.as_bytes()).await;
        return Err(format!("upstream status {status}"));
    }

    let header = format!(
        "HTTP/1.1 200 OK\r\n\
         Content-Type: {content_type}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n\r\n"
    );
    socket
        .write_all(header.as_bytes())
        .await
        .map_err(|e| format!("write header: {e}"))?;

    let mut stream = upstream.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("upstream chunk: {e}"))?;
        if chunk.is_empty() {
            continue;
        }
        if socket.write_all(&chunk).await.is_err() {
            break; // client gone
        }
    }
    let _ = socket.flush().await;
    Ok(())
}
