//! 本机 / 局域网小型 HTTP 服务的公共部分。
//!
//! 流代理、图片代理、录制回放、DLNA 中继与局域网同步各自只处理一次请求就关闭连接
//! （`Connection: close`），因此只需要读请求头、按方法分流、按需改写 HLS 清单；
//! 响应头的字段集合因服务而异，留在各自模块。本地媒体文件响应统一放在这里，
//! 让录制回放与下载回放共用同一套 Range、HEAD 和 MIME 语义。

use std::path::Path;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;

/// 请求头上限：这些服务只接收短 URL 与少数请求头，超出即视为异常连接。
pub(crate) const MAX_REQUEST_HEAD_BYTES: usize = 8 * 1024;

/// 读到请求头结束（`\r\n\r\n`，兼容裸 `\n\n`）为止，最多 `max_bytes` 字节。
///
/// 返回已读字节；对端未发任何内容即关闭时返回空缓冲。超过上限或在头部结束前断开
/// 时返回 `None`，调用方直接丢弃这条连接。请求体不会被使用，因此不必精确停在头尾。
pub(crate) async fn read_request_head<S: AsyncRead + Unpin>(
    socket: &mut S,
    max_bytes: usize,
) -> std::io::Result<Option<Vec<u8>>> {
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 1024];
    loop {
        let read = socket.read(&mut chunk).await?;
        if read == 0 {
            return Ok(buffer.is_empty().then_some(buffer));
        }
        buffer.extend_from_slice(&chunk[..read]);
        if head_complete(&buffer) {
            return Ok(Some(buffer));
        }
        if buffer.len() >= max_bytes {
            return Ok(None);
        }
    }
}

fn head_complete(buffer: &[u8]) -> bool {
    buffer.windows(4).any(|window| window == b"\r\n\r\n")
        || buffer.windows(2).any(|window| window == b"\n\n")
}

/// 请求行的方法与 target；缺失的部分为空串。
pub(crate) fn request_line(head: &str) -> (&str, &str) {
    let mut parts = head.lines().next().unwrap_or("").split_whitespace();
    (parts.next().unwrap_or(""), parts.next().unwrap_or(""))
}

/// 提供单个本地媒体文件。调用方必须先完成鉴权与路径约束，`path` 应是已确认
/// 位于允许根目录内的文件。
pub(crate) async fn serve_file(
    socket: &mut TcpStream,
    head_only: bool,
    path: &Path,
    range: Option<&str>,
) -> Result<(), String> {
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return write_simple_response(socket, 404, "Not Found", "").await;
    }
    let total = metadata.len();
    let (status, start, end) = match parse_range(range, total) {
        Ok(value) => value,
        Err(_) => {
            let response = format!(
                "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{total}\r\nContent-Length: 0\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n"
            );
            socket
                .write_all(response.as_bytes())
                .await
                .map_err(|error| error.to_string())?;
            return Ok(());
        }
    };
    let length = if total == 0 {
        0
    } else {
        end.saturating_sub(start).saturating_add(1)
    };
    let content_type = content_type(path);
    let header = if status == 206 {
        format!(
            "HTTP/1.1 206 Partial Content\r\nContent-Type: {content_type}\r\nContent-Length: {length}\r\nContent-Range: bytes {start}-{end}/{total}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n"
        )
    } else {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {length}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n"
        )
    };
    socket
        .write_all(header.as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    if head_only || length == 0 {
        return Ok(());
    }
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|error| error.to_string())?;
    file.seek(std::io::SeekFrom::Start(start))
        .await
        .map_err(|error| error.to_string())?;
    let mut remaining = length;
    let mut chunk = vec![0_u8; 64 * 1024];
    while remaining > 0 {
        let capacity = chunk.len().min(remaining as usize);
        let read = file
            .read(&mut chunk[..capacity])
            .await
            .map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        socket
            .write_all(&chunk[..read])
            .await
            .map_err(|error| error.to_string())?;
        remaining -= read as u64;
    }
    Ok(())
}

