//! User-operated Douyu web QR login.
//!
//! This mirrors the public QR flow used by Douyu's current passport page:
//! `scan/generateCode` creates a mobile-app QR payload, then
//! `japi/scan/auth` reports its state.  The one-time upstream scan code and
//! the Cookie jar remain process-local.  Only a successful, validated Cookie
//! header is returned to the account command for local persistence.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use reqwest::cookie::{CookieStore, Jar};
use reqwest::header::{ACCEPT, ACCEPT_LANGUAGE, ORIGIN, REFERER, USER_AGENT};
use reqwest::{Client, Url};
use serde_json::Value;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

const PASSPORT_ORIGIN: &str = "https://passport.douyu.com/";
const WEB_ORIGIN: &str = "https://www.douyu.com/";
const QR_GENERATE_URL: &str = "https://passport.douyu.com/scan/generateCode";
const QR_POLL_URL: &str = "https://passport.douyu.com/japi/scan/auth";
const JSONP_CALLBACK: &str = "rlive_douyu_qr_callback";
const USER_AGENT_VALUE: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const SESSION_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_ACTIVE_SESSIONS: usize = 16;
const MAX_REDIRECTS: usize = 8;
const MAX_QR_PAYLOAD_LEN: usize = 8 * 1024;
const MAX_SCAN_CODE_LEN: usize = 512;
const MAX_COOKIE_LEN: usize = 16 * 1024;

/// Data needed to render a Douyu login QR code in the client.
pub struct QrLoginStart {
    pub qr_code_url: String,
    /// Opaque, process-local handle rather than Douyu's actual scan code.
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
    scan_code: String,
    client: Client,
    jar: Arc<Jar>,
    created_at: Instant,
}

static ACTIVE_SESSIONS: OnceLock<Mutex<HashMap<String, QrSession>>> = OnceLock::new();

fn active_sessions() -> &'static Mutex<HashMap<String, QrSession>> {
    ACTIVE_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Start the public Douyu web QR flow.
