//! Bilibili TV 扫码取得的 APP 凭据、独立存储与个性化推荐请求。
//!
//! Web Cookie 登录不参与此流程。上游扫码凭据只保留在进程内会话表中，
//! APP 令牌只交给 Rust 调用方；错误信息不包含请求、响应或任何凭据。

use std::sync::Arc;
use std::time::Duration;

use md5::{Digest, Md5};
use reqwest::cookie::Jar;
use reqwest::header::{ACCEPT, REFERER, USER_AGENT};
use reqwest::{Client, Url};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use uuid::Uuid;

use crate::account::qr::{
    QrSessionStore, QrSite, build_login_client, is_trusted_url, is_valid_session_key,
};
use crate::error::{AppError, AppResult};

pub use crate::account::qr::QrLoginStart;

const SITE: QrSite = QrSite {
    id: "bilibili_app",
    display: "哔哩哔哩 APP",
};
const TRUSTED_SUFFIXES: &[&str] = &["bilibili.com"];
const APP_KEY: &str = "4409e2ce8ffd12b8";
const APP_SECRET: &str = "59b43e04ad6965f34319062b478f83dd";
const AUTH_CODE_URL: &str = "https://passport.bilibili.com/x/passport-tv-login/qrcode/auth_code";
const POLL_URL: &str = "https://passport.bilibili.com/x/passport-tv-login/qrcode/poll";
const OAUTH_INFO_URL: &str = "https://passport.bilibili.com/x/passport-login/oauth2/info";
const FEED_URL: &str = "https://app.bilibili.com/x/v2/feed/index";
const STORY_URL: &str = "https://app.bilibili.com/x/v2/feed/index/story";
const REFERER_VALUE: &str = "https://www.bilibili.com/";
const USER_AGENT_VALUE: &str = "Mozilla/5.0 BiliDroid/8.0.0 (Linux; Android 13)";
const MAX_TOKEN_LEN: usize = 512;
const MAX_QR_URL_LEN: usize = 4096;
// 已验证 TV 凭据有效期为 180 天；允许服务端调整到一年以内，但不接受无限期。
const MAX_EXPIRES_IN: i64 = 366 * 24 * 60 * 60;

/// 仅供 Rust 使用的 APP 凭据，不提供调试输出或序列化实现。
#[derive(Clone)]
pub struct AppCredential {
    pub(crate) access_token: String,
    pub(crate) refresh_token: String,
    pub(crate) mid: String,
    pub(crate) expires_at: i64,
}

/// 到达截止秒即过期；非法的非正截止时间也视为过期。
///
/// 仅作为会话中途的廉价守卫（见 [`AppAuth::feed`]）：上游 feed 对无效令牌也返回
/// `code=0`（静默降级匿名流），本地检查是长时间运行期间唯一能在令牌到期后报错
/// 而非静默换流的机制。凭据是否仍被接受以服务端结论为准。
fn expiry_reached(expires_at: i64, now: i64) -> bool {
    expires_at <= 0 || now >= expires_at
}

