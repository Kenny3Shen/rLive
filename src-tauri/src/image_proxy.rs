//! 本机 HTTP 代理，为 WebView 的图片加载附加 CDN 所需的 Referer / UA 请求头。
//!
//! Bilibili / 斗鱼 / 虎牙 / 抖音的图片 CDN 会拒绝缺少平台 Referer 的请求，
//! 而 WebView 无法为 `<img>` 标签附加它。前端把远程图片 URL 经这个回环服务器
//! 转发，由其带上相应请求头，并以显式 `Content-Length` 返回完整 body
//! （Windows WebView 对小图片的分块响应处理有误）。
//! 首次使用时惰性启动并存活整个应用生命周期。

use std::path::PathBuf;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex};

use percent_encoding::percent_decode_str;
use reqwest::Url;
use tauri::async_runtime::JoinHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::watch;

use crate::error::{AppError, AppResult};
use crate::image_cache::{ImageCache, MAX_IMAGE_BYTES, sniff_image_type};

/// 代理愿意抓取的主机。前端只改写这些 CDN
/// （见 `src/shared/api/imageProxy.ts` 的 `shouldProxyHost`），
/// 这份白名单可防止回环服务器沦为通用开放代理。
const ALLOWED_IMAGE_HOSTS: &[&str] = &[
    "douyucdn.cn",
    "douyu.com",
    "hdslb.com",
    "bilibili.com",
    "biliimg.com",
    "huya.com",
    "msstatic.com",
    "douyin.com",
    "douyinpic.com",
    "douyinliving.com",
    "byteimg.com",
    "jtvnw.net",
    "twitch.tv",
    "7tv.app",
];

const IMAGE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// 磁盘缓存图片（头像、分类图标）的 WebView 缓存生存期：
/// URL 随图片变化而变化，因此较长的生存期是安全的。
const CACHED_IMAGE_MAX_AGE: u32 = 24 * 60 * 60;
/// 直播房间封面只保留较短的 WebView 生存期 —— 足够让网格来回滚动时不重复
/// 抓取，又足够短，使 URL 稳定的预览图（Twitch `previews-ttv`）
/// 在浏览时仍能刷新。
const COVER_MAX_AGE: u32 = 120;

pub struct ImageProxy {
    state: Mutex<Option<ImageProxyInner>>,
    port: AtomicU16,
    cache: Arc<ImageCache>,
}

struct ImageProxyInner {
    shutdown: watch::Sender<bool>,
    task: JoinHandle<()>,
}

impl ImageProxy {
    pub fn new(cache_root: PathBuf) -> Self {
        Self {
            state: Mutex::new(None),
            port: AtomicU16::new(0),
            cache: Arc::new(ImageCache::new(cache_root)),
        }
    }

    pub async fn cache_usage(&self) -> crate::image_cache::CacheUsage {
        // 设置页提供打开所报告目录的功能，
        // 因此即使第一张图片尚未缓存，也要确保目录存在。
        self.cache.ensure_root().await;
        self.cache.usage().await
    }

    pub async fn cache_clear(&self) -> AppResult<crate::image_cache::CacheUsage> {
        self.cache.clear().await?;
        Ok(self.cache.usage().await)
    }

    pub fn stop(&self) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(inner) = state.take() {
            let _ = inner.shutdown.send(true);
            inner.task.abort();
        }
        self.port.store(0, Ordering::Release);
    }

    /// 幂等：已在运行时返回现有的回环 origin。
    pub async fn start(&self) -> AppResult<String> {
        self.start_with_allowlist(ALLOWED_IMAGE_HOSTS).await
    }

    /// 以显式的上游白名单启动 `start`（测试使用回环主机）。
    async fn start_with_allowlist(&self, hosts: &'static [&'static str]) -> AppResult<String> {
        let port = self.port.load(Ordering::Acquire);
        if port != 0 {
            return Ok(Self::base_url(port));
        }

        // 在锁外完成绑定，使并发的第二次调用只是丢弃自己未安装的监听器，
        // 而不必等待被持有的互斥锁。
        let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| {
            AppError::new("image_proxy_bind", format!("bind localhost failed: {e}")).retryable()
        })?;
        let port = listener
            .local_addr()
            .map_err(|e| AppError::new("image_proxy_bind", e.to_string()))?
            .port();

        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.is_some() {
            // 另一次调用赢得了竞争；丢弃该监听器并复用现有实例。
            let port = self.port.load(Ordering::Acquire);
            return Ok(Self::base_url(port));
        }

        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let task = tauri::async_runtime::spawn(run_image_proxy(
            listener,
            hosts,
            shutdown_rx,
            self.cache.clone(),
        ));
        *state = Some(ImageProxyInner {
            shutdown: shutdown_tx,
            task,
        });
        self.port.store(port, Ordering::Release);
        let cache = self.cache.clone();
        tauri::async_runtime::spawn(async move {
            cache.sweep().await;
        });
        Ok(Self::base_url(port))
    }

    fn base_url(port: u16) -> String {
        format!("http://127.0.0.1:{port}")
    }
}