pub async fn start() -> AppResult<QrLoginStart> {
    let jar = Arc::new(Jar::default());
    let client = build_login_client(Arc::clone(&jar))?;
    let response = client
        .post(QR_GENERATE_URL)
        .form(&[("client_id", "1"), ("isMultiAccount", "0")])
        .header(ACCEPT, "application/json, text/javascript, */*; q=0.01")
        .header(ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.8")
        .header(ORIGIN, "https://passport.douyu.com")
        .header(REFERER, PASSPORT_ORIGIN)
        .header("x-requested-with", "XMLHttpRequest")
        .header(USER_AGENT, USER_AGENT_VALUE)
        .send()
        .await
        .map_err(|_| qr_network_error("douyu_qr_generate"))?;
    let body = parse_json_response(response, "douyu_qr_generate").await?;
    let (qr_code_url, scan_code) = parse_start_response(&body)?;

    // The UI necessarily receives the QR payload to render, but the scan code
    // is never returned as a separate value. It remains paired with the
    // bootstrap Cookie jar in this process.
    let qr_key = Uuid::new_v4().simple().to_string();
    insert_session(
        qr_key.clone(),
        QrSession {
            scan_code,
            client,
            jar,
            created_at: Instant::now(),
        },
    )?;

    Ok(QrLoginStart {
        qr_code_url,
        qr_key,
    })
}

/// Poll a previously-started QR login flow.
pub async fn poll(qr_key: &str) -> AppResult<QrLoginPoll> {
    if !is_valid_session_key(qr_key) {
        return Err(
            AppError::new("douyu_qr_invalid_key", "二维码登录凭据无效，请刷新二维码")
                .with_site("douyu"),
        );
    }

    let session = get_session(qr_key)?;
    let now_ms = chrono::Utc::now().timestamp_millis().to_string();
    let response = session
        .client
        .get(QR_POLL_URL)
        .query(&[
            ("code", session.scan_code.as_str()),
            ("time", now_ms.as_str()),
        ])
        .header(ACCEPT, "application/json, text/javascript, */*; q=0.01")
        .header(ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.8")
        .header(REFERER, PASSPORT_ORIGIN)
        .header("x-requested-with", "XMLHttpRequest")
        .header(USER_AGENT, USER_AGENT_VALUE)
        .send()
        .await
        .map_err(|_| qr_network_error("douyu_qr_poll"))?;
    let body = parse_json_response(response, "douyu_qr_poll").await?;

    match parse_poll_response(&body)? {
        PollState::Pending => Ok(QrLoginPoll::Pending),
        PollState::Scanned => Ok(QrLoginPoll::Scanned),
        PollState::Expired => {
            remove_session(qr_key)?;
            Ok(QrLoginPoll::Expired)
        }
        PollState::Success { completion_url } => {
            let cookie = finish_login(&session, &completion_url).await?;
            remove_session(qr_key)?;
            Ok(QrLoginPoll::Success { cookie })
        }
    }
}

fn build_login_client(jar: Arc<Jar>) -> AppResult<Client> {
    Client::builder()
        .use_rustls_tls()
        .cookie_provider(jar)
        // QR authentication carries a temporary login session. Do not use a
        // process-level HTTP(S) proxy or the app's browsing proxy for it.
        .no_proxy()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        // Login completion is allowed to traverse only Douyu-owned HTTPS
        // hosts, so a server-supplied URL cannot turn this client into an
        // authenticated request to an arbitrary destination.
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if can_follow_redirect(attempt.url(), attempt.previous().len()) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(|_| {
            AppError::new("douyu_qr_client", "二维码登录网络客户端初始化失败").with_site("douyu")
        })
}

async fn parse_json_response(response: reqwest::Response, code: &str) -> AppResult<Value> {
    if !response.status().is_success() {
        return Err(
            AppError::new(code, "斗鱼二维码登录服务暂不可用，请稍后重试")
                .with_site("douyu")
                .retryable(),
        );
    }
    response.json::<Value>().await.map_err(|_| {
        AppError::new(code, "斗鱼二维码登录服务返回了无法识别的数据")
            .with_site("douyu")
            .retryable()
    })
}

fn parse_start_response(response: &Value) -> AppResult<(String, String)> {
    ensure_api_success(response, "douyu_qr_generate")?;
    let data = response
        .get("data")
        .ok_or_else(|| invalid_response("douyu_qr_generate"))?;
    let qr_code_url = required_text(data, &["url", "qr_url", "qrcode_url"], MAX_QR_PAYLOAD_LEN)?;
    let qr_url = parse_trusted_douyu_url(&qr_code_url).ok_or_else(|| {
        AppError::new(
            "douyu_qr_response_invalid",
            "斗鱼二维码服务返回了不受信任的二维码地址",
        )
        .with_site("douyu")
        .retryable()
    })?;
    if !is_trusted_douyu_url(&qr_url) {
        return Err(AppError::new(
            "douyu_qr_response_invalid",
            "斗鱼二维码服务返回了不受信任的二维码地址",
        )
        .with_site("douyu")
        .retryable());
    }
    let scan_code = required_text(data, &["code", "scan_code"], MAX_SCAN_CODE_LEN)?;
    Ok((qr_url.to_string(), scan_code))
}

enum PollState {
    Pending,
    Scanned,
    Expired,
    Success { completion_url: String },
}

fn parse_poll_response(response: &Value) -> AppResult<PollState> {
    let error = api_error_code(response).ok_or_else(|| invalid_response("douyu_qr_poll"))?;
    match error {
        // Confirmed against the current public passport page. `-2` means the
        // app has not scanned yet; `1` means scanned and awaiting confirmation;
        // `-1` is an expired or invalid QR code.
        -2 => Ok(PollState::Pending),
        1 => Ok(PollState::Scanned),
        -1 => Ok(PollState::Expired),
        0 => {
            let data = response
                .get("data")
                .ok_or_else(|| invalid_response("douyu_qr_poll"))?;
            let completion_url = required_text(data, &["url", "login_url"], MAX_QR_PAYLOAD_LEN)?;
            Ok(PollState::Success { completion_url })
        }
        _ => Err(
            AppError::new("douyu_qr_poll", "二维码登录状态异常，请刷新二维码后重试")
                .with_site("douyu")
                .retryable(),
        ),
    }
}

async fn finish_login(session: &QrSession, completion_url: &str) -> AppResult<String> {
    let completion_url = parse_trusted_douyu_url(completion_url).ok_or_else(|| {
        AppError::new(
            "douyu_qr_redirect_invalid",
            "斗鱼登录跳转地址无效或不受信任，请刷新二维码后重试",
        )
        .with_site("douyu")
        .retryable()
    })?;
    if !is_trusted_douyu_url(&completion_url) {
        return Err(AppError::new(
            "douyu_qr_redirect_invalid",
            "斗鱼登录跳转地址无效或不受信任，请刷新二维码后重试",
        )
        .with_site("douyu")
        .retryable());
    }

    let completion_url = with_jsonp_callback(completion_url);
    let response = session
        .client
        .get(completion_url)
        .header(
            ACCEPT,
            "application/javascript, application/json, text/javascript, */*; q=0.01",
        )
        .header(ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.8")
        .header(REFERER, PASSPORT_ORIGIN)
        .header(USER_AGENT, USER_AGENT_VALUE)
        .send()
        .await
        .map_err(|_| qr_network_error("douyu_qr_complete"))?;
    if !response.status().is_success() {
        return Err(
            AppError::new("douyu_qr_complete", "斗鱼登录确认失败，请刷新二维码后重试")
                .with_site("douyu")
                .retryable(),
        );
    }
    let body = response.text().await.map_err(|_| {
        AppError::new(
            "douyu_qr_complete",
            "斗鱼登录确认响应读取失败，请刷新二维码后重试",
        )
        .with_site("douyu")
        .retryable()
    })?;
    let response = parse_json_or_jsonp(&body, JSONP_CALLBACK)?;
    ensure_api_success(&response, "douyu_qr_complete")?;

    cookie_from_jar(&session.jar).ok_or_else(|| {
        AppError::new(
            "douyu_qr_cookie_missing",
            "登录已确认，但未取得可用 Cookie；请刷新二维码后重试",
        )
        .with_site("douyu")
        .retryable()
    })
}

fn ensure_api_success(response: &Value, code: &str) -> AppResult<()> {
    match api_error_code(response) {
        Some(0) => Ok(()),
        Some(_) => Err(
            AppError::new(code, "斗鱼二维码登录服务拒绝了请求，请刷新二维码后重试")
                .with_site("douyu")
                .retryable(),
        ),
        None => Err(invalid_response(code)),
    }
}

fn api_error_code(response: &Value) -> Option<i64> {
    ["error", "code"]
        .iter()
        .find_map(|key| value_as_i64(response.get(*key)?))
}

fn value_as_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
        .or_else(|| value.as_str()?.trim().parse::<i64>().ok())
}

fn required_text(data: &Value, keys: &[&str], max_len: usize) -> AppResult<String> {
    optional_text(data, keys, max_len).ok_or_else(|| invalid_response("douyu_qr_response_invalid"))
}

fn optional_text(data: &Value, keys: &[&str], max_len: usize) -> Option<String> {
    keys.iter().find_map(|key| {
        let value = data.get(*key)?.as_str()?.trim();
        (!value.is_empty() && value.len() <= max_len && !value.contains(['\r', '\n']))
            .then(|| value.to_string())
    })
}

fn parse_json_or_jsonp(body: &str, callback: &str) -> AppResult<Value> {
    let body = body.trim_start_matches('\u{feff}').trim();
    if let Ok(json) = serde_json::from_str(body) {
        return Ok(json);
    }

    // Douyu's completion endpoint is a JSONP callback in its web client.
    // Accept only the exact callback name selected by this module, not an
    // arbitrary JavaScript function name returned by the server.
    let body = body.strip_prefix("/**/").unwrap_or(body).trim();
    let prefix = format!("{callback}(");
    let json = body.strip_prefix(&prefix).and_then(|rest| {
        rest.strip_suffix(");")
            .or_else(|| rest.strip_suffix(')'))
            .map(str::trim)
    });
    json.and_then(|json| serde_json::from_str(json).ok())
        .ok_or_else(|| {
            AppError::new("douyu_qr_complete", "斗鱼登录确认服务返回了无法识别的数据")
                .with_site("douyu")
                .retryable()
        })
}

fn cookie_from_jar(jar: &Arc<Jar>) -> Option<String> {
    let url = Url::parse(WEB_ORIGIN).ok()?;
    let cookie_header = jar.cookies(&url)?;
    let value = cookie_header.to_str().ok()?.trim();
    if value.is_empty() || value.len() > MAX_COOKIE_LEN || value.contains(['\r', '\n']) {
        return None;
    }

    // These are the authenticated Cookie fields required by Douyu's web APIs.
    // Keep all other web Cookie fields in the stored header, but never accept
    // a partial successful-looking login without this credential trio.
    const REQUIRED_COOKIES: [&str; 3] = ["acf_username", "acf_stk", "acf_ltkid"];
    let names = value
        .split(';')
        .filter_map(|pair| pair.split_once('='))
        .filter_map(|(name, cookie_value)| (!cookie_value.trim().is_empty()).then_some(name.trim()))
        .collect::<Vec<_>>();
    REQUIRED_COOKIES
        .iter()
        .all(|required| names.iter().any(|name| name.eq_ignore_ascii_case(required)))
        .then(|| value.to_string())
}

fn parse_trusted_douyu_url(value: &str) -> Option<Url> {
    match Url::parse(value) {
        Ok(url) => Some(url),
        Err(_) => Url::parse(PASSPORT_ORIGIN).ok()?.join(value).ok(),
    }
}

fn with_jsonp_callback(mut url: Url) -> Url {
    let existing_pairs = url
        .query_pairs()
        .filter(|(key, _)| key != "callback")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    url.set_query(None);
    {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in existing_pairs {
            pairs.append_pair(&key, &value);
        }
        pairs.append_pair("callback", JSONP_CALLBACK);
    }
    url
}

fn is_trusted_douyu_url(url: &Url) -> bool {
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
    host == "douyu.com" || host.ends_with(".douyu.com")
}

fn can_follow_redirect(url: &Url, prior_redirects: usize) -> bool {
    prior_redirects < MAX_REDIRECTS && is_trusted_douyu_url(url)
}

fn is_valid_session_key(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn insert_session(key: String, session: QrSession) -> AppResult<()> {
    let mut sessions = active_sessions().lock().map_err(|_| {
        AppError::new("douyu_qr_session", "二维码登录会话初始化失败，请重试").with_site("douyu")
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
        AppError::new("douyu_qr_session", "二维码登录会话读取失败，请重试").with_site("douyu")
    })?;
    prune_sessions(&mut sessions);
    sessions.get(key).cloned().ok_or_else(|| {
        AppError::new(
            "douyu_qr_expired",
            "二维码登录会话已过期，请刷新二维码后重试",
        )
        .with_site("douyu")
    })
}

fn remove_session(key: &str) -> AppResult<()> {
    let mut sessions = active_sessions().lock().map_err(|_| {
        AppError::new("douyu_qr_session", "二维码登录会话清理失败，请重试").with_site("douyu")
    })?;
    sessions.remove(key);
    Ok(())
}

fn prune_sessions(sessions: &mut HashMap<String, QrSession>) {
    let now = Instant::now();
    sessions.retain(|_, session| now.duration_since(session.created_at) < SESSION_TTL);
}

fn invalid_response(code: &str) -> AppError {
    AppError::new(code, "斗鱼二维码登录服务未返回有效数据")
        .with_site("douyu")
        .retryable()
}

fn qr_network_error(code: &str) -> AppError {
    AppError::new(code, "无法连接斗鱼二维码登录服务，请检查网络后重试")
        .with_site("douyu")
        .retryable()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use reqwest::Url;
    use reqwest::cookie::Jar;
    use serde_json::json;

    use super::{
        PollState, can_follow_redirect, cookie_from_jar, is_trusted_douyu_url,
        is_valid_session_key, parse_json_or_jsonp, parse_poll_response, parse_start_response,
        with_jsonp_callback,
    };

    #[test]
    fn parses_current_public_qr_payload() {
        let body = json!({
            "error": 0,
            "data": {
                "expire": 300,
                "url": "https://m.douyu.com/topic/scan-login-middle-page?scan_code=example",
                "code": "0123456789abcdef0123456789abcdef"
            }
        });

        assert_eq!(
            parse_start_response(&body).unwrap(),
            (
                "https://m.douyu.com/topic/scan-login-middle-page?scan_code=example".to_string(),
                "0123456789abcdef0123456789abcdef".to_string()
            )
        );
    }

    #[test]
    fn rejects_an_untrusted_qr_payload_url() {
        let body = json!({
            "error": 0,
            "data": {
                "url": "https://not-douyu.example/scan",
                "code": "0123456789abcdef0123456789abcdef"
            }
        });

        let error = parse_start_response(&body).unwrap_err();
        assert_eq!(error.code, "douyu_qr_response_invalid");
    }

    #[test]
    fn poll_states_follow_the_public_passport_protocol() {
        let pending = json!({ "error": -2, "msg": "客户端还未扫码" });
        assert!(matches!(
            parse_poll_response(&pending).unwrap(),
            PollState::Pending
        ));

        let scanned = json!({ "error": 1 });
        assert!(matches!(
            parse_poll_response(&scanned).unwrap(),
            PollState::Scanned
        ));

        let expired = json!({ "error": -1 });
        assert!(matches!(
            parse_poll_response(&expired).unwrap(),
            PollState::Expired
        ));
    }

    #[test]
    fn success_requires_a_completion_url() {
        let body = json!({
            "error": 0,
            "data": { "url": "https://www.douyu.com/member/login" }
        });
        let state = parse_poll_response(&body).unwrap();
        assert!(matches!(state, PollState::Success { .. }));

        let missing = json!({ "error": 0, "data": {} });
        assert!(parse_poll_response(&missing).is_err());
    }

    #[test]
    fn accepts_only_the_expected_jsonp_callback() {
        let jsonp = r#"/**/rlive_douyu_qr_callback({"error":0});"#;
        assert_eq!(
            parse_json_or_jsonp(jsonp, "rlive_douyu_qr_callback")
                .unwrap()
                .get("error")
                .and_then(|value| value.as_i64()),
            Some(0)
        );
        assert!(
            parse_json_or_jsonp("other_callback({\"error\":0});", "rlive_douyu_qr_callback")
                .is_err()
        );
    }

    #[test]
    fn completion_callback_is_replaced_not_appended() {
        let url = Url::parse("https://www.douyu.com/login?ticket=abc&callback=other").unwrap();
        let url = with_jsonp_callback(url);
        let pairs = url.query_pairs().collect::<Vec<_>>();

        assert!(
            pairs
                .iter()
                .any(|(key, value)| key == "ticket" && value == "abc")
        );
        assert_eq!(
            pairs
                .iter()
                .filter(|(key, _)| key == "callback")
                .map(|(_, value)| value.as_ref())
                .collect::<Vec<_>>(),
            vec!["rlive_douyu_qr_callback"]
        );
    }

    #[test]
    fn login_cookie_requires_the_douyu_session_trio() {
        let jar = Arc::new(Jar::default());
        let url = Url::parse("https://www.douyu.com/").unwrap();
        jar.add_cookie_str("acf_username=viewer; Domain=.douyu.com; Path=/", &url);
        jar.add_cookie_str("acf_stk=token; Domain=.douyu.com; Path=/", &url);
        assert!(cookie_from_jar(&jar).is_none());

        jar.add_cookie_str("acf_ltkid=login-token; Domain=.douyu.com; Path=/", &url);
        let cookie = cookie_from_jar(&jar).unwrap();
        assert!(
            cookie
                .split(';')
                .any(|pair| pair.trim() == "acf_username=viewer")
        );
        assert!(cookie.split(';').any(|pair| pair.trim() == "acf_stk=token"));
        assert!(
            cookie
                .split(';')
                .any(|pair| pair.trim() == "acf_ltkid=login-token")
        );
    }

    #[test]
    fn only_https_douyu_redirects_are_trusted() {
        assert!(is_trusted_douyu_url(
            &Url::parse("https://passport.douyu.com/login").unwrap()
        ));
        assert!(!is_trusted_douyu_url(
            &Url::parse("http://passport.douyu.com/login").unwrap()
        ));
        assert!(!is_trusted_douyu_url(
            &Url::parse("https://douyu.com.example.test/login").unwrap()
        ));
        assert!(!is_trusted_douyu_url(
            &Url::parse("https://user@www.douyu.com/login").unwrap()
        ));
        assert!(!is_trusted_douyu_url(
            &Url::parse("https://www.douyu.com:8443/login").unwrap()
        ));
    }

    #[test]
    fn redirect_policy_limits_hops_and_only_allows_douyu() {
        let trusted = Url::parse("https://passport.douyu.com/login").unwrap();
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