pub(crate) fn parse_range(value: Option<&str>, total: u64) -> Result<(u16, u64, u64), String> {
    let Some(value) = value else {
        return Ok((200, 0, total.saturating_sub(1)));
    };
    if total == 0 {
        return Err("range not satisfiable".into());
    }
    let Some(value) = value.strip_prefix("bytes=") else {
        return Ok((200, 0, total - 1));
    };
    if value.contains(',') {
        return Err("multiple ranges are not supported".into());
    }
    let Some((start, end)) = value.split_once('-') else {
        return Ok((200, 0, total - 1));
    };
    let start = start.trim();
    let end = end.trim();
    let (start, end) = if start.is_empty() {
        let suffix = end
            .parse::<u64>()
            .map_err(|_| "invalid range".to_string())?;
        if suffix == 0 {
            return Err("range not satisfiable".into());
        }
        (total.saturating_sub(suffix.min(total)), total - 1)
    } else {
        let start = start
            .parse::<u64>()
            .map_err(|_| "invalid range".to_string())?;
        let end = if end.is_empty() {
            total - 1
        } else {
            end.parse::<u64>()
                .map_err(|_| "invalid range".to_string())?
                .min(total - 1)
        };
        (start, end)
    };
    if start >= total || start > end {
        return Err("range not satisfiable".into());
    }
    Ok((206, start, end))
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "m3u8" => "application/vnd.apple.mpegurl",
        "ts" => "video/mp2t",
        "flv" => "video/x-flv",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "m4s" => "video/iso.segment",
        "aac" => "audio/aac",
        "key" => "application/octet-stream",
        _ => "application/octet-stream",
    }
}

pub(crate) async fn write_simple_response(
    socket: &mut TcpStream,
    status: u16,
    reason: &str,
    body: &str,
) -> Result<(), String> {
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    socket
        .write_all(response.as_bytes())
        .await
        .map_err(|error| error.to_string())
}

/// 只读服务的方法前置：OPTIONS 回 CORS 预检（204），非 GET/HEAD 回 405。
/// 返回 true 表示该请求已应答完毕，调用方直接结束这条连接。
pub(crate) async fn answer_method_preflight<S: AsyncWrite + Unpin>(
    socket: &mut S,
    method: &str,
) -> std::io::Result<bool> {
    if method == "OPTIONS" {
        socket
            .write_all(
                concat!(
                    "HTTP/1.1 204 No Content\r\n",
                    "Access-Control-Allow-Origin: *\r\n",
                    "Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n",
                    "Access-Control-Allow-Headers: *\r\n",
                    "Connection: close\r\n\r\n"
                )
                .as_bytes(),
            )
            .await?;
        return Ok(true);
    }
    if method != "GET" && method != "HEAD" {
        let _ = socket
            .write_all(b"HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n")
            .await;
        return Ok(true);
    }
    Ok(false)
}

