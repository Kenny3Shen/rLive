//! P-01 回归：使用本地可控上游验证缓存提交边界，不依赖 CDN 或真实媒体解码。

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio::time::timeout;

use super::{
    HlsResources, ManifestPin, PrefetchedInitialization, ProxyLoopContext, ProxyTelemetryCounters,
    StreamProxy, StreamProxyStartOptions, handle_client, request_header,
};
use crate::media_cache::{MediaCache, MediaCacheSpec};

const WAIT: Duration = Duration::from_secs(5);
const RANGE_REQUEST: &[u8] =
    b"GET /live HTTP/1.1\r\nHost: localhost\r\nRange: bytes=0-799\r\nConnection: close\r\n\r\n";

fn complete_body() -> Vec<u8> {
    // 包含非 UTF-8 字节，必须逐字节一致，不能用字符串后缀充当完整性断言。
    (0..800).map(|i| (i % 256) as u8).collect()
}

fn response(status: u16, range: &str, framing: &str, body: &[u8]) -> Vec<u8> {
    response_with_validators(status, range, "", framing, body)
}

/// 与 `response` 相同，但在 `Content-Range` 之后插入验证器响应头。
fn response_with_validators(
    status: u16,
    range: &str,
    validators: &str,
    framing: &str,
    body: &[u8],
) -> Vec<u8> {
    let mut result = format!(
        "HTTP/1.1 {status} Test\r\nContent-Type: video/mp4\r\nContent-Range: {range}\r\n{validators}{framing}\r\nConnection: close\r\n\r\n"
    )
    .into_bytes();
    result.extend_from_slice(body);
    result
}

fn complete_response() -> Vec<u8> {
    response(
        206,
        "bytes 0-799/1600",
        "Content-Length: 800",
        &complete_body(),
    )
}

async fn read_request_head(stream: &mut TcpStream) -> String {
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        head.push(stream.read_u8().await.unwrap());
        assert!(head.len() < 4096);
    }
    String::from_utf8(head).unwrap()
}

async fn read_request(stream: &mut TcpStream) {
    assert!(
        read_request_head(stream)
            .await
            .to_lowercase()
            .contains("range: bytes=0-799")
    );
}

struct Fixture {
    context: ProxyLoopContext,
    store: MediaCache,
    key: String,
    root: PathBuf,
    reply: Arc<Mutex<Vec<u8>>>,
    /// 按请求顺序消费的一次性回复，用完后回落到 `reply`。
    scripted: Arc<Mutex<VecDeque<Scripted>>>,
    requests: Arc<Mutex<Vec<String>>>,
    server: JoinHandle<()>,
}

/// 一次性上游回复；`stall` 为真时写完字节后不关连接，模拟 CDN 中途停顿。
struct Scripted {
    bytes: Vec<u8>,
    stall: bool,
}

impl Fixture {
    async fn new(reply: Vec<u8>) -> Self {
        let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_address = upstream.local_addr().unwrap();
        let reply = Arc::new(Mutex::new(reply));
        let server_reply = reply.clone();
        let scripted = Arc::new(Mutex::new(VecDeque::<Scripted>::new()));
        let server_scripted = scripted.clone();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let server_requests = requests.clone();
        let server = tokio::spawn(async move {
            while let Ok((mut stream, _)) = upstream.accept().await {
                let request = read_request_head(&mut stream).await;
                server_requests.lock().unwrap().push(request);
                let next = server_scripted.lock().unwrap().pop_front();
                match next {
                    Some(Scripted { bytes, stall: true }) => {
                        // 停顿的连接在后台挂着，不能阻塞下一次（续传）请求的 accept。
                        tokio::spawn(async move {
                            let _ = stream.write_all(&bytes).await;
                            tokio::time::sleep(WAIT).await;
                            drop(stream);
                        });
                    }
                    Some(Scripted {
                        bytes,
                        stall: false,
                    }) => {
                        let _ = stream.write_all(&bytes).await;
                    }
                    None => {
                        let bytes = server_reply.lock().unwrap().clone();
                        let _ = stream.write_all(&bytes).await;
                    }
                }
            }
        });
        let root =
            std::env::temp_dir().join(format!("rlive-cache-integrity-{}", uuid::Uuid::new_v4()));
        let store = MediaCache::new(root.clone());
        let spec = Arc::new(MediaCacheSpec::new(
            "BVfixture:1:112:v".into(),
            "video/mp4",
            vec![(0, 799)],
        ));
        let key = spec.key_for_range(0, 799).unwrap();
        let context = ProxyLoopContext {
            client: reqwest::Client::builder()
                .no_proxy()
                .timeout(WAIT)
                .build()
                .unwrap(),
            url: format!("http://{upstream_address}/media.m4s").into(),
            headers: Arc::new(HashMap::new()),
            hls_resources: Arc::new(HlsResources::new()),
            local_origin: "http://127.0.0.1".into(),
            force_hls: false,
            twitch_ad_recovery: None,
            douyu_flv_recovery: None,
            manifest_pin: Arc::new(ManifestPin::default()),
            telemetry: Arc::new(ProxyTelemetryCounters::new()),
            media_cache: Some(spec),
            media_cache_store: Some(store.clone()),
            initialization: None,
        };
        Self {
            context,
            store,
            key,
            root,
            reply,
            scripted,
            requests,
            server,
        }
    }