fn referer_for(host: &str) -> Option<&'static str> {
    if host.ends_with("douyucdn.cn") || host.ends_with("douyu.com") {
        Some("https://www.douyu.com/")
    } else if host.ends_with("hdslb.com")
        || host.ends_with("bilibili.com")
        || host.ends_with("biliimg.com")
    {
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
    cache: Arc<ImageCache>,
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
                        let cache = cache.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) =
                                handle_image_request(&mut socket, &client, allowed_hosts, cache)
                                    .await
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
    cache: Arc<ImageCache>,
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
            None,
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
            None,
        )
        .await;
    }

    let query = target
        .strip_prefix("/img?")
        .or_else(|| target.strip_prefix("/img"))
        .unwrap_or_default();
    let raw_url = query
        .split('&')
        .find_map(|pair| pair.strip_prefix("url="))
        .unwrap_or_default();
    // 直播房间封面选择不进入磁盘缓存：其 URL 要么携带采集时间戳
    // （每次刷新都是新键，且不会再被读取），要么在画面轮换时保持不变。
    let use_cache = !query.split('&').any(|pair| pair == "nocache=1");

    let upstream_url = match parse_image_url(raw_url) {
        Some(url) => url,
        None => {
            return write_response_bytes(
                socket,
                400,
                "Bad Request",
                "text/plain; charset=utf-8",
                &[],
                None,
            )
            .await;
        }
    };

    if !host_is_allowed(upstream_url.host_str().unwrap_or_default(), allowed_hosts) {
        return write_response_bytes(
            socket,
            403,
            "Forbidden",
            "text/plain; charset=utf-8",
            &[],
            None,
        )
        .await;
    }

    if method == "GET"
        && use_cache
        && let Some((bytes, content_type)) = cache.get(upstream_url.as_str()).await
    {
        return write_response_bytes(
            socket,
            200,
            "OK",
            content_type,
            &bytes,
            Some(CACHED_IMAGE_MAX_AGE),
        )
        .await;
    }

    let mut request = client.get(upstream_url.clone());
    if let Some(referer) = referer_for(upstream_url.host_str().unwrap_or_default()) {
        request = request.header("referer", referer);
    }

    let upstream = request.send().await.map_err(|e| format!("upstream: {e}"))?;
    let status = upstream.status().as_u16();
    let status_reason = upstream.status().canonical_reason().unwrap_or("Error");
    let content_type = upstream
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    if method == "HEAD" {
        return write_response_bytes(
            socket,
            status,
            status_reason,
            &content_type,
            &[],
            None,
        )
        .await;
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
            None,
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
            None,
        )
        .await;
    }

    // 以显式 Content-Length 写出完整 body：
    // 小图片快速到达时，Windows WebView 可能截断分块响应。
    let max_age = if use_cache {
        CACHED_IMAGE_MAX_AGE
    } else {
        COVER_MAX_AGE
    };
    write_response_bytes(
        socket,
        status,
        status_reason,
        &content_type,
        &bytes,
        Some(max_age),
    )
    .await?;

    if use_cache && sniff_image_type(&bytes).is_some() {
        let cache = cache.clone();
        let url = upstream_url.to_string();
        let bytes = bytes.clone();
        tauri::async_runtime::spawn(async move {
            cache.put(&url, &bytes).await;
        });
    }
    Ok(())
}

