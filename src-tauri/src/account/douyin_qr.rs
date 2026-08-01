//! User-operated Douyin web QR login.
//!
//! The flow talks only to Douyin's web SSO endpoints.  The QR payload is
//! rendered by the client, but the upstream token and the temporary cookie
//! jar remain in this process.  On confirmation, the resulting Cookie is
//! returned to the account command solely so it can be persisted in the local
//! account database.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use reqwest::cookie::{CookieStore, Jar};
use reqwest::header::{ACCEPT, ACCEPT_LANGUAGE, REFERER, USER_AGENT};
use reqwest::{Client, Url};
use serde_json::Value;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::sites::douyin::DEFAULT_USER_AGENT;

const QR_GENERATE_URL: &str = "https://sso.douyin.com/get_qrcode/";
const QR_POLL_URL: &str = "https://sso.douyin.com/check_qrconnect/";
const WEB_ORIGIN: &str = "https://www.douyin.com/";
const SESSION_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_ACTIVE_SESSIONS: usize = 16;
const MAX_REDIRECTS: usize = 8;
const MAX_QR_PAYLOAD_LEN: usize = 8 * 1024;
const MAX_COOKIE_LEN: usize = 16 * 1024;

/// Data needed to render a Douyin login QR code in the client.
pub struct QrLoginStart {
    pub qr_code_url: String,
    /// Opaque, process-local handle rather than Douyin's real login token.
    pub qr_key: String,
}

/// A QR polling result. Cookie material never crosses the webview boundary.
pub enum QrLoginPoll {
    Pending,
    Scanned,
    Expired,
    Success { cookie: String },
}

#[derive(Clone)]
struct QrSession {
    token: String,
    client: Client,
    jar: Arc<Jar>,
    created_at: Instant,
}

static ACTIVE_SESSIONS: OnceLock<Mutex<HashMap<String, QrSession>>> = OnceLock::new();

fn active_sessions() -> &'static Mutex<HashMap<String, QrSession>> {
    ACTIVE_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Create a QR payload with Douyin's public web SSO API.
pub async fn start(proxy: Option<&str>) -> AppResult<QrLoginStart> {
    let jar = Arc::new(Jar::default());
    let client = build_login_client(Arc::clone(&jar), proxy)?;
    let response = client
        .get(QR_GENERATE_URL)
        .query(&web_sso_params())
        .header(ACCEPT, "application/json, text/plain, */*")
        .header(ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.8")
        .header(REFERER, WEB_ORIGIN)
        .header(USER_AGENT, DEFAULT_USER_AGENT)
        .send()
        .await
        .map_err(|_| qr_network_error("douyin_qr_generate"))?;
    let response = parse_json_response(response, "douyin_qr_generate").await?;
    let (qr_code_url, token) = parse_start_response(&response)?;

    // The QR payload itself must be rendered by the UI, but do not return the
    // SSO token as a separate value.  Keeping it alongside the bootstrap
    // cookie jar makes the poll request work when SSO binds it to that
    // temporary session.
    let qr_key = Uuid::new_v4().simple().to_string();
    let session = QrSession {
        token,
        client,
        jar,
        created_at: Instant::now(),
    };
    insert_session(qr_key.clone(), session)?;

    Ok(QrLoginStart {
        qr_code_url,
        qr_key,
    })
}

/// Poll a previously-started QR login flow.
pub async fn poll(qr_key: &str) -> AppResult<QrLoginPoll> {
    if !is_valid_session_key(qr_key) {
        return Err(
            AppError::new("douyin_qr_invalid_key", "二维码登录凭据无效，请刷新二维码")
                .with_site("douyin"),
        );
    }

    let session = get_session(qr_key)?;
    let mut params = web_sso_params();
    params.push(("token", session.token.clone()));
    let response = session
        .client
        .get(QR_POLL_URL)
        .query(&params)
        .header(ACCEPT, "application/json, text/plain, */*")
        .header(ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.8")
        .header(REFERER, WEB_ORIGIN)
        .header(USER_AGENT, DEFAULT_USER_AGENT)
        .send()
        .await
        .map_err(|_| qr_network_error("douyin_qr_poll"))?;
    let response = parse_json_response(response, "douyin_qr_poll").await?;

    match parse_poll_response(&response)? {
        PollState::Pending => Ok(QrLoginPoll::Pending),
        PollState::Scanned => Ok(QrLoginPoll::Scanned),
        PollState::Expired => {
            remove_session(qr_key)?;
            Ok(QrLoginPoll::Expired)
        }
        PollState::Success { redirect_url } => {
            let cookie = finish_login(&session, &redirect_url).await?;
            remove_session(qr_key)?;
            Ok(QrLoginPoll::Success { cookie })
        }
    }
}

fn web_sso_params() -> Vec<(&'static str, String)> {
    // These are the stable public parameters used by the Douyin web login
    // page. No signature, device id, third-party endpoint, or saved Cookie is
    // sent with either request.
    vec![
        ("service", WEB_ORIGIN.to_string()),
        ("need_logo", "false".to_string()),
        ("need_short_url", "true".to_string()),
        ("device_platform", "web_app".to_string()),
        ("aid", "6383".to_string()),
        ("account_sdk_source", "sso".to_string()),
        ("sdk_version", "2.2.5".to_string()),
        ("language", "zh".to_string()),
    ]
}

fn build_login_client(jar: Arc<Jar>, proxy: Option<&str>) -> AppResult<Client> {
    // Use only the application's explicit proxy setting.  This keeps a QR
    // session from accidentally inheriting an unrelated HTTP(S)_PROXY process
    // variable, while still allowing users whose network requires a proxy to
    // reach Douyin's SSO service.
    let builder = Client::builder()
        .use_native_tls()
        .cookie_provider(jar)
        .no_proxy()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        // A completed QR flow is expected to redirect between Douyin web SSO
        // hosts. Stop rather than follow a redirect outside of Douyin so this
        // temporary session is never used to make an arbitrary request.
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if can_follow_redirect(attempt.url(), attempt.previous().len()) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }));
    crate::http_client::with_proxy(builder, proxy)?
        .build()
        .map_err(|_| {
            AppError::new("douyin_qr_client", "二维码登录网络客户端初始化失败").with_site("douyin")
        })
}

