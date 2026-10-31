//! 可续传的运行库与模型下载。
//!
//! 数据边下边写进 `.part`，连接中断后带 `Range` 从已写入处接着下；取消或重试用尽时
//! 保留 `.part`，下次启用从磁盘上的长度续传。结束时校验大小与 SHA-256，服务端内容
//! 与预期对不上时删除 `.part`；若那份 `.part` 来自上一次下载，再从头下一次。

use std::io::Read;
use std::path::Path;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use reqwest::{StatusCode, header};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::error::{AppError, AppResult};

/// 连续没有新数据的尝试达到这个次数就放弃；有进展的重试不计数。
const MAX_STALLED_ATTEMPTS: u32 = 5;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
const BACKOFF_UNIT: Duration = if cfg!(test) {
    Duration::from_millis(1)
} else {
    Duration::from_millis(500)
};

pub struct Source<'a> {
    pub label: &'a str,
    pub url: &'a str,
    pub size: u64,
    pub sha256: &'a str,
}

pub enum Progress {
    /// `.part` 中已有的字节数。
    Downloading(u64),
    /// 连接中断，即将从这个字节数续传。
    Retrying(u64),
    /// 正在读取已有的 `.part` 计算摘要。
    Verifying,
}

enum Failure {
    /// 网络错误：保留 `.part`，稍后续传。
    Retry(AppError),
    /// 本地错误或服务端拒绝：保留 `.part`，直接失败。
    Fatal(AppError),
    /// 服务端内容与预期不符：删除 `.part` 后失败。
    Discard(AppError),
}

/// 下载到 `partial` 并校验大小与 SHA-256。返回 `Ok(false)` 表示 `is_current` 变为假，
/// 已写入的数据留在 `.part` 里。
pub async fn download(
    client: &reqwest::Client,
    source: &Source<'_>,
    partial: &Path,
    is_current: &impl Fn() -> bool,
    report: &mut impl FnMut(Progress),
) -> AppResult<bool> {
    let resumed = partial_len(partial).await > 0;
    let result = download_once(client, source, partial, is_current, report).await;
    if resumed && result.is_err() && partial_len(partial).await == 0 {
        // 旧 `.part` 与服务端内容对不上，已被删除：从头再下一次。
        return download_once(client, source, partial, is_current, report).await;
    }
    result
}

async fn download_once(
    client: &reqwest::Client,
    source: &Source<'_>,
    partial: &Path,
    is_current: &impl Fn() -> bool,
    report: &mut impl FnMut(Progress),
) -> AppResult<bool> {
    let mut written = partial_len(partial).await;
    if written > source.size {
        remove_partial(partial).await?;
        written = 0;
    }
    let mut digest = Sha256::new();
    if written > 0 {
        report(Progress::Verifying);
        digest = hash_file(partial).await?;
    }

    let mut stalled = 0;
    while written < source.size {
        if !is_current() {
            return Ok(false);
        }
        let before = written;
        let error = match fetch(
            client,
            source,
            partial,
            &mut written,
            &mut digest,
            is_current,
            report,
        )
        .await
        {
            Ok(true) => break,
            Ok(false) => return Ok(false),
            Err(Failure::Retry(error)) => error,
            Err(Failure::Fatal(error)) => return Err(error),
            Err(Failure::Discard(error)) => {
                remove_partial(partial).await?;
                return Err(error);
            }
        };
        stalled = if written > before { 0 } else { stalled + 1 };
        if stalled >= MAX_STALLED_ATTEMPTS {
            return Err(error);
        }
        report(Progress::Retrying(written));
        if !wait(BACKOFF_UNIT * (1 << stalled.min(4)), is_current).await {
            return Ok(false);
        }
    }

    if hex::encode(digest.finalize()) != source.sha256 {
        remove_partial(partial).await?;
        return Err(AppError::new(
            "asr_model_hash",
            format!("{}完整性校验失败", source.label),
        ));
    }
    Ok(is_current())
}

