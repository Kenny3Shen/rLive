//! 本机 HTTP 代理，为 WebView 的图片加载附加 CDN 所需的 Referer / UA 请求头。
//!
//! 平台图片 CDN 可能拒绝缺少平台 Referer 的请求，
//! 而 WebView 无法为 `<img>` 标签附加它。前端把远程图片 URL 经这个回环服务器
//! 转发，由其带上相应请求头，并以显式 `Content-Length` 返回完整 body
//! （Windows WebView 对小图片的分块响应处理有误）。
//! 首次使用时惰性启动并存活整个应用生命周期。

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use percent_encoding::percent_decode_str;
use reqwest::Url;
use tauri::async_runtime::JoinHandle;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::sync::{Mutex as AsyncMutex, watch};

use crate::error::{AppError, AppResult};
use crate::image_cache::{ImageCache, MAX_IMAGE_BYTES, sniff_image_type};
use crate::local_http;

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
    "acfun.cn",
    "aixifan.com",
    "yximgs.com",
    "kwimgs.com",
];

const IMAGE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
/// WebView 通常只允许同一 HTTP/1.1 origin 同时建立少量连接。把图片稳定分流到
/// 四个回环 origin，可在保持完整响应与 `Content-Length` 的同时扩大并发窗口。
const IMAGE_PROXY_ORIGIN_COUNT: usize = 4;

/// 磁盘缓存图片（头像、分类图标）的 WebView 缓存生存期：
/// URL 随图片变化而变化，因此较长的生存期是安全的。
const CACHED_IMAGE_MAX_AGE: u32 = 24 * 60 * 60;
/// 直播房间封面只保留较短的 WebView 生存期 —— 足够让网格来回滚动时不重复
/// 抓取，又足够短，使 URL 稳定的预览图（Twitch `previews-ttv`）
/// 在浏览时仍能刷新。
const COVER_MAX_AGE: u32 = 120;
/// 有查询快照版本的封面只在主动刷新时换键，返回列表无需再次抓取。
const SNAPSHOT_COVER_MAX_AGE: u32 = 24 * 60 * 60;

pub struct ImageProxy {
    state: Mutex<Option<ImageProxyInner>>,
    cache: Arc<ImageCache>,
    /// 启动包含多个监听器。并发调用必须串行完成，避免两组 origin 同时存在或
    /// 较早的启动结果覆盖较新的代理路由。
    start_gate: AsyncMutex<()>,
}

struct ImageProxyInner {
    bases: Vec<String>,
    route: crate::proxy::ProxyRoute,
    shutdown: watch::Sender<bool>,
    tasks: Vec<JoinHandle<()>>,
}

impl ImageProxy {
    pub fn new(cache_root: PathBuf) -> Self {
        Self {
            state: Mutex::new(None),
            cache: Arc::new(ImageCache::new(cache_root)),
            start_gate: AsyncMutex::new(()),
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
            Self::stop_inner(inner);
        }
    }

    fn stop_inner(inner: ImageProxyInner) {
        let _ = inner.shutdown.send(true);
        for task in inner.tasks {
            task.abort();
        }
    }

    /// 幂等：已在运行且路由未变时返回现有的回环 origin 列表。
    ///
    /// 路由变化（用户改了代理模式）必须重启：客户端在启动时就把代理策略烧进了
    /// 连接池，改设置后继续用旧监听器会一直走旧出口。前端应在设置保存成功后
    /// 再次调用 `image_proxy_url`，取得重启后的 origin 列表。
    pub async fn start(&self, route: &crate::proxy::ProxyRoute) -> AppResult<Vec<String>> {
        let _start = self.start_gate.lock().await;
        self.start_locked(ALLOWED_IMAGE_HOSTS, route).await
    }

