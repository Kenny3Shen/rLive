//! Bilibili's user-operated QR login flow.
//!
//! The desktop app only displays the QR URL returned by Bilibili and polls the
//! matching public status endpoint.  Bilibili delivers the web session through
//! `Set-Cookie` response headers on the poll request, and repeats some of the
//! same fields in the callback URL query.  Both sources are collected with a
//! process-local cookie jar so a confirmed scan is not rejected when the
//! callback URL omits them; neither the QR key nor the cookie is logged.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use reqwest::cookie::{CookieStore, Jar};
use reqwest::header::{ACCEPT, ACCEPT_LANGUAGE, REFERER, USER_AGENT};
use reqwest::{Client, Url};
use serde::Deserialize;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

const PASSPORT_ORIGIN: &str = "https://passport.bilibili.com/";
const WEB_ORIGIN: &str = "https://www.bilibili.com/";
const QR_GENERATE_URL: &str = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate";
const QR_POLL_URL: &str = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll";
const USER_AGENT_VALUE: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const SESSION_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_ACTIVE_SESSIONS: usize = 16;
const MAX_REDIRECTS: usize = 8;
const MAX_QR_KEY_LEN: usize = 512;
const MAX_COOKIE_LEN: usize = 16 * 1024;

/// Cookie fields Bilibili's web APIs rely on, in stored header order.
const COOKIE_KEYS: &[&str] = &[
    "SESSDATA",
    "bili_jct",
    "DedeUserID",
    "DedeUserID__ckMd5",
    "sid",
    "buvid3",
    "buvid4",
];

/// Data required to render a Bilibili login QR code in the client.
pub struct QrLoginStart {
    pub qr_code_url: String,
    /// Opaque, process-local handle rather than Bilibili's actual `qrcode_key`.
    pub qr_key: String,
}

/// A poll result.  Cookie material is returned only inside the Rust process so
/// the command can persist it directly into the local SQLite account store.
pub enum QrLoginPoll {
    Pending,
    Scanned,
    Expired,
    Success { cookie: String },
}

#[derive(Clone)]
struct QrSession {
    qrcode_key: String,
    client: Client,
    jar: Arc<Jar>,
    created_at: Instant,
}

static ACTIVE_SESSIONS: OnceLock<Mutex<HashMap<String, QrSession>>> = OnceLock::new();

fn active_sessions() -> &'static Mutex<HashMap<String, QrSession>> {
    ACTIVE_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Deserialize)]
struct ApiResponse<T> {
    code: i64,
    #[serde(default)]
    message: String,
    data: Option<T>,
}

#[derive(Debug, Deserialize)]
struct GenerateData {
    url: String,
    qrcode_key: String,
}

#[derive(Debug, Deserialize)]
struct PollData {
    code: i64,
    #[serde(default)]
    url: String,
}

