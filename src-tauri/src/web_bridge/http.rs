//! The bridge's HTTP surface: static assets, command dispatch and the event
//! stream.
//!
//! Hand-written over `tokio::net::TcpListener` for the same reason as
//! `stream_proxy` and `lan_sync`: the responses are few and fixed, so a
//! framework would add a dependency without removing any of the work here.

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Listener};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};

use super::{MAX_REQUEST_BYTES, dispatch};

/// A browser that opens a page and walks away should not hold a task forever.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// Danmaku arrives in batches at up to 20fps. If a browser cannot keep up we
/// drop batches rather than grow this queue without bound, matching the native
/// path where the frontend also sheds excess chat.
const EVENT_QUEUE: usize = 64;

/// Keeps proxies and browsers from treating an idle stream as a dead one.
const SSE_KEEPALIVE: Duration = Duration::from_secs(15);

pub async fn serve(
    listener: TcpListener,
    app: AppHandle,
    token: Option<String>,
    mut shutdown: watch::Receiver<bool>,
) {
    let token = Arc::new(token);
    loop {
        let accepted = tokio::select! {
            _ = shutdown.changed() => return,
            accepted = listener.accept() => accepted,
        };
        let Ok((stream, _peer)) = accepted else {
            // A single failed accept is not fatal (EMFILE, a client that
            // vanished mid-handshake); keep serving.
            continue;
        };
        let app = app.clone();
        let token = token.clone();
        let shutdown = shutdown.clone();
        tauri::async_runtime::spawn(async move {
            handle_connection(stream, app, token, shutdown).await;
        });
    }
}

async fn handle_connection(
    mut stream: TcpStream,
    app: AppHandle,
    token: Arc<Option<String>>,
    shutdown: watch::Receiver<bool>,
) {
    let request = match tokio::time::timeout(REQUEST_TIMEOUT, read_request(&mut stream)).await {
        Ok(Ok(request)) => request,
        _ => {
            let _ = write_json(&mut stream, 400, "Bad Request", "{\"error\":\"bad request\"}").await;
            return;
        }
    };

    // Preflight has to answer before the auth check: the browser sends it
    // without the `Authorization` header by design.
    if request.method == "OPTIONS" {
        let _ = write_preflight(&mut stream).await;
        return;
    }

    let path = request.path.split(['?', '#']).next().unwrap_or_default();

    // Only `/api/` is token-guarded. The static bundle stays readable so the
    // first navigation can load the shell and hand its `?token=` to the JS that
    // will then authorize every data request. What this exposes is the same
    // public frontend code shipped in the app, never account or database state:
    // an unauthorized page loads and then fails every command with 401.
    if let Some(expected) = token.as_deref()
        && path.starts_with("/api/")
        && !request
            .token
            .as_deref()
            .is_some_and(|candidate| constant_time_eq(candidate, expected))
    {
        let _ = write_json(
            &mut stream,
            401,
            "Unauthorized",
            "{\"error\":{\"code\":\"web_bridge_unauthorized\",\"message\":\"缺少或错误的访问令牌\"}}",
        )
        .await;
        return;
    }

    match (request.method.as_str(), path) {
        ("GET", "/api/events") => serve_events(stream, app, shutdown).await,
        ("GET", "/api/status") => {
            let body = serde_json::json!({
                "platform": "web",
                "nativeOnlyCommands": dispatch::NATIVE_ONLY_COMMANDS,
            })
            .to_string();
            let _ = write_json(&mut stream, 200, "OK", &body).await;
        }
        ("POST", _) if path.starts_with("/api/invoke/") => {
            serve_invoke(stream, app, path, request.body).await;
        }
        ("GET", _) | ("HEAD", _) => serve_asset(stream, app, path, request.method == "HEAD").await,
        _ => {
            let _ = write_json(
                &mut stream,
                405,
                "Method Not Allowed",
                "{\"error\":\"method not allowed\"}",
            )
            .await;
        }
    }
}