    /// 以显式的上游白名单启动 `start`（测试使用回环主机）。
    #[cfg(test)]
    async fn start_with_allowlist(
        &self,
        hosts: &'static [&'static str],
        route: &crate::proxy::ProxyRoute,
    ) -> AppResult<Vec<String>> {
        let _start = self.start_gate.lock().await;
        self.start_locked(hosts, route).await
    }

    async fn start_locked(
        &self,
        hosts: &'static [&'static str],
        route: &crate::proxy::ProxyRoute,
    ) -> AppResult<Vec<String>> {
        {
            let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(inner) = state.as_ref()
                && &inner.route == route
            {
                return Ok(inner.bases.clone());
            }
        }

        let client = image_client(route)?;
        // 所有监听器先绑定完成再安装任务。任一次 bind 失败时局部 listeners
        // 会整体释放，旧服务也仍可用，不会留下一套不完整的 origin。
        let mut listeners = Vec::with_capacity(IMAGE_PROXY_ORIGIN_COUNT);
        let mut bases = Vec::with_capacity(IMAGE_PROXY_ORIGIN_COUNT);
        for _ in 0..IMAGE_PROXY_ORIGIN_COUNT {
            let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| {
                AppError::new("image_proxy_bind", format!("bind localhost failed: {e}")).retryable()
            })?;
            let port = listener
                .local_addr()
                .map_err(|e| AppError::new("image_proxy_bind", e.to_string()))?
                .port();
            listeners.push(listener);
            bases.push(Self::base_url(port));
        }

        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let tasks = listeners
            .into_iter()
            .map(|listener| {
                tauri::async_runtime::spawn(run_image_proxy(
                    listener,
                    hosts,
                    shutdown_rx.clone(),
                    self.cache.clone(),
                    client.clone(),
                ))
            })
            .collect();
        let next = ImageProxyInner {
            bases: bases.clone(),
            route: route.clone(),
            shutdown: shutdown_tx,
            tasks,
        };
        // 新监听器已经完整就绪。原子替换状态后再停止旧组；因为绑定新端口时旧
        // listener 仍持有原端口，新旧 origin 必然不重叠，切换期间也没有服务空窗。
        let previous = {
            let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            state.replace(next)
        };
        if let Some(previous) = previous {
            Self::stop_inner(previous);
        }
        let cache = self.cache.clone();
        tauri::async_runtime::spawn(async move {
            cache.sweep().await;
        });
        Ok(bases)
    }

    fn base_url(port: u16) -> String {
        format!("http://127.0.0.1:{port}")
    }
}