/// 从独立凭据表读取，不访问 Cookie、设置或配置导出数据。
pub fn load(conn: &Connection) -> AppResult<Option<AppCredential>> {
    let credential = conn
        .query_row(
            "SELECT access_token, refresh_token, mid, expires_at
             FROM bilibili_app_auth WHERE singleton = 1",
            [],
            |row| {
                Ok(AppCredential {
                    access_token: row.get(0)?,
                    refresh_token: row.get(1)?,
                    mid: row.get(2)?,
                    expires_at: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|_| storage_error())?;
    if let Some(credential) = credential.as_ref()
        && !valid_credential_fields(credential)
    {
        return Err(auth_required());
    }
    Ok(credential)
}

/// 原子替换唯一一行 APP 凭据，不保存扫码响应中的 Cookie 信息。
pub fn save(conn: &Connection, credential: &AppCredential) -> AppResult<()> {
    if !valid_credential_fields(credential) {
        return Err(auth_required());
    }
    conn.execute(
        "INSERT INTO bilibili_app_auth
            (singleton, access_token, refresh_token, mid, expires_at)
         VALUES (1, ?1, ?2, ?3, ?4)
         ON CONFLICT(singleton) DO UPDATE SET
            access_token = excluded.access_token,
            refresh_token = excluded.refresh_token,
            mid = excluded.mid,
            expires_at = excluded.expires_at",
        params![
            credential.access_token,
            credential.refresh_token,
            credential.mid,
            credential.expires_at
        ],
    )
    .map_err(|_| storage_error())?;
    Ok(())
}

/// 仅显式退出 APP 登录时清除；网络失败不调用此函数。
pub fn clear(conn: &Connection) -> AppResult<()> {
    conn.execute("DELETE FROM bilibili_app_auth WHERE singleton = 1", [])
        .map_err(|_| storage_error())?;
    Ok(())
}

pub enum AppQrPoll {
    Pending,
    Scanned,
    Expired,
    Success(AppCredential),
}

#[derive(Clone)]
struct QrSession {
    auth_code: String,
}

static SESSIONS: QrSessionStore<QrSession> = QrSessionStore::new(SITE);

/// 生成 APP 登录二维码，只对外暴露可信二维码地址与本地不透明句柄。
pub async fn start() -> AppResult<QrLoginStart> {
    let query = sign_params(&[("local_id", "0".into())], None, now());
    let response = login_client()?
        .post(AUTH_CODE_URL)
        .header(USER_AGENT, USER_AGENT_VALUE)
        .header(REFERER, REFERER_VALUE)
        .header(ACCEPT, "application/json")
        .form(&query)
        .send()
        .await
        .map_err(|_| qr_unavailable("generate"))?;
    if !response.status().is_success() {
        return Err(qr_unavailable("generate"));
    }
    let value: Value = response
        .json()
        .await
        .map_err(|_| qr_unavailable("generate"))?;
    let (qr_code_url, auth_code) = parse_start(&value)?;
    let qr_key = Uuid::new_v4().simple().to_string();
    SESSIONS.insert(qr_key.clone(), QrSession { auth_code })?;
    Ok(QrLoginStart {
        qr_code_url,
        qr_key,
    })
}

pub async fn poll(qr_key: &str) -> AppResult<AppQrPoll> {
    if !is_valid_session_key(qr_key) {
        return Err(SITE.error("invalid_key", "APP 登录二维码无效，请刷新二维码"));
    }
    let session = match SESSIONS.get(qr_key) {
        Ok(session) => session,
        Err(error) if error.code == "bilibili_app_qr_expired" => return Ok(AppQrPoll::Expired),
        Err(error) => return Err(error),
    };
    let query = sign_params(
        &[("auth_code", session.auth_code), ("local_id", "0".into())],
        None,
        now(),
    );
    let response = login_client()?
        .post(POLL_URL)
        .header(USER_AGENT, USER_AGENT_VALUE)
        .header(REFERER, REFERER_VALUE)
        .header(ACCEPT, "application/json")
        .form(&query)
        .send()
        .await
        .map_err(|_| qr_unavailable("poll"))?;
    if !response.status().is_success() {
        return Err(qr_unavailable("poll"));
    }
    let value: Value = response.json().await.map_err(|_| qr_unavailable("poll"))?;
    finish_poll(qr_key, &value, now())
}

/// 在调用方持有数据库锁时原子消费成功会话，随后才能保存凭据。
/// 已取消、过期或已被其他轮询消费的会话不得重新写回登录状态。
pub fn finish(qr_key: &str) -> AppResult<()> {
    if !is_valid_session_key(qr_key) {
        return Err(SITE.error("invalid_key", "APP 登录二维码无效，请刷新二维码"));
    }
    SESSIONS.take(qr_key).map(|_| ())
}

/// 在调用方持有数据库锁时取消全部未完成扫码，随后再清除已保存凭据。
pub fn cancel_all() -> AppResult<()> {
    SESSIONS.clear()
}

/// 远端校验结果。
///
/// `expires_at` 是服务端权威的绝对到期秒（按本机时钟换算），仅在服务端
/// 返回 `expires_in` 时存在。不包含任何凭据值。
pub struct AppValidation {
    pub expires_at: Option<i64>,
}

/// 校验凭据是否仍被服务端接受，并取得权威到期时间。
///
/// 刻意不用本机时钟做前置判断：时钟被调快时本地判断会把仍然有效的凭据报成
/// 过期，用户为一个时钟问题白跑一次扫码。凭据**格式**仍在此拒绝，非法格式
/// 不必联网。是否真的过期以服务端结论为准。
pub async fn validate(credential: &AppCredential) -> AppResult<AppValidation> {
    if !valid_credential_fields(credential) {
        return Err(auth_required());
    }
    fetch_oauth_info(credential).await
}

async fn fetch_oauth_info(credential: &AppCredential) -> AppResult<AppValidation> {
    let query = sign_params(&[], Some(&credential.access_token), now());
    let response = login_client()
        .map_err(|_| auth_unavailable())?
        .get(OAUTH_INFO_URL)
        .header(USER_AGENT, USER_AGENT_VALUE)
        .header(REFERER, REFERER_VALUE)
        .header(ACCEPT, "application/json")
        .query(&query)
        .send()
        .await
        .map_err(|_| auth_unavailable())?;
    // HTTP 错误本身不足以证明令牌失效，不因网关或风控响应清除登录。
    if !response.status().is_success() {
        return Err(auth_unavailable());
    }
    let value: Value = response.json().await.map_err(|_| auth_unavailable())?;
    parse_oauth_info(&value, credential, now())
}

/// 已验证的 APP 请求上下文；不持有 Web Cookie 或用于续期的令牌。
pub struct AppAuth {
    client: Client,
    access_token: String,
    /// 已知的权威到期秒；服务端未给寿命时为 `None`，表示不设本地期限。
    expires_at: Option<i64>,
}

impl AppAuth {
    /// 先直连验证一次，再为推荐请求应用显式代理；禁止环境代理与重定向。
    pub async fn new(credential: AppCredential, proxy: Option<&str>) -> AppResult<Self> {
        let validation = validate(&credential).await?;
        // 服务端寿命是权威值。服务端确认有效但未给寿命时**不**回退本地值：
        // 本机时钟可能偏快，拿一个已过的本地期限会让紧随其后的 feed 立刻拒绝
        // 一个刚刚被服务端接受的令牌。
        let expires_at = validation.expires_at;
        let builder = Client::builder()
            .use_native_tls()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(20))
            .connect_timeout(Duration::from_secs(10))
            .gzip(true)
            .brotli(true);
        let client = crate::http_client::with_proxy(builder, proxy)
            .map_err(|_| auth_unavailable())?
            .build()
            .map_err(|_| auth_unavailable())?;
        Ok(Self {
            client,
            access_token: credential.access_token,
            expires_at,
        })
    }

    /// 仅请求 APP 推荐与短视频推荐两个固定地址；失败绝不回退匿名请求。
    pub async fn feed(
        &self,
        path: &str,
        query: &[(&str, String)],
        buvid: &str,
    ) -> AppResult<String> {
        let endpoint = feed_endpoint(path)?;
        if self.expires_at.is_some_and(|at| expiry_reached(at, now())) {
            return Err(auth_required());
        }
        if !valid_opaque(buvid, 256) {
            return Err(AppError::new(
                "bilibili_app_feed_device",
                "无法取得 App 推荐所需的设备标识，请稍后重试",
            )
            .with_site("bilibili")
            .retryable());
        }
        let query = sign_params(query, Some(&self.access_token), now());
        let response = self
            .client
            .get(endpoint)
            .header(USER_AGENT, USER_AGENT_VALUE)
            .header(REFERER, REFERER_VALUE)
            .header(ACCEPT, "application/json")
            .header("buvid", buvid)
            .query(&query)
            .send()
            .await
            .map_err(|_| auth_unavailable())?;
        if !response.status().is_success() {
            return Err(auth_unavailable());
        }
        let body = response.text().await.map_err(|_| auth_unavailable())?;
        check_feed_body(&body)?;
        Ok(body)
    }
}

/// 剔除调用方的认证字段，按键排序并对表单编码后的原始字节签名。
/// 返回值含机密，不应写入日志、错误或传给前端。
pub fn sign_params(
    query: &[(&str, String)],
    access_key: Option<&str>,
    ts: i64,
) -> Vec<(String, String)> {
    let mut params: Vec<(String, String)> = query
        .iter()
        .filter(|(key, _)| !matches!(*key, "sign" | "appkey" | "ts" | "access_key"))
        .map(|(key, value)| ((*key).to_owned(), value.clone()))
        .collect();
    params.push(("appkey".into(), APP_KEY.into()));
    params.push(("ts".into(), ts.to_string()));
    if let Some(access_key) = access_key {
        params.push(("access_key".into(), access_key.to_owned()));
    }
    params.sort_by(|a, b| a.0.cmp(&b.0));
    // Url 的 query_pairs_mut 使用 form_urlencoded，与 reqwest 的 form/query 一致。
    let mut url = Url::parse(FEED_URL).expect("固定 APP 地址必须合法");
    url.query_pairs_mut().extend_pairs(&params);
    let mut digest = Md5::new();
    digest.update(url.query().unwrap_or_default().as_bytes());
    digest.update(APP_SECRET.as_bytes());
    params.push(("sign".into(), hex::encode(digest.finalize())));
    params
}

fn login_client() -> AppResult<Client> {
    // 公共构建器要求 Jar，但每个请求都新建且随客户端丢弃，绝不复用 Web 会话，
    // 也不读取、返回或持久化 Set-Cookie / cookie_info。
    build_login_client(SITE, Arc::new(Jar::default()), TRUSTED_SUFFIXES, true, None)
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn parse_start(value: &Value) -> AppResult<(String, String)> {
    if api_code(value) != Some(0) {
        return Err(qr_unavailable("generate"));
    }
    let data = &value["data"];
    let auth_code = data["auth_code"]
        .as_str()
        .filter(|value| valid_opaque(value, MAX_TOKEN_LEN))
        .ok_or_else(|| qr_unavailable("generate"))?;
    let qr_url = data["url"]
        .as_str()
        .filter(|value| {
            !value.is_empty()
                && value.len() <= MAX_QR_URL_LEN
                && !value.chars().any(char::is_whitespace)
                && !value.chars().any(char::is_control)
        })
        .ok_or_else(|| qr_unavailable("generate"))?;
    let url = Url::parse(qr_url).map_err(|_| qr_unavailable("generate"))?;
    if !is_trusted_url(&url, TRUSTED_SUFFIXES) {
        return Err(qr_unavailable("generate"));
    }
    Ok((qr_url.to_owned(), auth_code.to_owned()))
}

fn finish_poll(qr_key: &str, value: &Value, now: i64) -> AppResult<AppQrPoll> {
    // 过期立即清理；成功留给命令层在数据库锁内用 finish 原子消费，
    // 避免退出登录后的迟到响应或并行成功轮询再次保存凭据。
    if api_code(value) == Some(86_038) {
        SESSIONS.remove(qr_key)?;
    }
    parse_poll(value, now)
}

fn parse_poll(value: &Value, now: i64) -> AppResult<AppQrPoll> {
    match api_code(value) {
        Some(86_039) => Ok(AppQrPoll::Pending),
        Some(86_090) => Ok(AppQrPoll::Scanned),
        Some(86_038) => Ok(AppQrPoll::Expired),
        Some(0) => parse_credential(&value["data"], now).map(AppQrPoll::Success),
        _ => Err(qr_unavailable("poll")),
    }
}

fn parse_credential(data: &Value, now: i64) -> AppResult<AppCredential> {
    let token = match data.get("token_info") {
        Some(token) => token,
        None => data,
    };
    let access_token = token["access_token"]
        .as_str()
        .filter(|value| valid_opaque(value, MAX_TOKEN_LEN))
        .ok_or_else(|| qr_unavailable("credential"))?;
    let refresh_token = token["refresh_token"]
        .as_str()
        .filter(|value| valid_opaque(value, MAX_TOKEN_LEN))
        .ok_or_else(|| qr_unavailable("credential"))?;
    let mid = parse_mid(&token["mid"]).ok_or_else(|| qr_unavailable("credential"))?;
    let expires_in = nonnegative_integer(&token["expires_in"])
        .and_then(|value| i64::try_from(value).ok())
        .filter(|value| (1..=MAX_EXPIRES_IN).contains(value))
        .ok_or_else(|| qr_unavailable("credential"))?;
    let expires_at = now
        .checked_add(expires_in)
        .filter(|value| now >= 0 && *value > now)
        .ok_or_else(|| qr_unavailable("credential"))?;
    Ok(AppCredential {
        access_token: access_token.to_owned(),
        refresh_token: refresh_token.to_owned(),
        mid,
        expires_at,
    })
}

/// 解析 `oauth2/info` 响应。`expires_in` 是服务端给的**剩余**寿命，实测每秒递减
/// （相隔 45 秒的两次请求差 47 秒），换算成本机时钟下的绝对到期即为权威值，
/// 可以纠正本机时钟偏差。
fn parse_oauth_info(
    value: &Value,
    credential: &AppCredential,
    now: i64,
) -> AppResult<AppValidation> {
    require_success_code(value, true)?;
    let data = &value["data"];
    let mid = parse_mid(&data["mid"]).ok_or_else(auth_unavailable)?;
    if mid != credential.mid {
        return Err(auth_required());
    }
    let Some(raw_expires_in) = data.get("expires_in") else {
        return Ok(AppValidation { expires_at: None });
    };
    let expires_in = nonnegative_integer(raw_expires_in).ok_or_else(auth_unavailable)?;
    if expires_in == 0 {
        return Err(auth_required());
    }
    // 超过上限只截断、不拒绝：上游延长寿命时功能应当继续可用，
    // 而每次使用前都会重新做远端校验，截断不会让凭据被滥用。
    let expires_in = i64::try_from(expires_in)
        .unwrap_or(MAX_EXPIRES_IN)
        .min(MAX_EXPIRES_IN);
    let expires_at = now
        .checked_add(expires_in)
        .filter(|value| now >= 0 && *value > now)
        .ok_or_else(auth_unavailable)?;
    Ok(AppValidation {
        expires_at: Some(expires_at),
    })
}

fn check_feed_body(body: &str) -> AppResult<()> {
    let value: Value = serde_json::from_str(body).map_err(|_| auth_unavailable())?;
    require_success_code(&value, false)
}

/// 把上游业务码映射成错误。
///
/// `bad_request_means_invalid` 用于 `oauth2/info`：实测它对**格式合法但不存在**的
/// access_key（含随机 32 位字符串）一律返回 `-400`，与真正的参数错误（缺 `ts`、
/// 空 `appkey`）同码。区分依据是凭据格式：能走到这里的凭据已通过
/// [`valid_credential_fields`]，而请求参数由 [`sign_params`] 保证，因此 `-400`
/// 只能来自服务端拒绝该凭据。不区分时随机坏 token 会被报成「服务暂不可用」，
/// 用户重试永远不会成功。
///
/// feed 端点实测对无效令牌、错签名、错 appkey 都返回 `code=0`（静默降级匿名流），
/// 无法用于检测，因此只有 `oauth2/info` 传 `true`。
fn require_success_code(value: &Value, bad_request_means_invalid: bool) -> AppResult<()> {
    match api_code(value) {
        Some(0) => Ok(()),
        // 61000 是已验证的无效令牌响应，-101 明确表示未登录。
        Some(61_000 | -101) => Err(auth_required()),
        Some(-400) if bad_request_means_invalid => Err(auth_required()),
        // 风控、签名问题、服务故障和未知协议都不能断言凭据已失效。
        _ => Err(auth_unavailable()),
    }
}

fn api_code(value: &Value) -> Option<i64> {
    value.get("code")?.as_i64()
}

fn feed_endpoint(path: &str) -> AppResult<&'static str> {
    match path {
        "" => Ok(FEED_URL),
        "/story" => Ok(STORY_URL),
        _ => Err(
            AppError::new("bilibili_app_feed_path", "不支持的 APP 推荐路径").with_site("bilibili"),
        ),
    }
}

fn valid_credential_fields(credential: &AppCredential) -> bool {
    valid_opaque(&credential.access_token, MAX_TOKEN_LEN)
        && valid_opaque(&credential.refresh_token, MAX_TOKEN_LEN)
        && parse_mid(&Value::String(credential.mid.clone())).as_deref()
            == Some(credential.mid.as_str())
        && credential.expires_at > 0
}

fn valid_opaque(value: &str, max_len: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn nonnegative_integer(value: &Value) -> Option<u64> {
    if let Some(text) = value.as_str() {
        if text.is_empty() || text.len() > 20 || !text.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        text.parse().ok()
    } else {
        value.as_u64()
    }
}

fn parse_mid(value: &Value) -> Option<String> {
    nonnegative_integer(value)
        .filter(|mid| *mid > 0)
        .map(|mid| mid.to_string())
}

fn auth_required() -> AppError {
    AppError::new(
        "bilibili_app_auth_required",
        "APP 登录已失效或未授权，请重新扫码登录",
    )
    .with_site("bilibili")
}

fn auth_unavailable() -> AppError {
    AppError::new(
        "bilibili_app_auth_unavailable",
        "APP 登录或推荐服务暂不可用，请稍后重试",
    )
    .with_site("bilibili")
    .retryable()
}

fn storage_error() -> AppError {
    AppError::new("bilibili_app_auth_storage", "APP 登录凭据存储操作失败").with_site("bilibili")
}

fn qr_unavailable(suffix: &str) -> AppError {
    SITE.retryable_error(suffix, "APP 扫码登录服务暂不可用，请稍后重试")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::open_in_memory;
    use serde_json::json;

    const NOW: i64 = 1_700_000_000;
    const LIFETIME: i64 = 15_552_000;
    const TEST_TOKEN: &str = "test-only-sensitive-access-token";

    fn token_data() -> Value {
        json!({
            "access_token": TEST_TOKEN,
            "refresh_token": "test-only-sensitive-refresh-token",
            "expires_in": LIFETIME,
            "mid": 42
        })
    }

    fn credential() -> AppCredential {
        parse_credential(&token_data(), NOW).unwrap()
    }

    fn error_of<T>(result: AppResult<T>) -> AppError {
        match result {
            Err(error) => error,
            Ok(_) => panic!("应返回脱敏错误"),
        }
    }

    #[test]
    fn signature_has_a_fixed_sorted_form_encoded_vector() {
        let query = [
            ("z", "a b+c/中~!".into()),
            ("a", "&=".into()),
            ("local_id", "0".into()),
        ];
        let signed = sign_params(&query, Some("test_token-123"), NOW);
        let mut url = Url::parse(FEED_URL).unwrap();
        url.query_pairs_mut()
            .extend_pairs(&signed[..signed.len() - 1]);
        assert_eq!(
            url.query().unwrap(),
            "a=%26%3D&access_key=test_token-123&appkey=4409e2ce8ffd12b8&local_id=0&ts=1700000000&z=a+b%2Bc%2F%E4%B8%AD%7E%21"
        );
        assert_eq!(signed.last().unwrap().0, "sign");
        assert_eq!(signed.last().unwrap().1, "710724c932ce859742449e6aa563df01");
    }

    #[test]
    fn signature_replaces_foreign_authentication_fields() {
        let injected = [
            ("sign", "foreign-sign".into()),
            ("appkey", "foreign-key".into()),
            ("ts", "1".into()),
            ("access_key", "foreign-token".into()),
            ("access_key", "second-foreign-token".into()),
            ("local_id", "0".into()),
        ];
        assert_eq!(
            sign_params(&injected, Some(TEST_TOKEN), NOW),
            sign_params(&[("local_id", "0".into())], Some(TEST_TOKEN), NOW)
        );
        assert_eq!(
            sign_params(&injected, None, NOW),
            sign_params(&[("local_id", "0".into())], None, NOW)
        );
        let reordered = [("z", "last".into()), ("a", "first".into())];
        let ordered = [("a", "first".into()), ("z", "last".into())];
        assert_eq!(
            sign_params(&reordered, None, NOW),
            sign_params(&ordered, None, NOW)
        );
    }

    #[test]
    fn qr_generation_only_accepts_trusted_https_urls_and_safe_keys() {
        let response =
            |url: &str, code: &str| json!({"code": 0, "data": {"url": url, "auth_code": code}});
        assert!(
            parse_start(&response(
                "https://passport.bilibili.com/qr?x=1",
                "safe_123"
            ))
            .is_ok()
        );
        for url in [
            "http://bilibili.com/qr",
            "https://bilibili.com.evil.test/qr",
            "https://evil-bilibili.com/qr",
            "https://user:pass@bilibili.com/qr",
            "https://bilibili.com:8443/qr",
            "https://bilibili.com/qr\r\n",
        ] {
            assert!(parse_start(&response(url, "safe_123")).is_err());
        }
        for key in ["", "a&b", "a\nb", "令牌"] {
            assert!(parse_start(&response("https://bilibili.com/qr", key)).is_err());
        }
        assert!(
            parse_start(&response(
                "https://bilibili.com/qr",
                &"x".repeat(MAX_TOKEN_LEN + 1)
            ))
            .is_err()
        );
        let huge_url = format!("https://bilibili.com/{}", "x".repeat(MAX_QR_URL_LEN));
        assert!(parse_start(&response(&huge_url, "safe")).is_err());
    }

    #[test]
    fn tv_poll_codes_and_token_shapes_are_mapped() {
        assert!(matches!(
            parse_poll(&json!({"code": 86039}), NOW).unwrap(),
            AppQrPoll::Pending
        ));
        assert!(matches!(
            parse_poll(&json!({"code": 86090}), NOW).unwrap(),
            AppQrPoll::Scanned
        ));
        assert!(matches!(
            parse_poll(&json!({"code": 86038}), NOW).unwrap(),
            AppQrPoll::Expired
        ));
        for data in [
            token_data(),
            json!({"token_info": token_data(), "cookie_info": {"cookies": [{"name": "SESSDATA", "value": "ignored"}]}}),
        ] {
            let AppQrPoll::Success(credential) =
                parse_poll(&json!({"code": 0, "data": data}), NOW).unwrap()
            else {
                panic!("应取得 APP 凭据");
            };
            assert_eq!(credential.access_token, TEST_TOKEN);
            assert_eq!(credential.mid, "42");
            assert_eq!(credential.expires_at, NOW + LIFETIME);
        }
        for response in [
            json!({}),
            json!({"code": 86101}),
            json!({"code": -500}),
            json!({"code": 0}),
        ] {
            assert!(parse_poll(&response, NOW).is_err());
        }
    }

    #[test]
    fn successful_sessions_require_atomic_finish_and_cancellation_wins() {
        let expired_key = Uuid::new_v4().simple().to_string();
        SESSIONS
            .insert(
                expired_key.clone(),
                QrSession {
                    auth_code: "server-only".into(),
                },
            )
            .unwrap();
        finish_poll(&expired_key, &json!({"code": 86038}), NOW).unwrap();
        assert!(SESSIONS.get(&expired_key).is_err());

        let key = Uuid::new_v4().simple().to_string();
        SESSIONS
            .insert(
                key.clone(),
                QrSession {
                    auth_code: "server-only".into(),
                },
            )
            .unwrap();
        finish_poll(&key, &json!({"code": 86039}), NOW).unwrap();
        assert!(SESSIONS.get(&key).is_ok());
        let success = json!({"code": 0, "data": token_data()});
        finish_poll(&key, &success, NOW).unwrap();
        finish_poll(&key, &success, NOW).unwrap();
        assert!(SESSIONS.get(&key).is_ok());
        finish(&key).unwrap();
        assert!(finish(&key).is_err());

        let cancelled_key = Uuid::new_v4().simple().to_string();
        SESSIONS
            .insert(
                cancelled_key.clone(),
                QrSession {
                    auth_code: "server-only".into(),
                },
            )
            .unwrap();
        cancel_all().unwrap();
        // 已发出的请求仍可能返回成功，但命令层不能再通过 finish 写回。
        finish_poll(&cancelled_key, &success, NOW).unwrap();
        assert!(finish(&cancelled_key).is_err());
        assert!(finish("upstream-key").is_err());
    }

    #[test]
    fn malformed_token_fields_are_rejected_without_echoing_them() {
        for field in ["access_token", "refresh_token"] {
            for value in [
                json!(""),
                json!("a b"),
                json!("a\r\nb"),
                json!("a&b"),
                json!("令牌"),
                json!("x".repeat(MAX_TOKEN_LEN + 1)),
                json!(null),
                json!(42),
            ] {
                let mut data = token_data();
                data[field] = value;
                let error = error_of(parse_credential(&data, NOW));
                assert!(!format!("{error:?}").contains(TEST_TOKEN));
            }
        }
        for value in [
            json!(0),
            json!(-1),
            json!("+42"),
            json!("42\n"),
            json!("4.2"),
            json!(1.5),
            json!("18446744073709551616"),
            json!(null),
        ] {
            let mut data = token_data();
            data["mid"] = value;
            assert!(parse_credential(&data, NOW).is_err());
        }
        let mut data = token_data();
        data["mid"] = json!("00042");
        assert_eq!(parse_credential(&data, NOW).unwrap().mid, "42");
        data["mid"] = json!(u64::MAX);
        assert_eq!(
            parse_credential(&data, NOW).unwrap().mid,
            u64::MAX.to_string()
        );
    }

    #[test]
    fn token_expiry_has_strict_bounds_and_checked_addition() {
        for value in [
            json!(0),
            json!(-1),
            json!(MAX_EXPIRES_IN + 1),
            json!(i64::MAX),
            json!(u64::MAX),
            json!("1e9"),
            json!(" 100 "),
            json!(1.5),
            json!(null),
        ] {
            let mut data = token_data();
            data["expires_in"] = value;
            assert!(parse_credential(&data, NOW).is_err());
        }
        assert!(parse_credential(&token_data(), i64::MAX - 1).is_err());
        assert!(parse_credential(&token_data(), -1).is_err());
        let mut data = token_data();
        data["expires_in"] = json!("1");
        let credential = parse_credential(&data, NOW).unwrap();
        assert!(!expiry_reached(credential.expires_at, NOW));
        assert!(expiry_reached(credential.expires_at, NOW + 1));
        assert!(expiry_reached(credential.expires_at, i64::MAX));
        let invalid = AppCredential {
            expires_at: 0,
            ..credential
        };
        assert!(expiry_reached(invalid.expires_at, -1));
    }

    #[test]
    fn credentials_crud_is_separate_from_web_cookies() {
        let conn = open_in_memory().unwrap();
        assert!(load(&conn).unwrap().is_none());
        let credential = credential();
        save(&conn, &credential).unwrap();
        let loaded = load(&conn).unwrap().unwrap();
        assert_eq!(loaded.access_token, credential.access_token);
        assert_eq!(loaded.refresh_token, credential.refresh_token);
        assert_eq!(loaded.mid, credential.mid);
        assert_eq!(loaded.expires_at, credential.expires_at);
        let replacement = AppCredential {
            access_token: "replacement".into(),
            ..credential
        };
        save(&conn, &replacement).unwrap();
        assert_eq!(load(&conn).unwrap().unwrap().access_token, "replacement");
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM bilibili_app_auth", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM cookies", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        clear(&conn).unwrap();
        clear(&conn).unwrap();
        assert!(load(&conn).unwrap().is_none());
    }

    #[test]
    fn database_and_validation_errors_do_not_echo_token_values() {
        let conn = Connection::open_in_memory().unwrap();
        let credential = credential();
        let errors = [
            error_of(load(&conn)),
            error_of(save(&conn, &credential)),
            error_of(clear(&conn)),
            error_of(parse_oauth_info(
                &json!({"code": 61000, "message": TEST_TOKEN}),
                &credential,
                NOW,
            )),
            error_of(check_feed_body(&format!("not-json-{TEST_TOKEN}"))),
            error_of(feed_endpoint(TEST_TOKEN)),
        ];
        for error in errors {
            let text = format!("{error:?} {error}");
            assert!(!text.contains(TEST_TOKEN));
            assert!(!text.contains(&credential.refresh_token));
            assert!(!text.contains("https://"));
        }
    }

    #[test]
    fn oauth_distinguishes_invalid_credentials_from_retryable_failures() {
        let credential = credential();
        for data in [
            json!({"mid": 42}),
            json!({"mid": "42", "expires_in": LIFETIME}),
        ] {
            assert!(parse_oauth_info(&json!({"code": 0, "data": data}), &credential, NOW).is_ok());
        }
        for response in [
            json!({"code": 61000}),
            json!({"code": -101}),
            json!({"code": 0, "data": {"mid": 43}}),
            json!({"code": 0, "data": {"mid": 42, "expires_in": 0}}),
            // 实测：格式合法但不存在的 access_key（含随机 32 位字符串）返回 -400，
            // 与真正的参数错误同码。凭据已通过格式校验，所以只能判为已失效；
            // 否则用户会看到「稍后重试」而重试永远不会成功。
            json!({"code": -400}),
        ] {
            let error = error_of(parse_oauth_info(&response, &credential, NOW));
            assert_eq!(error.code, "bilibili_app_auth_required");
            assert!(!error.retryable);
        }
        for response in [
            json!({"code": -412}),
            json!({"code": 61001}),
            json!({"code": -500}),
            json!({"code": "0"}),
            json!({}),
            json!({"code": 0}),
            json!({"code": 0, "data": {"mid": "invalid"}}),
            json!({"code": 0, "data": {"mid": 42, "expires_in": "invalid"}}),
        ] {
            let error = error_of(parse_oauth_info(&response, &credential, NOW));
            assert_eq!(error.code, "bilibili_app_auth_unavailable");
            assert!(error.retryable);
        }
        // feed 路径不启用 -400 判定：实测它对无效令牌、错签名、错 appkey 都返回
        // code=0，任何非 0 码都不足以断言凭据失效。
        assert_eq!(
            error_of(check_feed_body(r#"{"code":-400}"#)).code,
            "bilibili_app_auth_unavailable"
        );
    }

    /// 服务端返回的剩余寿命是权威值：换算后写入 `expires_at`，可纠正本机时钟偏差。
    #[test]
    fn oauth_returns_authoritative_expiry_from_server_lifetime() {
        let credential = credential();
        let validation = parse_oauth_info(
            &json!({"code": 0, "data": {"mid": 42, "expires_in": 3600}}),
            &credential,
            NOW,
        )
        .unwrap();
        assert_eq!(validation.expires_at, Some(NOW + 3600));

        // 缺少 expires_in 时不猜测，交给调用方沿用本地值。
        let validation =
            parse_oauth_info(&json!({"code": 0, "data": {"mid": 42}}), &credential, NOW).unwrap();
        assert_eq!(validation.expires_at, None);

        // 上游延长寿命时截断到上限，而不是判为不可用。
        let validation = parse_oauth_info(
            &json!({"code": 0, "data": {"mid": 42, "expires_in": MAX_EXPIRES_IN * 2}}),
            &credential,
            NOW,
        )
        .unwrap();
        assert_eq!(validation.expires_at, Some(NOW + MAX_EXPIRES_IN));
    }

    #[tokio::test]
    async fn expired_credentials_and_invalid_paths_fail_without_network() {
        let expired = AppCredential {
            expires_at: 1,
            ..credential()
        };
        assert_eq!(
            error_of(validate(&expired).await).code,
            "bilibili_app_auth_required"
        );
        assert_eq!(
            error_of(AppAuth::new(expired, None).await).code,
            "bilibili_app_auth_required"
        );
        let auth = AppAuth {
            client: Client::builder().no_proxy().build().unwrap(),
            access_token: TEST_TOKEN.into(),
            expires_at: Some(1),
        };
        assert_eq!(
            error_of(auth.feed("", &[], "safe").await).code,
            "bilibili_app_auth_required"
        );
        // 服务端未给寿命时不设本地期限：已通过的远端校验不应被本机时钟推翻。
        let unknown_expiry = AppAuth {
            client: Client::builder().no_proxy().build().unwrap(),
            access_token: TEST_TOKEN.into(),
            expires_at: None,
        };
        // 路径校验仍生效，说明只是不做过期判断而不是整体放行。
        assert_eq!(
            error_of(unknown_expiry.feed("/../story", &[], "safe").await).code,
            "bilibili_app_feed_path"
        );
        for path in [
            "/story/",
            "/../story",
            "?x=1",
            "https://evil.test/",
            "//evil.test/",
        ] {
            assert_eq!(
                error_of(auth.feed(path, &[], "safe").await).code,
                "bilibili_app_feed_path"
            );
        }
        assert_eq!(feed_endpoint("").unwrap(), FEED_URL);
        assert_eq!(feed_endpoint("/story").unwrap(), STORY_URL);
        assert!(check_feed_body(r#"{"code":0,"data":{}}"#).is_ok());
        assert!(check_feed_body(r#"{"code":-412}"#).is_err());
        assert!(check_feed_body(r#"{"data":{}}"#).is_err());
    }
}