async fn serve_invoke(mut stream: TcpStream, app: AppHandle, path: &str, body: Vec<u8>) {
    // `strip_prefix`, not `trim_start_matches`: the latter removes the pattern
    // repeatedly, so it would accept `/api/invoke//api/invoke/site_list`. The
    // dispatch table is an exact-match allowlist either way, but the command name
    // should be exactly what the path carries.
    let command = path.strip_prefix("/api/invoke/").unwrap_or_default();
    let args: serde_json::Value = if body.is_empty() {
        serde_json::Value::Object(Default::default())
    } else {
        match serde_json::from_slice(&body) {
            Ok(args) => args,
            Err(error) => {
                let body = error_body(&crate::error::AppError::new(
                    "web_bridge_bad_payload",
                    format!("请求体不是合法 JSON: {error}"),
                ));
                let _ = write_json(&mut stream, 400, "Bad Request", &body).await;
                return;
            }
        }
    };

    // Errors travel as a 200 with an `error` envelope so the frontend's single
    // transport layer decodes command failures the same way `invoke` rejects
    // them, instead of having to distinguish HTTP from application failures.
    let body = match dispatch::invoke(&app, command, &args).await {
        Ok(value) => serde_json::json!({ "ok": value }).to_string(),
        Err(error) => error_body(&error),
    };
    let _ = write_json(&mut stream, 200, "OK", &body).await;
}

fn error_body(error: &crate::error::AppError) -> String {
    serde_json::json!({ "error": error }).to_string()
}

/// Bridges the `danmaku-batch` Tauri event onto Server-Sent Events.
///
/// The payload is forwarded verbatim: it is already the JSON the frontend's
/// native listener receives, so the browser path parses an identical envelope.
async fn serve_events(mut stream: TcpStream, app: AppHandle, mut shutdown: watch::Receiver<bool>) {
    let header = "HTTP/1.1 200 OK\r\n\
         Content-Type: text/event-stream; charset=utf-8\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n\
         X-Accel-Buffering: no\r\n"
        .to_owned()
        + CORS_HEADERS
        + "\r\n";
    if stream.write_all(header.as_bytes()).await.is_err() {
        return;
    }

    let (tx, mut rx) = mpsc::channel::<String>(EVENT_QUEUE);
    let listener = app.listen("danmaku-batch", move |event| {
        // `try_send` on purpose: this callback runs on Tauri's event thread and
        // must never block the danmaku pipeline waiting for a slow browser.
        let _ = tx.try_send(event.payload().to_owned());
    });

    loop {
        let payload = tokio::select! {
            _ = shutdown.changed() => break,
            payload = rx.recv() => match payload {
                Some(payload) => Some(payload),
                None => break,
            },
            _ = tokio::time::sleep(SSE_KEEPALIVE) => None,
        };

        let frame = match payload {
            Some(payload) => format!("event: danmaku-batch\n{}\n", sse_data_lines(&payload)),
            // A comment line is a no-op event that still proves liveness.
            None => ": keepalive\n\n".to_owned(),
        };
        if stream.write_all(frame.as_bytes()).await.is_err() {
            break;
        }
    }

    app.unlisten(listener);
    let _ = stream.shutdown().await;
}

async fn serve_asset(mut stream: TcpStream, app: AppHandle, path: &str, head_only: bool) {
    let resolver = app.asset_resolver();
    let candidate = if path == "/" || path.is_empty() {
        "index.html".to_owned()
    } else {
        path.trim_start_matches('/').to_owned()
    };

    // The frontend is a SPA with client-side routes such as `/iptv/play`, so an
    // unknown path that is not an asset request falls back to the shell.
    let asset = resolver
        .get(candidate.clone())
        .or_else(|| resolver.get(format!("{candidate}/index.html")))
        .or_else(|| {
            if candidate.contains('.') {
                None
            } else {
                resolver.get("index.html".to_owned())
            }
        });

    let Some(asset) = asset else {
        let _ = write_json(&mut stream, 404, "Not Found", "{\"error\":\"not found\"}").await;
        return;
    };

    // Hashed bundle filenames are immutable; everything else must be revalidated
    // so a rebuilt frontend is picked up without a manual cache clear.
    let cache_control = if candidate.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let header = format!(
        "HTTP/1.1 200 OK\r\n\
         Content-Type: {}\r\n\
         Content-Length: {}\r\n\
         Cache-Control: {cache_control}\r\n\
         Connection: close\r\n{CORS_HEADERS}\r\n",
        asset.mime_type,
        asset.bytes.len()
    );
    if stream.write_all(header.as_bytes()).await.is_err() {
        return;
    }
    if !head_only {
        let _ = stream.write_all(&asset.bytes).await;
    }
    let _ = stream.shutdown().await;
}