pub async fn start() -> AppResult<QrLoginStart> {
    let jar = Arc::new(Jar::default());
    let client = build_login_client(Arc::clone(&jar))?;
    let response = client
        .get(QR_GENERATE_URL)
        .header(ACCEPT, "application/json, text/plain, */*")
        .header(ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.8")
        .header(REFERER, PASSPORT_ORIGIN)
        .header(USER_AGENT, USER_AGENT_VALUE)
        .send()
        .await
        .map_err(|_| qr_network_error("bilibili_qr_generate"))?;

    let response: ApiResponse<GenerateData> = response.json().await.map_err(|_| {
        AppError::new("bilibili_qr_generate", "二维码服务返回了无法识别的数据")
            .with_site("bilibili")
            .retryable()
    })?;
    if response.code != 0 {
        return Err(qr_api_error("bilibili_qr_generate", &response.message));
    }

    let data = response.data.ok_or_else(|| {
        AppError::new("bilibili_qr_generate", "二维码服务未返回登录地址")
            .with_site("bilibili")
            .retryable()
    })?;
    if data.url.trim().is_empty()
        || data.qrcode_key.trim().is_empty()
        || data.qrcode_key.len() > MAX_QR_KEY_LEN
    {
        return Err(
            AppError::new("bilibili_qr_generate", "二维码服务返回了不完整的登录信息")
                .with_site("bilibili")
                .retryable(),
        );
    }

    let qr_key = Uuid::new_v4().simple().to_string();
    insert_session(
        qr_key.clone(),
        QrSession {
            qrcode_key: data.qrcode_key,
            client,
            jar,
            created_at: Instant::now(),
        },
    )?;

    Ok(QrLoginStart {
        qr_code_url: data.url,
        qr_key,
    })
}

pub async fn poll(qr_key: &str) -> AppResult<QrLoginPoll> {
    if !is_valid_session_key(qr_key) {
        return Err(AppError::new(
            "bilibili_qr_invalid_key",
            "二维码登录凭据无效，请刷新二维码",
        )
        .with_site("bilibili"));
    }

    let session = get_session(qr_key)?;
    let response = session
        .client
        .get(QR_POLL_URL)
        .query(&[("qrcode_key", session.qrcode_key.as_str())])
        .header(ACCEPT, "application/json, text/plain, */*")
        .header(ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.8")
        .header(REFERER, PASSPORT_ORIGIN)
        .header(USER_AGENT, USER_AGENT_VALUE)
        .send()
        .await
        .map_err(|_| qr_network_error("bilibili_qr_poll"))?;

    // Reading the body consumes the response, so the jar must already hold the
    // `Set-Cookie` fields; reqwest's cookie store is populated before this
    // point precisely because the client was built with a cookie provider.
    let response: ApiResponse<PollData> = response.json().await.map_err(|_| {
        AppError::new("bilibili_qr_poll", "二维码状态服务返回了无法识别的数据")
            .with_site("bilibili")
            .retryable()
    })?;
    if response.code != 0 {
        return Err(qr_api_error("bilibili_qr_poll", &response.message));
    }

    let data = response.data.ok_or_else(|| {
        AppError::new("bilibili_qr_poll", "二维码状态服务未返回登录状态")
            .with_site("bilibili")
            .retryable()
    })?;
    match data.code {
        0 => {
            let cookie = login_cookie(&session.jar, &data.url).ok_or_else(|| {
                AppError::new(
                    "bilibili_qr_cookie_missing",
                    "登录已确认，但未取得可用 Cookie；请刷新二维码后重试",
                )
                .with_site("bilibili")
                .retryable()
            })?;
            remove_session(qr_key)?;
            Ok(QrLoginPoll::Success { cookie })
        }
        86_101 => Ok(QrLoginPoll::Pending),
        86_090 => Ok(QrLoginPoll::Scanned),
        86_038 => {
            remove_session(qr_key)?;
            Ok(QrLoginPoll::Expired)
        }
        _ => Err(
            AppError::new("bilibili_qr_poll", "二维码登录暂不可用，请刷新二维码后重试")
                .with_site("bilibili")
                .retryable(),
        ),
    }
}

fn build_login_client(jar: Arc<Jar>) -> AppResult<Client> {
    Client::builder()
        .use_native_tls()
        .cookie_provider(jar)
        // QR authentication carries a temporary login session. Do not route it
        // through a process-level HTTP(S) proxy or the app browsing proxy.
        .no_proxy()
        .gzip(true)
        .brotli(true)
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        // Login completion may only traverse Bilibili-owned HTTPS hosts so a
        // server-supplied URL cannot turn this client into an authenticated
        // request to an arbitrary destination.
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if can_follow_redirect(attempt.url(), attempt.previous().len()) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(|_| {
            AppError::new("bilibili_qr_client", "二维码登录网络客户端初始化失败")
                .with_site("bilibili")
        })
}

fn qr_network_error(code: &str) -> AppError {
    AppError::new(code, "无法连接二维码登录服务，请检查网络后重试")
        .with_site("bilibili")
        .retryable()
}

fn qr_api_error(code: &str, message: &str) -> AppError {
    let message = if message.trim().is_empty() {
        "二维码登录服务暂不可用，请稍后重试"
    } else {
        "二维码登录服务拒绝了请求，请刷新二维码后重试"
    };
    AppError::new(code, message)
        .with_site("bilibili")
        .retryable()
}

/// Merge the confirmed login Cookie from both sources Bilibili uses.
///
/// The poll response's `Set-Cookie` headers are the primary source; the
/// callback URL query repeats a subset and is kept as a fallback for the case
/// where a field arrives only there.  Jar values win on conflict because they
/// are what the browser itself would store.
fn login_cookie(jar: &Arc<Jar>, callback_url: &str) -> Option<String> {
    let mut values = cookies_from_jar(jar);
    for (key, value) in cookies_from_callback_url(callback_url) {
        values.entry(key).or_insert(value);
    }

    // `SESSDATA` is the minimum credential needed by the Bilibili APIs used
    // in this application.  Do not write a partial successful-looking login.
    if !values.contains_key("SESSDATA") {
        return None;
    }

    let cookie = COOKIE_KEYS
        .iter()
        .filter_map(|key| values.get(*key).map(|value| format!("{key}={value}")))
        .collect::<Vec<_>>()
        .join("; ");
    if cookie.is_empty() || cookie.len() > MAX_COOKIE_LEN || cookie.contains(['\r', '\n']) {
        return None;
    }
    Some(cookie)
}

/// Read the known login fields the poll request stored in the cookie jar.
///
/// Values are stored exactly as Bilibili sent them.  reqwest's jar does not
/// percent-decode a cookie value, and `SESSDATA` must reach the web APIs in its
/// original encoded form, so re-encoding here would corrupt it.
fn cookies_from_jar(jar: &Arc<Jar>) -> HashMap<&'static str, String> {
    let mut values = HashMap::new();
    for origin in [PASSPORT_ORIGIN, WEB_ORIGIN] {
        let Ok(url) = Url::parse(origin) else {
            continue;
        };
        let Some(header) = jar.cookies(&url) else {
            continue;
        };
        let Ok(header) = header.to_str() else {
            continue;
        };
        for pair in header.split(';') {
            let Some((key, value)) = pair.trim().split_once('=') else {
                continue;
            };
            let value = value.trim();
            if value.is_empty() {
                continue;
            }
            if !is_safe_cookie_value(value) {
                continue;
            }
            let Some(key) = COOKIE_KEYS
                .iter()
                .find(|known| known.eq_ignore_ascii_case(key.trim()))
            else {
                continue;
            };
            values.entry(*key).or_insert_with(|| value.to_string());
        }
    }
    values
}

/// Read the known login fields carried by Bilibili's QR callback URL.
///
/// Values deliberately remain percent-encoded: Bilibili cookie values such as
/// `SESSDATA` commonly use `%2C`, and decoding/re-encoding them can change the
/// opaque value accepted by the web APIs.
fn cookies_from_callback_url(callback_url: &str) -> HashMap<&'static str, String> {
    let mut values = HashMap::new();
    let Some(query) = callback_url
        .split_once('?')
        .map(|(_, query)| query.split('#').next().unwrap_or_default())
    else {
        return values;
    };
    for pair in query.split('&') {
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        if !is_safe_cookie_value(value) {
            continue;
        }
        if let Some(key) = COOKIE_KEYS.iter().find(|known| **known == key) {
            values.entry(*key).or_insert_with(|| value.to_string());
        }
    }
    values
}

