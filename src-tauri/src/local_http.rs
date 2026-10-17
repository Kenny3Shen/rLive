//! 本机 / 局域网小型 HTTP 服务的公共部分。
//!
//! 流代理、图片代理、录制回放、DLNA 中继与局域网同步各自只处理一次请求就关闭连接
//! （`Connection: close`），因此只需要读请求头、按方法分流、按需改写 HLS 清单；
//! 响应头的字段集合因服务而异，留在各自模块。

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

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
}