fn image_client(route: &crate::proxy::ProxyRoute) -> AppResult<reqwest::Client> {
    crate::http_client::with_route(
        reqwest::Client::builder()
            .use_native_tls()
            .timeout(IMAGE_TIMEOUT)
            .connect_timeout(std::time::Duration::from_secs(8))
            .user_agent(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            ),
        route,
    )
    .and_then(|builder| {
        builder
            .build()
            .map_err(|_| AppError::new("image_proxy_client", "图片代理网络客户端初始化失败"))
    })
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
    } else if host.ends_with("acfun.cn")
        || host.ends_with("aixifan.com")
        || host.ends_with("yximgs.com")
        || host.ends_with("kwimgs.com")
    {
        Some("https://www.acfun.cn/")
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
    client: reqwest::Client,
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
    let head = local_http::read_request_head(socket, local_http::MAX_REQUEST_HEAD_BYTES)
        .await
        .map_err(|e| format!("read request: {e}"))?;
    let Some(head) = head.filter(|head| !head.is_empty()) else {
        return Ok(());
    };
    let head = String::from_utf8_lossy(&head);
    let (method, target) = local_http::request_line(&head);

    if local_http::answer_method_preflight(socket, method)
        .await
        .map_err(|e| format!("write options: {e}"))?
    {
        return Ok(());
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
    let cover_snapshot = query.split('&').any(|pair| {
        pair.strip_prefix("revision=")
            .is_some_and(|revision| !revision.is_empty())
    });

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

    // 上游失败也要回一个完整响应：直接断开会被 WebView 记成 ERR_EMPTY_RESPONSE，
    // 看起来像本机代理坏了，而不是一张图片加载失败。
    let upstream = match request.send().await {
        Ok(upstream) => upstream,
        Err(e) => {
            write_bad_gateway(socket).await?;
            return Err(format!("upstream: {e}"));
        }
    };
    let status = upstream.status().as_u16();
    let status_reason = upstream.status().canonical_reason().unwrap_or("Error");
    let content_type = upstream
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    if method == "HEAD" {
        return write_response_bytes(socket, status, status_reason, &content_type, &[], None).await;
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

    let bytes = match upstream.bytes().await {
        Ok(bytes) => bytes,
        Err(e) => {
            write_bad_gateway(socket).await?;
            return Err(format!("body: {e}"));
        }
    };
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
    } else if cover_snapshot {
        SNAPSHOT_COVER_MAX_AGE
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

/// 固定文本，不回显上游地址（可能带签名）。
async fn write_bad_gateway(socket: &mut tokio::net::TcpStream) -> Result<(), String> {
    write_response_bytes(
        socket,
        502,
        "Bad Gateway",
        "text/plain; charset=utf-8",
        b"upstream image request failed",
        None,
    )
    .await
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
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: {content_type}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         {}\
         Connection: close\r\n\
         Content-Length: {}\r\n\r\n",
        cache_control,
        body.len()
    );
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
        ALLOWED_IMAGE_HOSTS, COVER_MAX_AGE, ImageProxy, SNAPSHOT_COVER_MAX_AGE, host_is_allowed,
        parse_image_url, percent_decode, referer_for,
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
        assert!(host_is_allowed("imgs.aixifan.com", ALLOWED_IMAGE_HOSTS));
        assert!(host_is_allowed(
            "tx-free-imgs.acfun.cn",
            ALLOWED_IMAGE_HOSTS
        ));
        assert!(host_is_allowed("p4.a.yximgs.com", ALLOWED_IMAGE_HOSTS));
        assert!(host_is_allowed("hw2.a.kwimgs.com", ALLOWED_IMAGE_HOSTS));
        assert!(!host_is_allowed("acfun.cn.evil.com", ALLOWED_IMAGE_HOSTS));
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
        for host in [
            "imgs.aixifan.com",
            "tx-free-imgs.acfun.cn",
            "p4.a.yximgs.com",
            "hw2.a.kwimgs.com",
        ] {
            assert_eq!(referer_for(host), Some("https://www.acfun.cn/"));
        }
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
        use std::collections::HashSet;
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
        let bases = proxy
            .start_with_allowlist(&["127.0.0.1"], &crate::proxy::ProxyRoute::Direct)
            .await
            .unwrap();
        assert_eq!(bases.len(), 4);
        assert_eq!(bases.iter().collect::<HashSet<_>>().len(), 4);
        let repeated = proxy
            .start_with_allowlist(&["127.0.0.1"], &crate::proxy::ProxyRoute::Direct)
            .await
            .unwrap();
        assert_eq!(repeated, bases, "同一路由必须幂等返回相同的 origin 列表");
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
        let path = format!("/img?url={encoded_upstream}");

        let mut local = tokio::net::TcpStream::connect(bases[0].trim_start_matches("http://"))
            .await
            .unwrap();
        // origin 形式的请求目标（`/img?url=…`），与 WebView 发送的一致。
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
        // 且改走另一个本机 origin，以此证明所有监听器共享磁盘缓存。
        let mut cached_local =
            tokio::net::TcpStream::connect(bases[1].trim_start_matches("http://"))
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
    /// 但绝不进入磁盘缓存。旧请求只能短暂持有；带列表快照版本时，唯一 URL 可让
    /// WebView 在返回列表时复用，同时主动刷新仍会生成新键。
    #[tokio::test]
    async fn nocache_requests_are_proxied_without_touching_the_disk_cache() {
        use std::io::{Read, Write};
        use std::net::TcpListener as StdTcpListener;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let upstream = StdTcpListener::bind("127.0.0.1:0").unwrap();
        let upstream_addr = upstream.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for _ in 0..4 {
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
        let bases = proxy
            .start_with_allowlist(&["127.0.0.1"], &crate::proxy::ProxyRoute::Direct)
            .await
            .unwrap();
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
        let revision_path = format!("/img?nocache=1&revision=snapshot-1&url={encoded}");

        for (base, (request_path, max_age)) in bases.iter().zip([
            (path.as_str(), COVER_MAX_AGE),
            (path.as_str(), COVER_MAX_AGE),
            (revision_path.as_str(), SNAPSHOT_COVER_MAX_AGE),
            (path.as_str(), COVER_MAX_AGE),
        ]) {
            let mut local = tokio::net::TcpStream::connect(base.trim_start_matches("http://"))
                .await
                .unwrap();
            local
                .write_all(
                    format!(
                        "GET {request_path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
                    )
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
                text.contains(&format!("Cache-Control: private, max-age={max_age}")),
                "{text}"
            );
            assert!(response.ends_with(b"\r\n\r\n\x89PNG\r\n\x1a\nlive-cover"));
        }

        // 四个 origin 各转发一次，因此四个请求都到达了上游、没有一个来自磁盘，
        // 也没有写入任何缓存。
        server.join().unwrap();
        assert_eq!(proxy.cache_usage().await.files, 0);

        proxy.stop();
        let _ = std::fs::remove_dir_all(cache_root);
    }

    #[tokio::test]
    async fn concurrent_same_route_start_returns_identical_origin_set() {
        use std::collections::HashSet;

        let cache_root = std::env::temp_dir().join(format!(
            "rlive-image-proxy-concurrent-start-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let proxy = ImageProxy::new(cache_root.clone());
        let route = crate::proxy::ProxyRoute::Direct;
        let (left, right) = tokio::join!(
            proxy.start_with_allowlist(&["127.0.0.1"], &route),
            proxy.start_with_allowlist(&["127.0.0.1"], &route),
        );
        let left = left.unwrap();
        let right = right.unwrap();

        assert_eq!(left, right, "并发同路由启动必须取得同一组 origin");
        assert_eq!(left.len(), 4);
        assert_eq!(left.iter().collect::<HashSet<_>>().len(), 4);
        assert_eq!(
            proxy
                .start_with_allowlist(&["127.0.0.1"], &route)
                .await
                .unwrap(),
            left,
            "并发启动后的再次调用仍须幂等"
        );

        proxy.stop();
        let _ = std::fs::remove_dir_all(cache_root);
    }

    #[tokio::test]
    async fn route_change_replaces_all_origins_atomically() {
        use std::collections::HashSet;

        let cache_root = std::env::temp_dir().join(format!(
            "rlive-image-proxy-lifecycle-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let proxy = ImageProxy::new(cache_root.clone());
        let first = proxy
            .start_with_allowlist(&["127.0.0.1"], &crate::proxy::ProxyRoute::Direct)
            .await
            .unwrap();
        assert_eq!(first.len(), 4);

        let switched_route = crate::proxy::ProxyRoute::System(None);
        let switched = proxy
            .start_with_allowlist(&["127.0.0.1"], &switched_route)
            .await
            .unwrap();
        assert_eq!(switched.len(), 4);
        assert_eq!(switched.iter().collect::<HashSet<_>>().len(), 4);
        assert!(
            first.iter().all(|base| !switched.contains(base)),
            "路由切换不得沿用旧 origin"
        );

        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let mut any_open = false;
                for base in &first {
                    if tokio::net::TcpStream::connect(base.trim_start_matches("http://"))
                        .await
                        .is_ok()
                    {
                        any_open = true;
                    }
                }
                if !any_open {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("路由切换后仍有旧 origin 接受连接");

        for base in &switched {
            tokio::net::TcpStream::connect(base.trim_start_matches("http://"))
                .await
                .expect("切换后的 origin 未监听");
        }
        assert_eq!(
            proxy
                .start_with_allowlist(&["127.0.0.1"], &switched_route)
                .await
                .unwrap(),
            switched,
            "切换后的同一路由仍须幂等"
        );

        proxy.stop();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let mut any_open = false;
                for base in &switched {
                    if tokio::net::TcpStream::connect(base.trim_start_matches("http://"))
                        .await
                        .is_ok()
                    {
                        any_open = true;
                    }
                }
                if !any_open {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("stop 后仍有当前 origin 接受连接");

        let restarted = proxy
            .start_with_allowlist(&["127.0.0.1"], &switched_route)
            .await
            .unwrap();
        assert_eq!(restarted.len(), 4);
        for base in &restarted {
            tokio::net::TcpStream::connect(base.trim_start_matches("http://"))
                .await
                .expect("重启后的 origin 未监听");
        }

        proxy.stop();
        let _ = std::fs::remove_dir_all(cache_root);
    }

    /// 上游连不上时必须回 502，而不是不写任何字节就断开（ERR_EMPTY_RESPONSE）。
    #[tokio::test]
    async fn unreachable_upstream_is_answered_with_bad_gateway() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // 先占一个端口再释放，得到一个当前无人监听的地址。
        let closed_addr = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap();
        let cache_root = std::env::temp_dir().join(format!(
            "rlive-image-proxy-unreachable-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let proxy = ImageProxy::new(cache_root.clone());
        let bases = proxy
            .start_with_allowlist(&["127.0.0.1"], &crate::proxy::ProxyRoute::Direct)
            .await
            .unwrap();
        let encoded = format!("http%3A%2F%2F{closed_addr}%2Fpic.png").replace(':', "%3A");
        let mut local = tokio::net::TcpStream::connect(bases[0].trim_start_matches("http://"))
            .await
            .unwrap();
        local
            .write_all(
                format!(
                    "GET /img?url={encoded} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
                )
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
        assert!(text.starts_with("HTTP/1.1 502 Bad Gateway"), "{text}");
        assert!(text.contains("Cache-Control: no-store"), "{text}");
        assert!(!text.contains(&closed_addr.to_string()), "不得回显上游地址");

        proxy.stop();
        let _ = std::fs::remove_dir_all(cache_root);
    }
}