fn parse_image_url(raw: &str) -> Option<Url> {
    if raw.is_empty() {
        return None;
    }
    let decoded = percent_decode(raw);
    let url = Url::parse(&decoded).ok()?;
    matches!(url.scheme(), "http" | "https").then_some(url)
}

/// 解码 `%XX` 转义（与前端 `encodeURIComponent` 产生的集合一致）。
/// 下方的 URL 解析器会拒绝任何不该出现的控制字节。
/// `+` 不是空格，无效或截断的转义序列原样保留，无效 UTF-8 替换为 U+FFFD。
fn percent_decode(s: &str) -> String {
    percent_decode_str(s).decode_utf8_lossy().into_owned()
}

async fn write_response_bytes(
    socket: &mut tokio::net::TcpStream,
    status: u16,
    reason: &str,
    content_type: &str,
    body: &[u8],
    max_age: Option<u32>,
) -> Result<(), String> {
    // 只有成功的图片 body 才能获得缓存生存期；
    // 错误与空 body 绝不能被 WebView 记住。
    let cache_control = match max_age {
        Some(seconds) => format!("Cache-Control: private, max-age={seconds}\r\n"),
        None => "Cache-Control: no-store\r\n".to_string(),
    };
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
             {}\
             Connection: close\r\n\
             Content-Length: {}\r\n\r\n",
            cache_control,
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
    use super::{
        ALLOWED_IMAGE_HOSTS, ImageProxy, host_is_allowed, parse_image_url, percent_decode,
        referer_for,
    };

    #[test]
    fn allowed_host_matching_uses_suffixes() {
        assert!(host_is_allowed("rpic.douyucdn.cn", ALLOWED_IMAGE_HOSTS));
        assert!(host_is_allowed("i0.hdslb.com", ALLOWED_IMAGE_HOSTS));
        // 弹幕图片表情可能托管在这里；保持可缓存。
        assert!(host_is_allowed("i0.biliimg.com", ALLOWED_IMAGE_HOSTS));
        assert!(host_is_allowed("huyaimg.msstatic.com", ALLOWED_IMAGE_HOSTS));
        assert!(host_is_allowed(
            "p3-sign.douyinpic.com",
            ALLOWED_IMAGE_HOSTS
        ));
        assert!(host_is_allowed("static-cdn.jtvnw.net", ALLOWED_IMAGE_HOSTS));
        assert!(!host_is_allowed("example.com", ALLOWED_IMAGE_HOSTS));
        assert!(!host_is_allowed("evil-hdslb.com", ALLOWED_IMAGE_HOSTS));
        assert!(!host_is_allowed(
            "douyucdn.cn.evil.com",
            ALLOWED_IMAGE_HOSTS
        ));
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
        assert_eq!(
            referer_for("i0.biliimg.com"),
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

    #[test]
    fn percent_decoding_keeps_plus_and_invalid_escapes() {
        assert_eq!(
            percent_decode("https%3A%2F%2Fi0.hdslb.com%2Fpic.png"),
            "https://i0.hdslb.com/pic.png"
        );
        // `+` 不是空格，与 query-string 解码不同。
        assert_eq!(percent_decode("a+b%2Bc"), "a+b+c");
        // 无效与截断的转义序列原样保留。
        assert_eq!(percent_decode("100%ZZ"), "100%ZZ");
        assert_eq!(percent_decode("tail%2"), "tail%2");
        assert_eq!(percent_decode("solo%"), "solo%");
        // 非 ASCII 与无效 UTF-8。
        assert_eq!(percent_decode("%E4%B8%AD"), "中");
        assert_eq!(percent_decode("%FF"), "\u{FFFD}");
    }

    #[tokio::test]
    async fn proxy_returns_buffered_body_and_closes() {
        use std::io::{Read, Write};
        use std::net::TcpListener as StdTcpListener;
        use std::sync::{Arc, Mutex};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // 上游图片服务器：记录请求并返回二进制 body。
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
            let body = b"\x89PNG\r\n\x1a\nfake-image";
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

        let cache_root = std::env::temp_dir().join(format!(
            "rlive-image-proxy-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let proxy = ImageProxy::new(cache_root.clone());
        let base = proxy.start_with_allowlist(&["127.0.0.1"]).await.unwrap();
        // 显式构造 URL 编码形式以检验百分号解码。
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
        // origin 形式的请求目标（`/img?url=…`），与 WebView 发送的一致。
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

        server.join().unwrap();
        assert!(read_result.is_ok(), "proxy did not answer in time");
        let response_text = String::from_utf8_lossy(&response);
        assert!(response_text.contains("200 OK"));
        assert!(response_text.contains("Content-Type: image/png"));
        assert!(response_text.contains("Content-Length: 18"));
        assert!(response.ends_with(b"\r\n\r\n\x89PNG\r\n\x1a\nfake-image"));
        // 未知主机仅在测试白名单下被允许，
        // 且不会获得平台 Referer（参见 `referer_for`）。
        {
            let upstream_request = headers_seen.lock().unwrap();
            assert!(!upstream_request.contains("referer:"));
            assert!(upstream_request.contains("get /pic.png"));
        }

        let cache_ready = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if proxy.cache_usage().await.files == 1 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await;
        assert!(cache_ready.is_ok(), "proxy did not persist the image");

        // 一次性上游监听器现已关闭。第二个请求仍须成功，
        // 以此证明响应来自磁盘缓存。
        let mut cached_local = tokio::net::TcpStream::connect(base.trim_start_matches("http://"))
            .await
            .unwrap();
        cached_local
            .write_all(
                format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                    .as_bytes(),
            )
            .await
            .unwrap();
        let mut cached_response = Vec::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            cached_local.read_to_end(&mut cached_response),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(String::from_utf8_lossy(&cached_response).contains("200 OK"));
        assert!(cached_response.ends_with(b"\r\n\r\n\x89PNG\r\n\x1a\nfake-image"));

        proxy.stop();
        let _ = std::fs::remove_dir_all(cache_root);
    }

    /// 直播房间封面传入 `nocache=1`：body 仍必须经代理转发（Referer 才是关键），
    /// 但绝不进入磁盘缓存，WebView 也只能短暂持有它。
    #[tokio::test]
    async fn nocache_requests_are_proxied_without_touching_the_disk_cache() {
        use std::io::{Read, Write};
        use std::net::TcpListener as StdTcpListener;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let upstream = StdTcpListener::bind("127.0.0.1:0").unwrap();
        let upstream_addr = upstream.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = upstream.accept().unwrap();
                let mut request = [0_u8; 2048];
                let _ = stream.read(&mut request).unwrap();
                let body = b"\x89PNG\r\n\x1a\nlive-cover";
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
            }
        });

        let cache_root = std::env::temp_dir().join(format!(
            "rlive-image-proxy-nocache-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let proxy = ImageProxy::new(cache_root.clone());
        let base = proxy.start_with_allowlist(&["127.0.0.1"]).await.unwrap();
        let encoded = format!("http://{upstream_addr}/cover.png")
            .bytes()
            .map(|byte| match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    (byte as char).to_string()
                }
                _ => format!("%{byte:02X}"),
            })
            .collect::<String>();
        let path = format!("/img?nocache=1&url={encoded}");

        for _ in 0..2 {
            let mut local = tokio::net::TcpStream::connect(base.trim_start_matches("http://"))
                .await
                .unwrap();
            local
                .write_all(
                    format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                        .as_bytes(),
                )
                .await
                .unwrap();
            let mut response = Vec::new();
            tokio::time::timeout(
                std::time::Duration::from_secs(10),
                local.read_to_end(&mut response),
            )
            .await
            .unwrap()
            .unwrap();
            let text = String::from_utf8_lossy(&response);
            assert!(text.contains("200 OK"), "{text}");
            assert!(
                text.contains("Cache-Control: private, max-age=120"),
                "{text}"
            );
            assert!(response.ends_with(b"\r\n\r\n\x89PNG\r\n\x1a\nlive-cover"));
        }

        // 两个请求都到达了（两次额度的）上游，因此没有一个来自磁盘，
        // 也没有写入任何缓存。
        server.join().unwrap();
        assert_eq!(proxy.cache_usage().await.files, 0);

        proxy.stop();
        let _ = std::fs::remove_dir_all(cache_root);
    }
}