    fn script(&self, bytes: Vec<u8>, stall: bool) {
        self.scripted
            .lock()
            .unwrap()
            .push_back(Scripted { bytes, stall });
    }

    fn requested_ranges(&self) -> Vec<String> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .map(|request| {
                request_header(request, "range")
                    .unwrap_or_default()
                    .to_owned()
            })
            .collect()
    }

    fn requested_if_ranges(&self) -> Vec<Option<String>> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .map(|request| request_header(request, "if-range").map(str::to_owned))
            .collect()
    }

    fn upstream_resumes(&self) -> u64 {
        self.context
            .telemetry
            .upstream_resumes
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    /// 每次请求都等待真实 handle_client 结束，避免以“客户端收完”代替正常 EOF。
    async fn start_request_with(
        &self,
        request: &[u8],
    ) -> (TcpStream, JoinHandle<Result<(), String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let context = self.context.clone();
        let handler = tokio::spawn(async move { handle_client(&mut socket, context).await });
        client.write_all(request).await.unwrap();
        (client, handler)
    }

    async fn fetch(&self) -> (Vec<u8>, Result<(), String>) {
        self.fetch_request(RANGE_REQUEST).await
    }

    async fn fetch_request(&self, request: &[u8]) -> (Vec<u8>, Result<(), String>) {
        timeout(WAIT, async {
            let (mut client, handler) = self.start_request_with(request).await;
            let mut bytes = Vec::new();
            client.read_to_end(&mut bytes).await.unwrap();
            let result = handler.await.unwrap();
            (bytes, result)
        })
        .await
        .expect("本地代理请求未结束")
    }

    fn upstream_requests(&self) -> u64 {
        self.context
            .telemetry
            .upstream_requests
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    async fn wait_for_complete_cache(&self) {
        timeout(WAIT, async {
            loop {
                if self.store.get(&self.key).await.as_deref() == Some(complete_body().as_slice()) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("完整分片未提交到缓存");
    }

    async fn assert_not_cached(&self) {
        // 后台提交是尽力而为的 spawn；留出窗口检测错误路径迟到的坏提交。
        for _ in 0..10 {
            tokio::time::sleep(Duration::from_millis(10)).await;
            assert_eq!(
                self.store.get(&self.key).await,
                None,
                "畸形或中断响应不得落盘"
            );
        }
    }

    async fn assert_refetch_and_cache(&self, requests_before: u64) {
        *self.reply.lock().unwrap() = complete_response();
        let (bytes, result) = self.fetch().await;
        result.unwrap();
        assert_eq!(body(&bytes), complete_body());
        assert_eq!(
            self.upstream_requests(),
            requests_before + 1,
            "无效缓存必须回源"
        );
        self.wait_for_complete_cache().await;
        let (bytes, result) = self.fetch().await;
        result.unwrap();
        assert_eq!(body(&bytes), complete_body());
        assert_eq!(
            self.upstream_requests(),
            requests_before + 1,
            "完整缓存不应再次回源"
        );
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn body(response: &[u8]) -> &[u8] {
    let start = response
        .windows(4)
        .position(|part| part == b"\r\n\r\n")
        .unwrap()
        + 4;
    &response[start..]
}

#[tokio::test]
async fn prefetched_initialization_is_session_local_without_disk_cache() {
    let fixture = Fixture::new(complete_response()).await;
    let proxy = StreamProxy::new();
    let client = fixture.context.client.clone();
    let bytes: Arc<[u8]> = complete_body().into();
    let weak_bytes = Arc::downgrade(&bytes);
    let video_url = proxy
        .start(
            fixture.context.url.to_string(),
            HashMap::new(),
            "init-video".into(),
            StreamProxyStartOptions {
                initialization: Some(PrefetchedInitialization {
                    bytes,
                    content_type: "video/mp4",
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let audio_bytes = vec![42; 800];
    let audio_url = proxy
        .start(
            fixture.context.url.to_string(),
            HashMap::new(),
            "init-audio".into(),
            StreamProxyStartOptions {
                initialization: Some(PrefetchedInitialization {
                    bytes: audio_bytes.clone().into(),
                    content_type: "audio/mp4",
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    for (url, expected, content_type) in [
        (&video_url, complete_body(), "video/mp4"),
        (&audio_url, audio_bytes, "audio/mp4"),
    ] {
        for _ in 0..2 {
            let response = client
                .get(url)
                .header("Range", "bytes=0-799")
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 206);
            assert_eq!(response.headers()["content-length"], "800");
            assert_eq!(response.headers()["content-range"], "bytes 0-799/*");
            assert_eq!(response.headers()["content-type"], content_type);
            assert_eq!(response.bytes().await.unwrap().as_ref(), expected);
        }
    }
    assert!(fixture.requests.lock().unwrap().is_empty());

    // 相同上游地址的新会话没有传 init 时必须回源，不能借用另一会话的字节。
    let other_url = proxy
        .start(
            fixture.context.url.to_string(),
            HashMap::new(),
            "init-other".into(),
            StreamProxyStartOptions::default(),
        )
        .await
        .unwrap();
    let response = client
        .get(&other_url)
        .header("Range", "bytes=0-799")
        .send()
        .await
        .unwrap();
    assert_eq!(response.headers()["content-range"], "bytes 0-799/1600");
    assert_eq!(response.bytes().await.unwrap().as_ref(), complete_body());
    assert_eq!(fixture.requests.lock().unwrap().len(), 1);
    assert!(!fixture.root.exists(), "关闭磁盘缓存不得创建缓存目录");

    proxy.stop_for_session("init-video");
    proxy.stop_for_session("init-audio");
    proxy.stop_for_session("init-other");
    timeout(WAIT, async {
        while weak_bytes.upgrade().is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("代理停止后应释放会话内 init");
}

#[tokio::test]
async fn prefetched_initialization_forwards_non_exact_and_conditional_requests() {
    let upstream_body = vec![42; 800];
    let mut fixture = Fixture::new(response(
        206,
        "bytes 800-1599/1600",
        "Content-Length: 800",
        &upstream_body,
    ))
    .await;
    fixture.context.media_cache = None;
    fixture.context.media_cache_store = None;
    fixture.context.initialization = Some(PrefetchedInitialization {
        bytes: complete_body().into(),
        content_type: "video/mp4",
    });
    let resource = fixture
        .context
        .hls_resources
        .register(fixture.context.url.to_string());
    let resource = format!("/hls/{resource}");
    for (method, path, headers, range) in [
        ("GET", "/live", "", None),
        ("GET", "/live", "Range: bytes=0-\r\n", Some("bytes=0-")),
        ("GET", "/live", "Range: bytes=-800\r\n", Some("bytes=-800")),
        (
            "GET",
            "/live",
            "Range: bytes=0-798\r\n",
            Some("bytes=0-798"),
        ),
        (
            "GET",
            "/live",
            "Range: bytes=0-800\r\n",
            Some("bytes=0-800"),
        ),
        (
            "GET",
            "/live",
            "Range: bytes=800-1599\r\n",
            Some("bytes=800-1599"),
        ),
        (
            "GET",
            "/live",
            "Range: bytes=800-1599\r\n",
            Some("bytes=800-1599"),
        ),
        (
            "GET",
            "/live",
            "Range: bytes=0-799,800-1599\r\n",
            Some("bytes=0-799,800-1599"),
        ),
        (
            "GET",
            "/live",
            "Range: bytes=0-799\r\nRange: bytes=800-1599\r\n",
            Some("bytes=0-799"),
        ),
        (
            "GET",
            "/live",
            "Range: bytes=0-799\r\nIf-Range: \"etag\"\r\n",
            Some("bytes=0-799"),
        ),
        (
            "HEAD",
            "/live",
            "Range: bytes=0-799\r\n",
            Some("bytes=0-799"),
        ),
        (
            "GET",
            resource.as_str(),
            "Range: bytes=0-799\r\n",
            Some("bytes=0-799"),
        ),
    ] {
        let request = format!(
            "{method} {path} HTTP/1.1\r\nHost: localhost\r\n{headers}Connection: close\r\n\r\n"
        );
        let before = fixture.requests.lock().unwrap().len();
        let (bytes, result) = fixture.fetch_request(request.as_bytes()).await;
        result.unwrap();
        assert_eq!(
            body(&bytes),
            if method == "HEAD" {
                &[][..]
            } else {
                &upstream_body
            }
        );
        let requests = fixture.requests.lock().unwrap();
        assert_eq!(requests.len(), before + 1, "必须回源: {request}");
        assert_eq!(request_header(requests.last().unwrap(), "range"), range);
    }
    assert!(!fixture.root.exists());
}

#[tokio::test]
async fn prefetched_initialization_does_not_override_hls_or_serve_empty_bytes() {
    let mut fixture = Fixture::new(complete_response()).await;
    fixture.context.media_cache = None;
    fixture.context.media_cache_store = None;
    for (force_hls, bytes) in [(true, complete_body()), (false, Vec::new())] {
        fixture.context.force_hls = force_hls;
        fixture.context.initialization = Some(PrefetchedInitialization {
            bytes: bytes.into(),
            content_type: "video/mp4",
        });
        let before = fixture.requests.lock().unwrap().len();
        fixture.fetch().await.1.unwrap();
        assert_eq!(fixture.requests.lock().unwrap().len(), before + 1);
    }
}

#[tokio::test]
async fn media_cache_rejects_short_empty_and_long_bodies_even_with_clean_eof() {
    for length in [0, 7, 799, 801, 1600] {
        let bytes = vec![42; length];
        let fixture = Fixture::new(response(
            206,
            "bytes 0-799/1600",
            &format!("Content-Length: {length}"),
            &bytes,
        ))
        .await;
        let (forwarded, result) = fixture.fetch().await;
        result.unwrap();
        assert_eq!(body(&forwarded), bytes, "只跳过缓存，不篡改上游正文");
        fixture.assert_not_cached().await;
        fixture.assert_refetch_and_cache(1).await;
    }
}

#[tokio::test]
async fn media_cache_rejects_read_failure_when_resume_is_unavailable() {
    // 第一种是 Content-Length 体中断，续传请求又拿到不匹配的区间；第二种已经
    // 收到精确字节数，没有剩余可续传，但 chunked 缺结束块，仍不算上游正常 EOF。
    let mut unterminated_chunk = b"320\r\n".to_vec();
    unterminated_chunk.extend_from_slice(&complete_body());
    unterminated_chunk.extend_from_slice(b"\r\n");
    for reply in [
        response(206, "bytes 0-799/1600", "Content-Length: 800", b"prefix"),
        response(
            206,
            "bytes 0-799/1600",
            "Transfer-Encoding: chunked",
            &unterminated_chunk,
        ),
    ] {
        let fixture = Fixture::new(reply).await;
        let (_, result) = fixture.fetch().await;
        assert!(result.is_err(), "上游截断必须走读取失败路径");
        fixture.assert_not_cached().await;
        fixture
            .assert_refetch_and_cache(fixture.upstream_requests())
            .await;
    }
}

fn truncated_first_part() -> Vec<u8> {
    response(
        206,
        "bytes 0-799/1600",
        "Content-Length: 800",
        &complete_body()[..300],
    )
}

fn resumed_rest() -> Vec<u8> {
    response(
        206,
        "bytes 300-799/1600",
        "Content-Length: 500",
        &complete_body()[300..],
    )
}

#[tokio::test]
async fn segment_resumes_from_forwarded_offset_after_truncation_or_stall() {
    for stall in [false, true] {
        let fixture = Fixture::new(complete_response()).await;
        fixture.script(truncated_first_part(), stall);
        fixture.script(resumed_rest(), false);
        let (bytes, result) = fixture.fetch().await;
        result.unwrap();
        assert_eq!(body(&bytes), complete_body(), "续传后正文必须逐字节连续");
        assert_eq!(
            fixture.requested_ranges(),
            ["bytes=0-799", "bytes=300-799"],
            "续传必须从已转发的位置开始"
        );
        assert_eq!(fixture.upstream_resumes(), 1);
        // 拼接出的完整分片与一次读完的分片等价，可以落盘。
        fixture.wait_for_complete_cache().await;
    }
}

#[tokio::test]
async fn segment_resume_is_abandoned_when_upstream_ignores_resume_range() {
    let fixture = Fixture::new(complete_response()).await;
    fixture.script(truncated_first_part(), false);
    fixture.script(
        response(
            200,
            "bytes 0-799/1600",
            "Content-Length: 800",
            &complete_body(),
        ),
        false,
    );
    let (bytes, result) = fixture.fetch().await;
    assert!(result.is_err(), "续传被拒必须走读取失败路径");
    assert_eq!(body(&bytes), &complete_body()[..300], "不得拼接全量响应");
    assert_eq!(fixture.upstream_resumes(), 1, "区间不符时不再重试");
    fixture.assert_not_cached().await;
}

#[tokio::test]
async fn segment_resume_sends_if_range_from_strong_etag_or_last_modified() {
    // 强 ETag 优先；没有强 ETag 时退到 Last-Modified；弱 ETag 不能用于
    // If-Range（RFC 9110）；两者都没有时保持不带 If-Range 的旧行为。
    for (validators, expected) in [
        ("ETag: \"v1\"\r\n", Some("\"v1\"")),
        (
            "ETag: \"v1\"\r\nLast-Modified: Wed, 21 Oct 2015 07:28:00 GMT\r\n",
            Some("\"v1\""),
        ),
        (
            "Last-Modified: Wed, 21 Oct 2015 07:28:00 GMT\r\n",
            Some("Wed, 21 Oct 2015 07:28:00 GMT"),
        ),
        ("ETag: W/\"v1\"\r\n", None),
        ("", None),
    ] {
        let fixture = Fixture::new(complete_response()).await;
        fixture.script(
            response_with_validators(
                206,
                "bytes 0-799/1600",
                validators,
                "Content-Length: 800",
                &complete_body()[..300],
            ),
            false,
        );
        fixture.script(
            response_with_validators(
                206,
                "bytes 300-799/1600",
                validators,
                "Content-Length: 500",
                &complete_body()[300..],
            ),
            false,
        );
        let (bytes, result) = fixture.fetch().await;
        result.unwrap();
        assert_eq!(body(&bytes), complete_body(), "验证器：{validators:?}");
        assert_eq!(
            fixture.requested_if_ranges(),
            [None, expected.map(str::to_owned)],
            "续传请求的 If-Range 应来自首段验证器：{validators:?}"
        );
        fixture.wait_for_complete_cache().await;
    }
}

#[tokio::test]
async fn segment_resume_is_rejected_when_validator_changes() {
    let fixture = Fixture::new(complete_response()).await;
    fixture.script(
        response_with_validators(
            206,
            "bytes 0-799/1600",
            "ETag: \"v1\"\r\n",
            "Content-Length: 800",
            &complete_body()[..300],
        ),
        false,
    );
    // 区间仍是续传要的那段，但 ETag 已经变了：内容不能拼接。
    fixture.script(
        response_with_validators(
            206,
            "bytes 300-799/1600",
            "ETag: \"v2\"\r\n",
            "Content-Length: 500",
            &complete_body()[300..],
        ),
        false,
    );
    let (bytes, result) = fixture.fetch().await;
    assert!(result.is_err(), "验证器变化必须走续传被拒路径");
    assert_eq!(
        body(&bytes),
        &complete_body()[..300],
        "不得拼接不同版本的内容"
    );
    assert_eq!(fixture.upstream_resumes(), 1, "验证器不符时不再重试");
    fixture.assert_not_cached().await;
}

#[tokio::test]
async fn segment_resume_is_rejected_when_if_range_falls_back_to_full_body() {
    let fixture = Fixture::new(complete_response()).await;
    fixture.script(
        response_with_validators(
            206,
            "bytes 0-799/1600",
            "ETag: \"v1\"\r\n",
            "Content-Length: 800",
            &complete_body()[..300],
        ),
        false,
    );
    // 服务器判定 If-Range 不匹配时按 RFC 回 200 全量：即使 ETag 一致也必须拒绝。
    fixture.script(
        response_with_validators(
            200,
            "bytes 0-799/1600",
            "ETag: \"v1\"\r\n",
            "Content-Length: 800",
            &complete_body(),
        ),
        false,
    );
    let (bytes, result) = fixture.fetch().await;
    assert!(result.is_err(), "If-Range 回落全量必须走续传被拒路径");
    assert_eq!(body(&bytes), &complete_body()[..300], "不得拼接全量响应");
    assert_eq!(
        fixture.requested_if_ranges(),
        [None, Some("\"v1\"".to_owned())],
        "续传请求必须带上首段的强 ETag"
    );
    fixture.assert_not_cached().await;
}

#[tokio::test]
async fn oversized_range_end_does_not_overflow_the_remaining_length_check() {
    // `Range: bytes=0-18446744073709551615`（u64::MAX）配合匹配的 206 会让
    // 「已转发字节是否超出区间」的比较在 debug 构建里溢出 panic；这里盯住
    // 它只按饱和运算判定为未超出，并照常转发正文。
    let payload = b"0123456789".to_vec();
    let fixture = Fixture::new(response(
        206,
        "bytes 0-18446744073709551615/18446744073709551616",
        "Content-Length: 10",
        &payload,
    ))
    .await;
    let (bytes, result) = fixture
        .fetch_request(
            b"GET /live HTTP/1.1\r\nHost: localhost\r\n\
              Range: bytes=0-18446744073709551615\r\nConnection: close\r\n\r\n",
        )
        .await;
    result.unwrap();
    assert_eq!(body(&bytes), payload.as_slice());
    assert_eq!(fixture.upstream_resumes(), 0);
    fixture.assert_not_cached().await;
}

#[tokio::test]
async fn unreachable_upstream_is_answered_with_bad_gateway_after_one_retry() {
    let mut fixture = Fixture::new(complete_response()).await;
    let closed = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap();
    fixture.context.url = format!("http://{closed}/media.m4s").into();
    let (bytes, result) = fixture.fetch().await;
    assert!(result.is_err());
    let text = String::from_utf8_lossy(&bytes);
    assert!(text.starts_with("HTTP/1.1 502 Bad Gateway"), "{text}");
    assert!(!text.contains(&closed.to_string()), "不得回显上游地址");
    assert_eq!(fixture.upstream_requests(), 2, "分片请求发送失败应重试一次");
}

#[tokio::test]
async fn media_cache_accepts_complete_chunked_body_without_content_length() {
    let mut chunks = Vec::new();
    for chunk in complete_body().chunks(100) {
        chunks.extend_from_slice(b"64\r\n");
        chunks.extend_from_slice(chunk);
        chunks.extend_from_slice(b"\r\n");
    }
    chunks.extend_from_slice(b"0\r\n\r\n");
    let fixture = Fixture::new(response(
        206,
        "bytes 0-799/1600",
        "Transfer-Encoding: chunked",
        &chunks,
    ))
    .await;
    let (bytes, result) = fixture.fetch().await;
    result.unwrap();
    assert_eq!(body(&bytes), complete_body());
    fixture.wait_for_complete_cache().await;
    fixture.server.abort();
    let (bytes, result) = fixture.fetch().await;
    result.unwrap();
    assert_eq!(body(&bytes), complete_body());
    assert_eq!(fixture.upstream_requests(), 1);
}

#[tokio::test]
async fn media_cache_rejects_wrong_status_or_content_range() {
    for (status, range) in [(200, "bytes 0-799/1600"), (206, "bytes 800-1599/1600")] {
        let fixture = Fixture::new(response(
            status,
            range,
            "Content-Length: 800",
            &complete_body(),
        ))
        .await;
        fixture.fetch().await.1.unwrap();
        fixture.assert_not_cached().await;
        fixture.assert_refetch_and_cache(1).await;
    }
}

#[tokio::test]
async fn media_cache_treats_old_wrong_length_entries_as_misses() {
    for length in [0, 7, 801] {
        let fixture = Fixture::new(complete_response()).await;
        fixture.store.put(&fixture.key, &vec![42; length]).await;
        fixture.assert_refetch_and_cache(0).await;
    }
}

#[tokio::test]
async fn media_cache_discards_prefix_when_client_disconnects_between_chunks() {
    timeout(WAIT, async {
        let mut fixture = Fixture::new(complete_response()).await;
        let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = upstream.local_addr().unwrap();
        let recovery_url = fixture.context.url.clone();
        fixture.context.url = format!("http://{address}/media.m4s").into();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut stream, _) = upstream.accept().await.unwrap();
            read_request(&mut stream).await;
            stream
                .write_all(&response(
                    206,
                    "bytes 0-799/1600",
                    "Content-Length: 800",
                    b"first-block",
                ))
                .await
                .unwrap();
            release_rx.await.unwrap();
            // 只补一小块，仍未读满 800 字节；下游 RST 必须让 handle_client 放弃缓存。
            let _ = stream.write_all(b"second-block").await;
            let mut rest = Vec::new();
            let _ = stream.read_to_end(&mut rest).await;
        });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        // 复制同一个内核 socket，只用于确认 RST 已抵达，再让上游发第二块。
        // 不依赖 sleep 猜测 TCP 事件与 Tokio 调度的顺序。
        let duplicate = socket2::SockRef::from(&socket).try_clone().unwrap();
        let mut disconnect_probe = TcpStream::from_std(duplicate.into()).unwrap();
        let context = fixture.context.clone();
        let handler = tokio::spawn(async move { handle_client(&mut socket, context).await });
        client.write_all(RANGE_REQUEST).await.unwrap();
        let mut received = Vec::new();
        while !received.ends_with(b"first-block") {
            received.push(client.read_u8().await.unwrap());
        }
        socket2::SockRef::from(&client)
            .set_linger(Some(Duration::ZERO))
            .unwrap();
        drop(client); // RST，而不是仍允许接收正文的半关闭。
        assert!(!matches!(disconnect_probe.read(&mut [0]).await, Ok(1..)));
        drop(disconnect_probe);
        release_tx.send(()).unwrap();
        handler.await.unwrap().unwrap();
        server.await.unwrap();
        fixture.assert_not_cached().await;
        fixture.context.url = recovery_url;
        fixture.assert_refetch_and_cache(1).await;
    })
    .await
    .expect("客户端离开后代理未及时结束");
}

#[tokio::test]
async fn public_proxy_caches_exact_segments_but_budget_exhaustion_never_blocks_delivery() {
    for budget in [64, 4096] {
        let mut fixture = Fixture::new(complete_response()).await;
        fixture.store = MediaCache::with_write_budget(
            fixture.root.clone(),
            crate::media_cache::CacheWriteBudget::new(budget, 2),
        );
        let proxy = StreamProxy::new();
        let url = proxy
            .start(
                fixture.context.url.to_string(),
                HashMap::new(),
                "cache-budget".into(),
                StreamProxyStartOptions {
                    media_cache: fixture.context.media_cache.clone(),
                    media_cache_store: Some(fixture.store.clone()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        for attempt in 0..2 {
            let reply = fixture
                .context
                .client
                .get(&url)
                .header("Range", "bytes=0-799")
                .send()
                .await
                .unwrap();
            assert_eq!(reply.status(), 206);
            let expected_range = if budget >= 800 && attempt > 0 {
                "bytes 0-799/*"
            } else {
                "bytes 0-799/1600"
            };
            assert_eq!(reply.headers()["content-range"], expected_range);
            assert_eq!(reply.bytes().await.unwrap().as_ref(), complete_body());
            if budget >= 800 {
                fixture.wait_for_complete_cache().await;
            } else {
                fixture.assert_not_cached().await;
            }
            let expected_requests = if budget >= 800 { 1 } else { attempt + 1 };
            assert_eq!(fixture.requests.lock().unwrap().len(), expected_requests);
        }
        timeout(WAIT, async {
            while fixture.store.in_flight() != (0, 0) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("写盘后额度应归还");
        // 即使已有完整缓存，非精确分片请求仍须回源。
        *fixture.reply.lock().unwrap() = response(
            206,
            "bytes 0-499/1600",
            "Content-Length: 500",
            &complete_body()[..500],
        );
        let before = fixture.requests.lock().unwrap().len();
        let reply = fixture
            .context
            .client
            .get(&url)
            .header("Range", "bytes=0-499")
            .send()
            .await
            .unwrap();
        assert_eq!(
            reply.bytes().await.unwrap().as_ref(),
            &complete_body()[..500]
        );
        assert_eq!(fixture.requests.lock().unwrap().len(), before + 1);
        proxy.stop();
    }
}