async fn parse_json_response(response: reqwest::Response, code: &str) -> AppResult<Value> {
    let status = response.status();
    if !status.is_success() {
        return Err(
            AppError::new(code, "抖音二维码登录服务暂不可用，请稍后重试")
                .with_site("douyin")
                .retryable(),
        );
    }
    let body = response.text().await.map_err(|_| {
        AppError::new(code, "抖音二维码登录服务返回了无法读取的数据")
            .with_site("douyin")
            .retryable()
    })?;
    parse_json_body(&body, code)
}

fn parse_json_body(body: &str, code: &str) -> AppResult<Value> {
    serde_json::from_str(body).map_err(|_| {
        // The public SSO endpoints can return a 200 HTML page when the edge
        // requires an interactive browser verification.  The native client
        // must not try to imitate or solve that challenge; provide a useful
        // recovery path instead of reporting an opaque JSON parse failure.
        let message = if looks_like_html_document(body) {
            "抖音当前要求在浏览器完成访问验证，应用内无法取得二维码。请检查应用代理后重试，或使用手动 Cookie 登录"
        } else {
            "抖音二维码登录服务返回了无法识别的数据"
        };
        AppError::new(code, message).with_site("douyin").retryable()
    })
}

fn looks_like_html_document(body: &str) -> bool {
    let body = body.trim_start();
    body.starts_with("<!DOCTYPE html")
        || body.starts_with("<!doctype html")
        || body.starts_with("<html")
        || body.starts_with("<HTML")
}

fn parse_start_response(response: &Value) -> AppResult<(String, String)> {
    let data = successful_data(response, "douyin_qr_generate")?;
    let qr_code_url = required_text(data, &["qrcode", "qr_code", "qrcode_url"], "二维码地址")?;
    let parsed_qr_url = Url::parse(&qr_code_url).map_err(|_| {
        AppError::new(
            "douyin_qr_response_invalid",
            "抖音二维码服务返回了无效二维码地址",
        )
        .with_site("douyin")
        .retryable()
    })?;
    if !is_trusted_douyin_url(&parsed_qr_url) {
        return Err(AppError::new(
            "douyin_qr_response_invalid",
            "抖音二维码服务返回了不受信任的二维码地址",
        )
        .with_site("douyin")
        .retryable());
    }
    let token = required_text(data, &["token", "qr_token"], "二维码登录凭据")?;
    Ok((qr_code_url, token))
}

enum PollState {
    Pending,
    Scanned,
    Expired,
    Success { redirect_url: String },
}