/// 发起一次请求并把响应体追加进 `.part`。`Ok(true)` 表示收齐，`Ok(false)` 表示被取消。
async fn fetch(
    client: &reqwest::Client,
    source: &Source<'_>,
    partial: &Path,
    written: &mut u64,
    digest: &mut Sha256,
    is_current: &impl Fn() -> bool,
    report: &mut impl FnMut(Progress),
) -> Result<bool, Failure> {
    let mut request = client.get(source.url);
    if *written > 0 {
        request = request.header(header::RANGE, format!("bytes={written}-"));
    }
    let response = request
        .send()
        .await
        .map_err(|_| Failure::Retry(download_error("模型下载请求失败")))?;
    let append = match response.status() {
        StatusCode::PARTIAL_CONTENT if *written > 0 => {
            if content_range(&response) != Some((*written, source.size)) {
                return Err(Failure::Discard(size_error("模型下载分段与预期不符")));
            }
            true
        }
        // 服务端忽略了 Range：从头写。
        StatusCode::OK => false,
        StatusCode::RANGE_NOT_SATISFIABLE => {
            return Err(Failure::Discard(size_error("模型下载分段与预期不符")));
        }
        status if status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS => {
            return Err(Failure::Retry(download_error("模型下载服务暂时不可用")));
        }
        _ => return Err(Failure::Fatal(download_error("模型下载服务返回错误"))),
    };
    let remaining = source.size - if append { *written } else { 0 };
    if response
        .content_length()
        .is_some_and(|length| length != remaining)
    {
        return Err(Failure::Discard(size_error("模型文件大小与预期不符")));
    }

    let file = if append {
        tokio::fs::OpenOptions::new()
            .append(true)
            .open(partial)
            .await
    } else {
        *written = 0;
        *digest = Sha256::new();
        tokio::fs::File::create(partial).await
    };
    let mut file = file.map_err(|_| Failure::Fatal(write_error("无法写入模型临时文件")))?;

    let mut stream = response.bytes_stream();
    let mut last_report: Option<Instant> = None;
    let result = loop {
        if !is_current() {
            break Ok(false);
        }
        let Some(chunk) = stream.next().await else {
            break if *written == source.size {
                Ok(true)
            } else {
                Err(Failure::Retry(download_error("模型下载中断")))
            };
        };
        let Ok(chunk) = chunk else {
            break Err(Failure::Retry(download_error("模型下载中断")));
        };
        if *written + chunk.len() as u64 > source.size {
            break Err(Failure::Discard(size_error("模型文件大小超出预期")));
        }
        if file.write_all(&chunk).await.is_err() {
            break Err(Failure::Fatal(write_error("写入模型文件失败")));
        }
        digest.update(&chunk);
        *written += chunk.len() as u64;
        if last_report.is_none_or(|at| at.elapsed() >= PROGRESS_INTERVAL) {
            last_report = Some(Instant::now());
            report(Progress::Downloading(*written));
        }
    };
    // 中断与取消时也要把已收到的数据落盘，内存里的进度才和 `.part` 一致。
    if file.flush().await.is_err() {
        return Err(Failure::Fatal(write_error("保存模型文件失败")));
    }
    result
}

/// 等待 `delay`，期间请求失效就提前返回 `false`。
async fn wait(delay: Duration, is_current: &impl Fn() -> bool) -> bool {
    let deadline = Instant::now() + delay;
    loop {
        if !is_current() {
            return false;
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return true;
        }
        tokio::time::sleep(left.min(Duration::from_millis(100))).await;
    }
}

/// `Content-Range: bytes <start>-<end>/<total>` 中的起点与总长。
fn content_range(response: &reqwest::Response) -> Option<(u64, u64)> {
    let value = response
        .headers()
        .get(header::CONTENT_RANGE)?
        .to_str()
        .ok()?;
    let (range, total) = value.strip_prefix("bytes ")?.split_once('/')?;
    let (start, _) = range.split_once('-')?;
    Some((start.trim().parse().ok()?, total.trim().parse().ok()?))
}

