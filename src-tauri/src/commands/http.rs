//! 前端字幕翻译与版本检查共用的受限 HTTP IPC。
//!
//! 不使用 plugin-http：其 fetch 无法保证「关闭」时忽略进程/系统代理。
//! 白名单沿用原 capability；初始请求和每次重定向均检查，不开放通用网络访问。

use std::time::Duration;

use reqwest::{Client, Method, Url, header};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

const REQUEST_LIMIT: usize = 1024 * 1024;
const RESPONSE_LIMIT: usize = 8 * 1024 * 1024;
const HEADER_LIMIT: usize = 32 * 1024;
const REDIRECT_LIMIT: usize = 5;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const RELEASE_PATH: &str = "/repos/Kenny3Shen/rLive/releases/latest";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HttpFetchRequest {
    url: String,
    #[serde(default = "default_method")]
    method: String,
    #[serde(default)]
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
}

fn default_method() -> String {
    "GET".into()
}

#[derive(Debug, Serialize)]
pub struct HttpFetchResponse {
    status: u16,
    status_text: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    url: String,
}

#[tauri::command]
pub async fn http_fetch(
    state: State<'_, AppState>,
    request: HttpFetchRequest,
) -> AppResult<HttpFetchResponse> {
    let route = {
        let conn = state
            .db
            .lock()
            .map_err(|_| AppError::new("db_lock", "数据库锁不可用"))?;
        crate::settings::get(&conn)?.proxy_route()
    };
    let client = crate::http_client::build_no_redirect_client(&route)?;
    // 总预算包括所有重定向与响应读取，不能让每一跳重新获得20秒。
    tokio::time::timeout(REQUEST_TIMEOUT, execute(request, client, validate_url))
        .await
        .map_err(|_| AppError::new("http_timeout", "网络请求超时").retryable())?
}

fn validate_url(url: &Url) -> AppResult<()> {
    let allowed = url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && match url.host_str() {
            Some("translate.google.com") => true,
            Some("api.github.com") => url.path() == RELEASE_PATH && url.query().is_none(),
            _ => false,
        };
    if allowed {
        Ok(())
    } else {
        Err(AppError::new(
            "http_url_denied",
            "该地址不在前端 HTTP 请求白名单中",
        ))
    }
}

fn request_error(error: reqwest::Error) -> AppError {
    // 翻译内容在 query/body 内，不把原始 URL 或凭据带回日志/界面。
    if error.is_timeout() {
        AppError::new("http_timeout", "网络请求超时").retryable()
    } else {
        AppError::new("http_request", "网络请求失败，请检查连接与代理设置").retryable()
    }
}