fn parse_poll_response(response: &Value) -> AppResult<PollState> {
    let data = successful_data(response, "douyin_qr_poll")?;
    let redirect_url = optional_text(data, &["redirect_url", "redirectUrl"]);
    if let Some(redirect_url) = redirect_url {
        // Douyin only provides this after the user has confirmed login. It is
        // a more reliable success signal than a numeric status that may vary
        // between web SSO versions.
        return Ok(PollState::Success { redirect_url });
    }

    let status = optional_text(data, &["status", "status_code"])
        .or_else(|| optional_number_as_text(data, &["status", "status_code"]))
        .unwrap_or_default();
    match status.trim().to_ascii_lowercase().as_str() {
        // The public web endpoint has historically used 1/2/3/4 for waiting,
        // scanned, confirmed, and expired respectively. Treat 0 as waiting
        // too: a few rollout variants omit a state until the first scan.
        "" | "0" | "1" | "pending" | "waiting" | "wait" => Ok(PollState::Pending),
        "2" | "scanned" | "scan" => Ok(PollState::Scanned),
        "4" | "5" | "expired" | "cancelled" | "canceled" => Ok(PollState::Expired),
        "3" | "success" | "confirmed" | "confirm" => Err(AppError::new(
            "douyin_qr_redirect_missing",
            "已确认登录但未取得跳转地址，请刷新二维码后重试",
        )
        .with_site("douyin")
        .retryable()),
        _ => Err(
            AppError::new("douyin_qr_poll", "二维码登录状态异常，请刷新二维码后重试")
                .with_site("douyin")
                .retryable(),
        ),
    }
}

async fn finish_login(session: &QrSession, redirect_url: &str) -> AppResult<String> {
    let redirect_url = Url::parse(redirect_url.trim()).map_err(|_| {
        AppError::new(
            "douyin_qr_redirect_invalid",
            "二维码登录跳转地址无效，请刷新二维码后重试",
        )
        .with_site("douyin")
        .retryable()
    })?;
    if !is_trusted_douyin_url(&redirect_url) {
        return Err(AppError::new(
            "douyin_qr_redirect_invalid",
            "二维码登录跳转地址不受信任，请刷新二维码后重试",
        )
        .with_site("douyin")
        .retryable());
    }

    let response = session
        .client
        .get(redirect_url)
        .header(
            ACCEPT,
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .header(ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.8")
        .header(REFERER, WEB_ORIGIN)
        .header(USER_AGENT, DEFAULT_USER_AGENT)
        .send()
        .await
        .map_err(|_| qr_network_error("douyin_qr_complete"))?;
    if !response.status().is_success() {
        return Err(
            AppError::new("douyin_qr_complete", "抖音登录确认失败，请刷新二维码后重试")
                .with_site("douyin")
                .retryable(),
        );
    }

    cookie_from_jar(&session.jar).ok_or_else(|| {
        AppError::new(
            "douyin_qr_cookie_missing",
            "登录已确认，但未取得可用 Cookie；请刷新二维码后重试",
        )
        .with_site("douyin")
        .retryable()
    })
}

fn successful_data<'a>(response: &'a Value, code: &str) -> AppResult<&'a Value> {
    // Douyin has used both `status_code` and `code` in web SSO responses.
    // Only a non-zero top-level value is an API error; `data.status` is the
    // independent QR-state value handled by `parse_poll_response`.
    let api_code = optional_number_as_text(response, &["status_code", "code"])
        .or_else(|| optional_text(response, &["status_code", "code"]));
    if let Some(api_code) = api_code
        && api_code.trim() != "0"
        && !api_code.trim().is_empty()
    {
        return Err(
            AppError::new(code, "抖音二维码登录服务拒绝了请求，请刷新二维码后重试")
                .with_site("douyin")
                .retryable(),
        );
    }
    let data = response.get("data").unwrap_or(response);
    if !data.is_object() {
        return Err(AppError::new(code, "抖音二维码登录服务未返回有效数据")
            .with_site("douyin")
            .retryable());
    }
    Ok(data)
}

fn required_text(data: &Value, keys: &[&str], label: &str) -> AppResult<String> {
    optional_text(data, keys).ok_or_else(|| {
        AppError::new(
            "douyin_qr_response_invalid",
            format!("抖音二维码服务未返回有效{label}"),
        )
        .with_site("douyin")
        .retryable()
    })
}