async fn partial_len(partial: &Path) -> u64 {
    tokio::fs::metadata(partial)
        .await
        .map_or(0, |metadata| metadata.len())
}

async fn hash_file(path: &Path) -> AppResult<Sha256> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut file = std::fs::File::open(&path).ok()?;
        let mut digest = Sha256::new();
        let mut buffer = vec![0_u8; 1 << 20];
        loop {
            match file.read(&mut buffer).ok()? {
                0 => return Some(digest),
                read => digest.update(&buffer[..read]),
            }
        }
    })
    .await
    .ok()
    .flatten()
    .ok_or_else(|| write_error("无法读取模型临时文件"))
}

pub async fn remove_partial(partial: &Path) -> AppResult<()> {
    match tokio::fs::remove_file(partial).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(write_error("无法清理模型临时文件")),
    }
}

fn download_error(message: &str) -> AppError {
    AppError::new("asr_model_download", message)
}

fn size_error(message: &str) -> AppError {
    AppError::new("asr_model_size", message)
}

fn write_error(message: &str) -> AppError {
    AppError::new("asr_model_write", message)
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    use super::*;

    type Reply = Box<dyn Fn(Option<u64>) -> Vec<u8> + Send>;

    /// 依次用 `replies` 应答每个连接，返回 URL 与每次请求的 Range 起点。
    fn serve(replies: Vec<Reply>) -> (String, Arc<Mutex<Vec<Option<u64>>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/model.bin", listener.local_addr().unwrap());
        let ranges = Arc::new(Mutex::new(Vec::new()));
        let seen = ranges.clone();
        std::thread::spawn(move || {
            for reply in replies {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = Vec::new();
                let mut buffer = [0_u8; 1024];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let read = stream.read(&mut buffer).unwrap();
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..read]);
                }
                let request = String::from_utf8_lossy(&request).to_ascii_lowercase();
                let start = request
                    .lines()
                    .find_map(|line| line.strip_prefix("range: bytes="))
                    .and_then(|range| range.trim_end_matches('-').parse().ok());
                seen.lock().unwrap().push(start);
                let _ = stream.write_all(&reply(start));
            }
        });
        (url, ranges)
    }

    fn temp_partial() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "rlive-asr-download-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("model.bin.part")
    }

    fn body() -> Vec<u8> {
        (0..64 * 1024)
            .map(|index| (index * 31 % 251) as u8)
            .collect()
    }

    fn sha256_hex(data: &[u8]) -> String {
        hex::encode(Sha256::digest(data))
    }

    /// 按请求的 Range 应答；`cut` 为真时只发一半响应体就断开。
    fn ranged(data: Vec<u8>, cut: bool) -> Reply {
        Box::new(move |start| {
            let start = start.unwrap_or(0) as usize;
            let rest = &data[start..];
            let sent = if cut { &rest[..rest.len() / 2] } else { rest };
            let head = if start > 0 {
                format!(
                    "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {start}-{}/{}\r\n",
                    data.len() - 1,
                    data.len()
                )
            } else {
                "HTTP/1.1 200 OK\r\n".to_owned()
            };
            let mut reply = format!(
                "{head}Content-Length: {}\r\nConnection: close\r\n\r\n",
                rest.len()
            )
            .into_bytes();
            reply.extend_from_slice(sent);
            reply
        })
    }

    /// 忽略 Range，总是返回完整的 200。
    fn full(data: Vec<u8>) -> Reply {
        Box::new(move |_| {
            let mut reply = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                data.len()
            )
            .into_bytes();
            reply.extend_from_slice(&data);
            reply
        })
    }

    async fn run(
        url: &str,
        data: &[u8],
        partial: &Path,
        is_current: impl Fn() -> bool,
    ) -> AppResult<bool> {
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let sha256 = sha256_hex(data);
        let source = Source {
            label: "测试模型",
            url,
            size: data.len() as u64,
            sha256: &sha256,
        };
        download(&client, &source, partial, &is_current, &mut |_| {}).await
    }

    #[tokio::test]
    async fn resumes_from_the_received_bytes_after_a_dropped_connection() {
        let data = body();
        let (url, ranges) = serve(vec![
            ranged(data.clone(), true),
            ranged(data.clone(), false),
        ]);
        let partial = temp_partial();

        assert!(run(&url, &data, &partial, || true).await.unwrap());

        assert_eq!(std::fs::read(&partial).unwrap(), data);
        let ranges = ranges.lock().unwrap();
        assert_eq!(ranges.len(), 2);
        assert_eq!(ranges[0], None);
        assert!(ranges[1].is_some_and(|start| start > 0 && start < data.len() as u64));
    }

    #[tokio::test]
    async fn continues_a_part_file_left_by_an_earlier_session() {
        let data = body();
        let (url, ranges) = serve(vec![ranged(data.clone(), false)]);
        let partial = temp_partial();
        std::fs::write(&partial, &data[..30_000]).unwrap();

        assert!(run(&url, &data, &partial, || true).await.unwrap());

        assert_eq!(std::fs::read(&partial).unwrap(), data);
        assert_eq!(*ranges.lock().unwrap(), vec![Some(30_000)]);
    }

    #[tokio::test]
    async fn restarts_once_when_an_old_part_file_does_not_match() {
        let data = body();
        let (url, ranges) = serve(vec![
            ranged(data.clone(), false),
            ranged(data.clone(), false),
        ]);
        let partial = temp_partial();
        std::fs::write(&partial, vec![0_u8; 30_000]).unwrap();

        assert!(run(&url, &data, &partial, || true).await.unwrap());

        assert_eq!(std::fs::read(&partial).unwrap(), data);
        assert_eq!(*ranges.lock().unwrap(), vec![Some(30_000), None]);
    }

    #[tokio::test]
    async fn rewrites_from_the_start_when_the_server_ignores_range() {
        let data = body();
        let (url, _) = serve(vec![full(data.clone())]);
        let partial = temp_partial();
        std::fs::write(&partial, &data[..30_000]).unwrap();

        assert!(run(&url, &data, &partial, || true).await.unwrap());

        assert_eq!(std::fs::read(&partial).unwrap(), data);
    }

    #[tokio::test]
    async fn keeps_the_part_file_when_cancelled_after_an_interruption() {
        let data = body();
        let (url, ranges) = serve(vec![ranged(data.clone(), true)]);
        let partial = temp_partial();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let sha256 = sha256_hex(&data);
        let source = Source {
            label: "测试模型",
            url: &url,
            size: data.len() as u64,
            sha256: &sha256,
        };
        let cancelled = std::cell::Cell::new(false);

        let result = download(
            &client,
            &source,
            &partial,
            &|| !cancelled.get(),
            &mut |progress| {
                if matches!(progress, Progress::Retrying(_)) {
                    cancelled.set(true);
                }
            },
        )
        .await;

        assert!(!result.unwrap());
        assert_eq!(ranges.lock().unwrap().len(), 1);
        let kept = std::fs::read(&partial).unwrap();
        assert!(!kept.is_empty() && data.starts_with(&kept));
    }

    #[tokio::test]
    async fn deletes_the_part_file_when_the_hash_does_not_match() {
        let data = body();
        let mut served = data.clone();
        served[100] ^= 0xff;
        let (url, _) = serve(vec![ranged(served, false)]);
        let partial = temp_partial();

        let error = run(&url, &data, &partial, || true).await.unwrap_err();

        assert_eq!(error.code, "asr_model_hash");
        assert!(!partial.exists());
    }
}