/// Same-origin is the normal case (the bundle is served from this listener), but
/// a dev server on another port also has to reach the API.
const CORS_HEADERS: &str = "Access-Control-Allow-Origin: *\r\n\
     Access-Control-Allow-Headers: content-type, authorization\r\n\
     Access-Control-Allow-Methods: GET, POST, HEAD, OPTIONS\r\n";

struct Request {
    method: String,
    path: String,
    token: Option<String>,
    body: Vec<u8>,
}

async fn read_request(stream: &mut TcpStream) -> std::io::Result<Request> {
    let mut buffer = Vec::with_capacity(2048);
    let head_end = loop {
        if let Some(index) = find_head_end(&buffer) {
            break index;
        }
        if buffer.len() >= MAX_REQUEST_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "request headers exceed the size limit",
            ));
        }
        let mut chunk = [0u8; 2048];
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "incomplete HTTP request",
            ));
        }
        buffer.extend_from_slice(&chunk[..read]);
    };

    let head = std::str::from_utf8(&buffer[..head_end]).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "request head is not UTF-8")
    })?;
    let mut lines = head.split("\r\n");
    let mut request_line = lines
        .next()
        .ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, "missing request line")
        })?
        .split_ascii_whitespace();
    let method = request_line.next().unwrap_or_default().to_ascii_uppercase();
    let path = request_line.next().unwrap_or_default().to_owned();
    if method.is_empty() || path.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "invalid request line",
        ));
    }

    let headers: Vec<(&str, &str)> = lines
        .filter_map(|line| {
            let (name, value) = line.split_once(':')?;
            Some((name.trim(), value.trim()))
        })
        .collect();
    let header = |name: &str| {
        headers
            .iter()
            .find(|(candidate, _)| candidate.eq_ignore_ascii_case(name))
            .map(|(_, value)| *value)
    };

    // EventSource cannot set headers, so the SSE endpoint also accepts the token
    // as a query parameter.
    let token = header("authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::to_owned)
        .or_else(|| query_param(&path, "token"));

    let content_length: usize = header("content-length")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    if content_length > MAX_REQUEST_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "request body exceeds the size limit",
        ));
    }

    let mut body = buffer.split_off(head_end + 4);
    while body.len() < content_length {
        let mut chunk = [0u8; 8192];
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(content_length);

    Ok(Request {
        method,
        path,
        token,
        body,
    })
}

/// Renders a payload as SSE `data:` lines.
///
/// `app.emit` produces compact JSON, so in practice this is a single line. The
/// split is still required rather than cosmetic: SSE treats a bare newline as a
/// field separator, so one literal newline in the payload would silently break
/// the frame and every batch after it. Encoding the general case here means the
/// browser path cannot be broken by a change on the emit side.
fn sse_data_lines(payload: &str) -> String {
    let mut out = String::with_capacity(payload.len() + 8);
    for line in payload.split('\n') {
        out.push_str("data: ");
        out.push_str(line.strip_suffix('\r').unwrap_or(line));
        out.push('\n');
    }
    out
}

fn find_head_end(buffer: &[u8]) -> Option<usize> {
    buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
}

fn query_param(path: &str, name: &str) -> Option<String> {
    let raw = path
        .split_once('?')?
        .1
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value)?;
    // The frontend builds this URL with `encodeURIComponent`, so the value has
    // to be decoded before it is compared against the token. Today's tokens are
    // hex and survive encoding unchanged, but comparing the raw form would break
    // silently the moment a token contains a reserved character.
    Some(percent_decode(raw))
}

/// Minimal `%XX` and `+` decoding for query values.  Invalid escapes are kept
/// verbatim rather than dropped, so a malformed token fails the comparison
/// instead of accidentally matching a shorter one.
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let hex = &value[index + 1..index + 3];
                match u8::from_str_radix(hex, 16) {
                    Ok(decoded) => {
                        out.push(decoded);
                        index += 3;
                    }
                    Err(_) => {
                        out.push(b'%');
                        index += 1;
                    }
                }
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

async fn write_json(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    body: &str,
) -> std::io::Result<()> {
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: application/json; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n{CORS_HEADERS}\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes()).await?;
    stream.write_all(body.as_bytes()).await?;
    stream.shutdown().await
}