fn optional_text(data: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        let value = data.get(*key)?.as_str()?.trim();
        (!value.is_empty() && value.len() <= MAX_QR_PAYLOAD_LEN && !value.contains(['\r', '\n']))
            .then(|| value.to_string())
    })
}

fn optional_number_as_text(data: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| data.get(*key)?.as_i64().map(|value| value.to_string()))
}

fn cookie_from_jar(jar: &Arc<Jar>) -> Option<String> {
    let url = Url::parse(WEB_ORIGIN).ok()?;
    let cookie_header = jar.cookies(&url)?;
    let value = cookie_header.to_str().ok()?.trim();
    if value.is_empty() || value.len() > MAX_COOKIE_LEN || value.contains(['\r', '\n']) {
        return None;
    }
    let has_login_session = value.split(';').any(|pair| {
        let Some((key, cookie_value)) = pair.split_once('=') else {
            return false;
        };
        !cookie_value.trim().is_empty()
            && (key.trim().eq_ignore_ascii_case("sessionid")
                || key.trim().eq_ignore_ascii_case("sessionid_ss"))
    });
    has_login_session.then(|| value.to_string())
}

fn is_trusted_douyin_url(url: &Url) -> bool {
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    host == "douyin.com" || host.ends_with(".douyin.com")
}

fn can_follow_redirect(url: &Url, prior_redirects: usize) -> bool {
    prior_redirects < MAX_REDIRECTS && is_trusted_douyin_url(url)
}