/// 逐行改写 HLS 清单中的资源地址：注释/标签行只改 `URI="…"` 属性，其余非空行
/// 整行视为 URI。`map` 接收去掉首尾空白的原始地址，返回 `None` 时原样保留。
/// 换行统一为 `\n`，保留原清单的末尾换行与行内首尾空白。
pub(crate) fn rewrite_hls_uris(
    manifest: &str,
    mut map: impl FnMut(&str) -> Option<String>,
) -> String {
    let mut output = manifest
        .lines()
        .map(|line| {
            if line.trim_start().starts_with('#') {
                rewrite_tag_uris(line, &mut map)
            } else {
                rewrite_uri_line(line, &mut map)
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    if manifest.ends_with('\n') {
        output.push('\n');
    }
    output
}

fn rewrite_uri_line(line: &str, map: &mut impl FnMut(&str) -> Option<String>) -> String {
    let candidate = line.trim();
    if candidate.is_empty() {
        return line.to_string();
    }
    let leading_len = line.len() - line.trim_start().len();
    let trailing_len = line.len() - line.trim_end().len();
    match map(candidate) {
        Some(local) => format!(
            "{}{local}{}",
            &line[..leading_len],
            &line[line.len() - trailing_len..]
        ),
        None => line.to_string(),
    }
}

fn rewrite_tag_uris(line: &str, map: &mut impl FnMut(&str) -> Option<String>) -> String {
    let mut output = String::with_capacity(line.len());
    let mut remainder = line;
    while let Some(uri_start) = remainder.find("URI=\"") {
        let value_start = uri_start + "URI=\"".len();
        let Some(value_end) = remainder[value_start..].find('"') else {
            break;
        };
        let value_end = value_start + value_end;
        output.push_str(&remainder[..value_start]);
        let original = &remainder[value_start..value_end];
        output.push_str(&map(original).unwrap_or_else(|| original.to_string()));
        remainder = &remainder[value_end..];
    }
    output.push_str(remainder);
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn request_head_spans_multiple_reads_and_stops_at_the_blank_line() {
        let (mut client, mut server) = tokio::io::duplex(64);
        tokio::spawn(async move {
            client
                .write_all(b"GET /a HTTP/1.1\r\nHost: x")
                .await
                .unwrap();
            client.write_all(b"\r\n\r\n").await.unwrap();
        });
        let head = read_request_head(&mut server, 8192).await.unwrap().unwrap();
        let text = String::from_utf8(head).unwrap();
        assert_eq!(request_line(&text), ("GET", "/a"));
    }

    #[tokio::test]
    async fn oversized_or_truncated_heads_are_rejected_and_silence_is_empty() {
        let (mut client, mut server) = tokio::io::duplex(64);
        tokio::spawn(async move {
            client.write_all(&[b'a'; 40]).await.unwrap();
        });
        assert!(read_request_head(&mut server, 16).await.unwrap().is_none());

        let (client, mut server) = tokio::io::duplex(64);
        drop(client);
        assert_eq!(
            read_request_head(&mut server, 16).await.unwrap(),
            Some(Vec::new())
        );

        let (mut client, mut server) = tokio::io::duplex(64);
        tokio::spawn(async move {
            client.write_all(b"GET / HTTP/1.1\r\n").await.unwrap();
        });
        assert!(
            read_request_head(&mut server, 8192)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn hls_rewrite_maps_uri_lines_and_attributes_but_keeps_layout() {
        let manifest =
            "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"k.bin\"\n  seg.ts \n\n#EXT-X-ENDLIST\n";
        let rewritten = rewrite_hls_uris(manifest, |uri| Some(format!("L({uri})")));
        assert_eq!(
            rewritten,
            "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"L(k.bin)\"\n  L(seg.ts) \n\n#EXT-X-ENDLIST\n"
        );
        assert_eq!(rewrite_hls_uris("a.ts", |_| None), "a.ts");
    }

    #[test]
    fn range_boundaries_cover_head_suffix_and_unsatisfiable_requests() {
        for (header, size, expected) in [
            (Some("bytes=10-20"), 100, Some((206, 10, 20))),
            (Some("bytes=90-"), 100, Some((206, 90, 99))),
            (Some("bytes=-10"), 100, Some((206, 90, 99))),
            (None, 0, Some((200, 0, 0))),
            (Some("bytes=0-0"), 0, None),
            (Some("bytes=0-1,4-5"), 100, None),
        ] {
            assert_eq!(parse_range(header, size).ok(), expected, "{header:?}");
        }
    }

    #[test]
    fn media_content_types_keep_hls_and_encryption_key_mappings() {
        for (name, expected) in [
            ("index.m3u8", "application/vnd.apple.mpegurl"),
            ("segment.ts", "video/mp2t"),
            ("video.mp4", "video/mp4"),
            ("track.m4s", "video/iso.segment"),
            ("enc.key", "application/octet-stream"),
        ] {
            assert_eq!(content_type(Path::new(name)), expected, "{name}");
        }
    }
}