async fn execute(
    request: HttpFetchRequest,
    client: Client,
    check_url: fn(&Url) -> AppResult<()>,
) -> AppResult<HttpFetchResponse> {
    let mut url = Url::parse(&request.url)
        .map_err(|_| AppError::new("http_url_invalid", "HTTP 请求地址无效"))?;
    check_url(&url)?;
    let mut method = match request.method.as_str() {
        "GET" => Method::GET,
        "POST" => Method::POST,
        _ => {
            return Err(AppError::new(
                "http_method_denied",
                "仅支持 GET 与 POST 请求",
            ));
        }
    };
    let mut body = request.body;
    if body.as_ref().is_some_and(|body| body.len() > REQUEST_LIMIT) {
        return Err(AppError::new(
            "http_request_too_large",
            "请求内容超过 1 MiB 限制",
        ));
    }
    if method == Method::GET && body.is_some() {
        return Err(AppError::new("http_body_invalid", "GET 请求不能携带 body"));
    }
    if request.headers.len() > 128
        || request
            .headers
            .iter()
            .map(|(key, value)| key.len() + value.len())
            .sum::<usize>()
            > HEADER_LIMIT
    {
        return Err(AppError::new("http_headers_invalid", "请求头过大"));
    }
    let mut headers = header::HeaderMap::new();
    for (name, value) in request.headers {
        let name = header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| AppError::new("http_headers_invalid", "请求头名称无效"))?;
        if matches!(
            name.as_str(),
            "host"
                | "connection"
                | "content-length"
                | "transfer-encoding"
                | "proxy-authorization"
                | "proxy-connection"
                | "upgrade"
                | "trailer"
                | "te"
        ) {
            return Err(AppError::new(
                "http_headers_invalid",
                "不允许覆盖传输或代理请求头",
            ));
        }
        let value = header::HeaderValue::from_str(&value)
            .map_err(|_| AppError::new("http_headers_invalid", "请求头内容无效"))?;
        headers.append(name, value);
    }

    for redirects in 0..=REDIRECT_LIMIT {
        let mut builder = client
            .request(method.clone(), url.clone())
            .headers(headers.clone());
        if let Some(body) = &body {
            builder = builder.body(body.clone());
        }
        let mut response = builder.send().await.map_err(request_error)?;
        let status = response.status();
        if matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308)
            && let Some(location) = response.headers().get(header::LOCATION)
        {
            if redirects == REDIRECT_LIMIT {
                return Err(AppError::new("http_redirect_limit", "HTTP 重定向次数过多"));
            }
            let next = location
                .to_str()
                .ok()
                .and_then(|location| url.join(location).ok())
                .ok_or_else(|| AppError::new("http_redirect_invalid", "HTTP 重定向地址无效"))?;
            check_url(&next)?;
            if url.origin() != next.origin() {
                headers.remove(header::AUTHORIZATION);
                headers.remove(header::COOKIE);
                headers.remove(header::REFERER);
            }
            if status.as_u16() == 303
                || (matches!(status.as_u16(), 301 | 302) && method == Method::POST)
            {
                method = Method::GET;
                body = None;
                headers.remove(header::CONTENT_TYPE);
                headers.remove(header::CONTENT_ENCODING);
            }
            url = next;
            continue;
        }
        if response
            .content_length()
            .is_some_and(|len| len > RESPONSE_LIMIT as u64)
        {
            return Err(AppError::new(
                "http_response_too_large",
                "响应内容超过 8 MiB 限制",
            ));
        }
        let headers = response
            .headers()
            .iter()
            .map(|(key, value)| {
                (
                    key.to_string(),
                    String::from_utf8_lossy(value.as_bytes()).into_owned(),
                )
            })
            .collect();
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(request_error)? {
            if chunk.len() > RESPONSE_LIMIT - body.len() {
                return Err(AppError::new(
                    "http_response_too_large",
                    "响应内容超过 8 MiB 限制",
                ));
            }
            body.extend_from_slice(&chunk);
        }
        return Ok(HttpFetchResponse {
            status: status.as_u16(),
            status_text: status.canonical_reason().unwrap_or("").to_owned(),
            headers,
            body,
            url: url.to_string(),
        });
    }
    unreachable!("重定向上限在发起下一跳前检查")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn whitelist_checks_scheme_port_host_path_and_credentials() {
        for url in [
            "https://translate.google.com/translate_a/single?q=hello",
            "https://translate.google.com:443/path",
            "https://api.github.com/repos/Kenny3Shen/rLive/releases/latest",
        ] {
            assert!(validate_url(&Url::parse(url).unwrap()).is_ok(), "{url}");
        }
        for url in [
            "http://translate.google.com/",
            "https://translate.google.com:8443/",
            "https://translate.google.com.evil/",
            "https://user:secret@translate.google.com/",
            "https://api.github.com/repos/Kenny3Shen/rLive/releases/latest?x=1",
            "https://api.github.com/repos/other/repo/releases/latest",
            "https://127.0.0.1/",
            "https://translate.google.com@evil.test/",
        ] {
            assert!(validate_url(&Url::parse(url).unwrap()).is_err(), "{url}");
        }
    }

    fn loopback_only(url: &Url) -> AppResult<()> {
        if url.host_str() == Some("127.0.0.1") {
            Ok(())
        } else {
            validate_url(url)
        }
    }

    async fn server(response: Vec<u8>) -> (String, tokio::task::JoinHandle<Vec<u8>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut received = Vec::new();
            loop {
                let mut chunk = [0; 8192];
                let n = stream.read(&mut chunk).await.unwrap();
                if n == 0 {
                    break;
                }
                received.extend_from_slice(&chunk[..n]);
                if let Some(end) = received.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&received[..end]).to_ascii_lowercase();
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.strip_prefix("content-length:")
                                .and_then(|s| s.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if received.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let _ = stream.write_all(&response).await;
            received
        });
        (url, task)
    }

    fn input(url: String) -> HttpFetchRequest {
        HttpFetchRequest {
            url,
            method: "GET".into(),
            headers: vec![],
            body: None,
        }
    }

    #[tokio::test]
    async fn preserves_post_bytes_and_http_error_status() {
        let (url, task) = server(b"HTTP/1.1 429 Too Many Requests\r\nContent-Length: 3\r\nX-Test: yes\r\nConnection: close\r\n\r\n\x00\xff!".to_vec()).await;
        let mut request = input(url);
        request.method = "POST".into();
        request.body = Some(vec![0, 255, b'!']);
        let response = execute(
            request,
            crate::http_client::build_no_redirect_client(&crate::proxy::ProxyRoute::Direct)
                .unwrap(),
            loopback_only,
        )
        .await
        .unwrap();
        assert_eq!(response.status, 429);
        assert_eq!(response.body, [0, 255, b'!']);
        assert!(response.headers.contains(&("x-test".into(), "yes".into())));
        let received = task.await.unwrap();
        assert!(received.starts_with(b"POST / HTTP/1.1"));
        assert!(received.ends_with(&[0, 255, b'!']));
    }

    #[tokio::test]
    async fn rejects_redirect_before_contacting_an_unlisted_host() {
        let (url, task) = server(b"HTTP/1.1 302 Found\r\nLocation: http://unlisted.invalid/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()).await;
        let error = execute(
            input(url),
            crate::http_client::build_no_redirect_client(&crate::proxy::ProxyRoute::Direct)
                .unwrap(),
            loopback_only,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "http_url_denied");
        task.await.unwrap();
    }

    #[tokio::test]
    async fn redirects_rewrite_posts_and_remove_cross_origin_credentials() {
        for status in [301, 302, 303, 307, 308] {
            let (target, received) =
                server(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n".to_vec()).await;
            let (url, redirect) = server(format!("HTTP/1.1 {status} Redirect\r\nLocation: {target}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_bytes()).await;
            let mut request = input(url);
            request.method = "POST".into();
            request.body = Some(vec![0, 255, b'!']);
            request.headers = vec![
                ("Authorization".into(), "Bearer secret".into()),
                ("Cookie".into(), "session=secret".into()),
                (
                    "Referer".into(),
                    "https://translate.google.com/?q=private".into(),
                ),
                ("Content-Type".into(), "application/octet-stream".into()),
            ];
            let response = execute(
                request,
                crate::http_client::build_no_redirect_client(&crate::proxy::ProxyRoute::Direct)
                    .unwrap(),
                loopback_only,
            )
            .await
            .unwrap();
            assert_eq!(response.status, 204);
            assert_eq!(response.url, target);
            redirect.await.unwrap();
            let bytes = received.await.unwrap();
            let headers = String::from_utf8_lossy(&bytes).to_ascii_lowercase();
            for header in ["authorization:", "cookie:", "referer:"] {
                assert!(!headers.contains(header), "status={status}: {headers}");
            }
            if matches!(status, 307 | 308) {
                assert!(bytes.starts_with(b"POST / HTTP/1.1"));
                assert!(bytes.ends_with(&[0, 255, b'!']));
            } else {
                assert!(bytes.starts_with(b"GET / HTTP/1.1"));
                assert!(!headers.contains("content-type:"));
                assert!(bytes.ends_with(b"\r\n\r\n"));
            }
        }
    }

    #[tokio::test]
    async fn refuses_excessive_request_bytes_methods_and_transport_headers() {
        for (request, expected) in [
            (
                HttpFetchRequest {
                    method: "DELETE".into(),
                    ..input("https://translate.google.com/".into())
                },
                "http_method_denied",
            ),
            (
                HttpFetchRequest {
                    method: "POST".into(),
                    body: Some(vec![0; REQUEST_LIMIT + 1]),
                    ..input("https://translate.google.com/".into())
                },
                "http_request_too_large",
            ),
            (
                HttpFetchRequest {
                    headers: vec![("Host".into(), "evil.test".into())],
                    ..input("https://translate.google.com/".into())
                },
                "http_headers_invalid",
            ),
        ] {
            let error = execute(
                request,
                crate::http_client::build_no_redirect_client(&crate::proxy::ProxyRoute::Direct)
                    .unwrap(),
                validate_url,
            )
            .await
            .unwrap_err();
            assert_eq!(error.code, expected);
        }
    }

    #[tokio::test]
    async fn limits_response_bytes_even_without_content_length() {
        let mut bytes = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_vec();
        bytes.resize(bytes.len() + RESPONSE_LIMIT + 1, b'x');
        let (url, task) = server(bytes).await;
        let error = execute(
            input(url),
            crate::http_client::build_no_redirect_client(&crate::proxy::ProxyRoute::Direct)
                .unwrap(),
            loopback_only,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "http_response_too_large");
        task.await.unwrap();
    }
}