fn is_valid_session_key(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn insert_session(key: String, session: QrSession) -> AppResult<()> {
    let mut sessions = active_sessions().lock().map_err(|_| {
        AppError::new("douyin_qr_session", "二维码登录会话初始化失败，请重试").with_site("douyin")
    })?;
    prune_sessions(&mut sessions);
    if sessions.len() >= MAX_ACTIVE_SESSIONS {
        if let Some(oldest_key) = sessions
            .iter()
            .min_by_key(|(_, session)| session.created_at)
            .map(|(key, _)| key.clone())
        {
            sessions.remove(&oldest_key);
        }
    }
    sessions.insert(key, session);
    Ok(())
}

fn get_session(key: &str) -> AppResult<QrSession> {
    let mut sessions = active_sessions().lock().map_err(|_| {
        AppError::new("douyin_qr_session", "二维码登录会话读取失败，请重试").with_site("douyin")
    })?;
    prune_sessions(&mut sessions);
    sessions.get(key).cloned().ok_or_else(|| {
        AppError::new(
            "douyin_qr_expired",
            "二维码登录会话已过期，请刷新二维码后重试",
        )
        .with_site("douyin")
    })
}

fn remove_session(key: &str) -> AppResult<()> {
    let mut sessions = active_sessions().lock().map_err(|_| {
        AppError::new("douyin_qr_session", "二维码登录会话清理失败，请重试").with_site("douyin")
    })?;
    sessions.remove(key);
    Ok(())
}

fn prune_sessions(sessions: &mut HashMap<String, QrSession>) {
    let now = Instant::now();
    sessions.retain(|_, session| now.duration_since(session.created_at) < SESSION_TTL);
}

fn qr_network_error(code: &str) -> AppError {
    AppError::new(code, "无法连接抖音二维码登录服务，请检查网络后重试")
        .with_site("douyin")
        .retryable()
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Arc;

    use reqwest::Url;
    use reqwest::cookie::Jar;
    use serde_json::json;

    use super::{
        PollState, build_login_client, can_follow_redirect, cookie_from_jar, is_trusted_douyin_url,
        is_valid_session_key, parse_json_body, parse_poll_response, parse_start_response,
    };

    #[test]
    fn reports_a_browser_verification_page_without_echoing_its_contents() {
        let error = parse_json_body(
            "<!doctype html><html><body>browser verification</body></html>",
            "douyin_qr_generate",
        )
        .unwrap_err();

        assert_eq!(error.code, "douyin_qr_generate");
        assert!(error.message.contains("浏览器完成访问验证"));
        assert!(!error.message.contains("browser verification"));
    }

    #[tokio::test]
    async fn configured_proxy_receives_qr_client_requests() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 2048];
            let length = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..length]);
            assert!(request.starts_with("GET http://sso.douyin.invalid/get_qrcode/ HTTP/1.1"));
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                )
                .unwrap();
        });

        let proxy = format!("http://{address}");
        let client = build_login_client(Arc::new(Jar::default()), Some(&proxy)).unwrap();
        let response = client
            .get("http://sso.douyin.invalid/get_qrcode/")
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), reqwest::StatusCode::OK);
        server.join().unwrap();
    }

    #[test]
    fn parses_public_web_qr_payload() {
        let body = json!({
            "status_code": 0,
            "data": {
                "qrcode": "https://sso.douyin.com/scan_qr/?token=abc",
                "token": "qr-token"
            }
        });

        assert_eq!(
            parse_start_response(&body).unwrap(),
            (
                "https://sso.douyin.com/scan_qr/?token=abc".to_string(),
                "qr-token".to_string()
            )
        );
    }

    #[test]
    fn rejects_an_untrusted_qr_payload_url() {
        let body = json!({
            "status_code": 0,
            "data": {
                "qrcode": "https://not-douyin.example/scan?token=abc",
                "token": "qr-token"
            }
        });

        let error = parse_start_response(&body).unwrap_err();
        assert_eq!(error.code, "douyin_qr_response_invalid");
    }

    #[test]
    fn poll_states_follow_the_public_web_protocol() {
        let pending = json!({ "status_code": 0, "data": { "status": "1" } });
        assert!(matches!(
            parse_poll_response(&pending).unwrap(),
            PollState::Pending
        ));

        let scanned = json!({ "status_code": 0, "data": { "status": 2 } });
        assert!(matches!(
            parse_poll_response(&scanned).unwrap(),
            PollState::Scanned
        ));

        let expired = json!({ "status_code": 0, "data": { "status": "4" } });
        assert!(matches!(
            parse_poll_response(&expired).unwrap(),
            PollState::Expired
        ));
    }

    #[test]
    fn redirect_is_the_success_signal() {
        let body = json!({
            "status_code": 0,
            "data": {
                "status": "3",
                "redirect_url": "https://www.douyin.com/passport/web/login/?token=abc"
            }
        });
        let state = parse_poll_response(&body).unwrap();
        assert!(matches!(state, PollState::Success { .. }));
    }

    #[test]
    fn login_cookie_requires_a_session_cookie() {
        let jar = Arc::new(Jar::default());
        let url = Url::parse("https://www.douyin.com/").unwrap();
        jar.add_cookie_str("ttwid=anonymous; Domain=.douyin.com; Path=/", &url);
        assert!(cookie_from_jar(&jar).is_none());

        jar.add_cookie_str("sessionid=logged-in; Domain=.douyin.com; Path=/", &url);
        let cookie = cookie_from_jar(&jar).unwrap();
        assert!(
            cookie
                .split(';')
                .any(|pair| pair.trim() == "sessionid=logged-in")
        );
        assert!(
            cookie
                .split(';')
                .any(|pair| pair.trim() == "ttwid=anonymous")
        );

        let empty_session = Arc::new(Jar::default());
        empty_session.add_cookie_str("sessionid=; Domain=.douyin.com; Path=/", &url);
        assert!(cookie_from_jar(&empty_session).is_none());
    }

    #[test]
    fn only_https_douyin_redirects_are_trusted() {
        assert!(is_trusted_douyin_url(
            &Url::parse("https://sso.douyin.com/login").unwrap()
        ));
        assert!(!is_trusted_douyin_url(
            &Url::parse("http://sso.douyin.com/login").unwrap()
        ));
        assert!(!is_trusted_douyin_url(
            &Url::parse("https://douyin.com.example.test/login").unwrap()
        ));
        assert!(!is_trusted_douyin_url(
            &Url::parse("https://user@www.douyin.com/login").unwrap()
        ));
        assert!(!is_trusted_douyin_url(
            &Url::parse("https://www.douyin.com:8443/login").unwrap()
        ));
    }

    #[test]
    fn redirect_policy_limits_hops_and_only_allows_douyin() {
        let trusted = Url::parse("https://sso.douyin.com/login").unwrap();
        let untrusted = Url::parse("https://example.test/login").unwrap();

        assert!(can_follow_redirect(&trusted, 0));
        assert!(!can_follow_redirect(&trusted, 8));
        assert!(!can_follow_redirect(&untrusted, 0));
    }

    #[test]
    fn session_handles_must_be_opaque_uuid_hex() {
        assert!(is_valid_session_key("2b5c33979f4d44efae6a3b011fe7db12"));
        assert!(!is_valid_session_key("not-a-session-key"));
        assert!(!is_valid_session_key("2b5c33979f4d44efae6a3b011fe7db1"));
    }
}