/// Accept only a non-empty value that can be sent verbatim in a Cookie header.
///
/// Bilibili's values are already percent-encoded ASCII; anything carrying a
/// separator or control byte would let a crafted response inject a second
/// cookie field, so it is dropped instead of escaped.
fn is_safe_cookie_value(value: &str) -> bool {
    !value.is_empty()
        && value.is_ascii()
        && !value.bytes().any(|byte| {
            byte.is_ascii_control() || matches!(byte, b';' | b',' | b'"' | b'\\' | b' ')
        })
}

fn is_trusted_bilibili_url(url: &Url) -> bool {
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
    host == "bilibili.com" || host.ends_with(".bilibili.com")
}

fn can_follow_redirect(url: &Url, prior_redirects: usize) -> bool {
    prior_redirects < MAX_REDIRECTS && is_trusted_bilibili_url(url)
}

fn is_valid_session_key(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn insert_session(key: String, session: QrSession) -> AppResult<()> {
    let mut sessions = active_sessions().lock().map_err(|_| {
        AppError::new("bilibili_qr_session", "二维码登录会话初始化失败，请重试")
            .with_site("bilibili")
    })?;
    prune_sessions(&mut sessions);
    if sessions.len() >= MAX_ACTIVE_SESSIONS
        && let Some(oldest_key) = sessions
            .iter()
            .min_by_key(|(_, session)| session.created_at)
            .map(|(key, _)| key.clone())
    {
        sessions.remove(&oldest_key);
    }
    sessions.insert(key, session);
    Ok(())
}

fn get_session(key: &str) -> AppResult<QrSession> {
    let mut sessions = active_sessions().lock().map_err(|_| {
        AppError::new("bilibili_qr_session", "二维码登录会话读取失败，请重试").with_site("bilibili")
    })?;
    prune_sessions(&mut sessions);
    sessions.get(key).cloned().ok_or_else(|| {
        AppError::new(
            "bilibili_qr_expired",
            "二维码登录会话已过期，请刷新二维码后重试",
        )
        .with_site("bilibili")
    })
}

fn remove_session(key: &str) -> AppResult<()> {
    let mut sessions = active_sessions().lock().map_err(|_| {
        AppError::new("bilibili_qr_session", "二维码登录会话清理失败，请重试").with_site("bilibili")
    })?;
    sessions.remove(key);
    Ok(())
}

fn prune_sessions(sessions: &mut HashMap<String, QrSession>) {
    let now = Instant::now();
    sessions.retain(|_, session| now.duration_since(session.created_at) < SESSION_TTL);
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use reqwest::Url;
    use reqwest::cookie::Jar;

    use super::{
        PASSPORT_ORIGIN, can_follow_redirect, cookies_from_jar, is_safe_cookie_value,
        is_trusted_bilibili_url, is_valid_session_key, login_cookie,
    };

    /// The fix depends on reqwest storing `Set-Cookie` in the jar before the
    /// body is consumed. Prove it against a real response rather than assuming.
    #[tokio::test]
    async fn the_jar_is_populated_before_the_json_body_is_read() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            let body = br#"{"code":0,"data":{"code":0,"url":""}}"#;
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nSet-Cookie: SESSDATA=abc%2Cdef; Path=/\r\nSet-Cookie: bili_jct=csrf; Path=/\r\nContent-Length: 37\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
            stream.write_all(body).unwrap();
        });

        let jar = Arc::new(Jar::default());
        let client = reqwest::Client::builder()
            .cookie_provider(Arc::clone(&jar))
            .build()
            .unwrap();
        let response = client
            .get(format!("http://{address}/poll"))
            .send()
            .await
            .unwrap();
        // Consume the body exactly as `poll` does.
        let _ = response.text().await.unwrap();

        let url = Url::parse(&format!("http://{address}/")).unwrap();
        let stored = cookies_from_jar_at(&jar, &url);
        assert!(stored.contains("SESSDATA=abc%2Cdef"), "got: {stored}");
        assert!(stored.contains("bili_jct=csrf"), "got: {stored}");
        server.join().unwrap();
    }

    /// Read the jar for an arbitrary origin; `cookies_from_jar` is pinned to
    /// Bilibili's own hosts, which a loopback test server cannot use.
    fn cookies_from_jar_at(jar: &Arc<Jar>, url: &Url) -> String {
        use reqwest::cookie::CookieStore;
        jar.cookies(url)
            .map(|header| header.to_str().unwrap_or_default().to_string())
            .unwrap_or_default()
    }

    #[test]
    fn only_bilibili_origins_are_read_from_the_jar() {
        // A cookie set by an unrelated host must never enter the stored header.
        let jar = Arc::new(Jar::default());
        jar.add_cookie_str(
            "SESSDATA=evil; Path=/",
            &Url::parse("https://evil.test/").unwrap(),
        );
        assert!(cookies_from_jar(&jar).is_empty());
    }

    fn jar_with(cookies: &[&str]) -> Arc<Jar> {
        let jar = Arc::new(Jar::default());
        let url = Url::parse(PASSPORT_ORIGIN).unwrap();
        for cookie in cookies {
            jar.add_cookie_str(cookie, &url);
        }
        jar
    }

    #[test]
    fn poll_set_cookie_headers_alone_complete_the_login() {
        // The regression: Bilibili confirmed the scan but returned a callback
        // URL without credentials, so only `Set-Cookie` carried the session.
        let jar = jar_with(&[
            "SESSDATA=abc%2Cdef%2Cghi; Domain=.bilibili.com; Path=/",
            "bili_jct=csrf; Domain=.bilibili.com; Path=/",
            "DedeUserID=42; Domain=.bilibili.com; Path=/",
        ]);

        let cookie = login_cookie(&jar, "https://www.bilibili.com/").unwrap();

        assert_eq!(
            cookie,
            "SESSDATA=abc%2Cdef%2Cghi; bili_jct=csrf; DedeUserID=42"
        );
    }

    #[test]
    fn callback_url_still_works_when_the_jar_is_empty() {
        let url = "https://passport.bilibili.com/account/api/login/sso?DedeUserID=42&SESSDATA=abc%2Cdef%2Cghi&bili_jct=csrf&gourl=https%3A%2F%2Fwww.bilibili.com";

        let cookie = login_cookie(&jar_with(&[]), url).unwrap();

        assert_eq!(
            cookie,
            "SESSDATA=abc%2Cdef%2Cghi; bili_jct=csrf; DedeUserID=42"
        );
    }

    #[test]
    fn jar_and_callback_fields_are_merged_with_the_jar_winning() {
        let jar = jar_with(&["SESSDATA=from-jar; Domain=.bilibili.com; Path=/"]);
        let url =
            "https://passport.bilibili.com/?SESSDATA=from-url&bili_jct=csrf&DedeUserID__ckMd5=md5";

        let cookie = login_cookie(&jar, url).unwrap();

        assert_eq!(
            cookie,
            "SESSDATA=from-jar; bili_jct=csrf; DedeUserID__ckMd5=md5"
        );
    }

    #[test]
    fn login_requires_sessdata_from_either_source() {
        let jar = jar_with(&["buvid3=tracking-only; Domain=.bilibili.com; Path=/"]);
        assert!(login_cookie(&jar, "https://passport.bilibili.com/?DedeUserID=42").is_none());
    }

    #[test]
    fn unknown_cookie_fields_are_not_stored() {
        let jar = jar_with(&[
            "SESSDATA=abc; Domain=.bilibili.com; Path=/",
            "unrelated=value; Domain=.bilibili.com; Path=/",
        ]);

        let cookie = login_cookie(&jar, "https://passport.bilibili.com/?other=value").unwrap();

        assert_eq!(cookie, "SESSDATA=abc");
    }

    #[test]
    fn jar_values_are_stored_without_re_encoding() {
        // reqwest's jar does not decode a cookie value, so `SESSDATA` must be
        // passed through verbatim; encoding it again would yield `%252C`.
        let jar = jar_with(&["SESSDATA=abc%2Cdef%2Cghi; Domain=.bilibili.com; Path=/"]);

        assert_eq!(
            login_cookie(&jar, "https://www.bilibili.com/").unwrap(),
            "SESSDATA=abc%2Cdef%2Cghi"
        );
    }

    #[test]
    fn cookie_values_that_could_inject_a_second_field_are_dropped() {
        assert!(is_safe_cookie_value("abc%2Cdef"));
        assert!(!is_safe_cookie_value(""));
        assert!(!is_safe_cookie_value("abc; DedeUserID=1"));
        assert!(!is_safe_cookie_value("abc\r\nSet-Cookie: x=y"));

        // An already-encoded value stays usable.
        assert!(is_safe_cookie_value("a%20b"));

        // A crafted callback URL must not smuggle an extra field into the
        // stored header.
        let jar = jar_with(&["SESSDATA=abc; Domain=.bilibili.com; Path=/"]);
        let cookie = login_cookie(&jar, "https://passport.bilibili.com/?bili_jct=a b").unwrap();
        assert_eq!(cookie, "SESSDATA=abc");
    }

    #[test]
    fn only_bilibili_https_hosts_are_followed() {
        let trusted = Url::parse("https://passport.bilibili.com/x/").unwrap();
        assert!(is_trusted_bilibili_url(&trusted));
        assert!(can_follow_redirect(&trusted, 0));
        assert!(!can_follow_redirect(&trusted, 8));
        assert!(!is_trusted_bilibili_url(
            &Url::parse("http://passport.bilibili.com/").unwrap()
        ));
        assert!(!is_trusted_bilibili_url(
            &Url::parse("https://bilibili.com.evil.test/").unwrap()
        ));
    }

    #[test]
    fn session_keys_are_local_uuid_handles() {
        assert!(is_valid_session_key("0123456789abcdef0123456789abcdef"));
        // Bilibili's own `qrcode_key` must no longer be accepted as a handle.
        assert!(!is_valid_session_key("short"));
        assert!(!is_valid_session_key("0123456789abcdef0123456789abcdeZ"));
    }
}