async fn write_preflight(stream: &mut TcpStream) -> std::io::Result<()> {
    let header = format!(
        "HTTP/1.1 204 No Content\r\n\
         Content-Length: 0\r\n\
         Access-Control-Max-Age: 600\r\n\
         Connection: close\r\n{CORS_HEADERS}\r\n"
    );
    stream.write_all(header.as_bytes()).await?;
    stream.shutdown().await
}

fn constant_time_eq(candidate: &str, expected: &str) -> bool {
    let candidate = candidate.as_bytes();
    let expected = expected.as_bytes();
    if candidate.len() != expected.len() {
        return false;
    }
    let mut diff = 0u8;
    for (left, right) in candidate.iter().zip(expected) {
        diff |= left ^ right;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reads_a_post_body_that_arrives_after_the_headers() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(addr).await.unwrap();
            stream
                .write_all(
                    b"POST /api/invoke/get_settings HTTP/1.1\r\n\
                      Authorization: Bearer secret\r\n\
                      Content-Length: 13\r\n\r\n",
                )
                .await
                .unwrap();
            // Deliberately a second write: the reader must not assume the body
            // shares the header packet.
            stream.write_all(b"{\"a\":\"body\"}\n").await.unwrap();
            stream
        });
        let (mut server, _) = listener.accept().await.unwrap();
        let request = read_request(&mut server).await.unwrap();
        let _client = client.await.unwrap();

        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/api/invoke/get_settings");
        assert_eq!(request.token.as_deref(), Some("secret"));
        assert_eq!(request.body, b"{\"a\":\"body\"}\n");
    }

    #[test]
    fn a_query_token_is_accepted_for_endpoints_that_cannot_send_headers() {
        assert_eq!(
            query_param("/api/events?token=abc123", "token").as_deref(),
            Some("abc123")
        );
        assert_eq!(query_param("/api/events", "token"), None);
        // A prefix must not satisfy the lookup.
        assert_eq!(query_param("/api/events?tokenish=abc", "token"), None);
        assert_eq!(
            query_param("/api/events?x=1&token=abc", "token").as_deref(),
            Some("abc")
        );
        // The real token shape: 64 hex chars, unchanged by encoding.
        let hex = "0123456789abcdef".repeat(4);
        assert_eq!(
            query_param(&format!("/api/events?token={hex}"), "token").as_deref(),
            Some(hex.as_str())
        );
    }

    #[test]
    fn a_query_token_is_percent_decoded_to_match_the_frontends_encoding() {
        // `withBridgeToken` builds this URL with `encodeURIComponent`, so the
        // value has to be decoded before the constant-time comparison.
        assert_eq!(
            query_param("/api/events?token=a%2Bb", "token").as_deref(),
            Some("a+b")
        );
        assert_eq!(percent_decode("%2B"), "+");
        assert_eq!(percent_decode("%E4%B8%AD"), "中");
        assert_eq!(percent_decode("a+b"), "a b");
        // Malformed escapes stay verbatim so a broken token fails the comparison
        // rather than matching a truncated value.
        assert_eq!(percent_decode("abc%"), "abc%");
        assert_eq!(percent_decode("abc%2"), "abc%2");
        assert_eq!(percent_decode("%zz"), "%zz");
    }

    #[test]
    fn sse_frames_survive_a_payload_that_contains_newlines() {
        // The normal case: compact JSON from `app.emit` is one line.
        assert_eq!(
            sse_data_lines(r#"{"connection_epoch":3,"events":[]}"#),
            "data: {\"connection_epoch\":3,\"events\":[]}\n"
        );
        // A literal newline must become a second `data:` line, which the browser
        // rejoins, instead of terminating the field early.
        assert_eq!(sse_data_lines("{\"a\":1}\n{\"b\":2}"), "data: {\"a\":1}\ndata: {\"b\":2}\n");
        assert_eq!(sse_data_lines("a\r\nb"), "data: a\ndata: b\n");
        assert_eq!(sse_data_lines(""), "data: \n");
    }

    #[test]
    fn token_comparison_rejects_mismatches_of_every_shape() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "abcd"));
        assert!(!constant_time_eq("", "abc"));
    }
}
