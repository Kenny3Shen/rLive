//! Bilibili TV 扫码取得的 APP 凭据、独立存储与个性化推荐请求。
//!
//! Web Cookie 登录不参与此流程。上游扫码凭据只保留在进程内会话表中，
//! APP 令牌只交给 Rust 调用方；错误信息不包含请求、响应或任何凭据。

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;
use md5::{Digest, Md5};
use reqwest::cookie::Jar;
use reqwest::header::{ACCEPT, REFERER, USER_AGENT};
use reqwest::{Client, Url};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use tokio::sync::Mutex as AsyncMutex;
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
/// 刷新端点（实测确认）。注意与 `api/v2/oauth2/refresh_token` 区分：后者恒返回
/// `-101 账号未登录`，只有本路径接受 TV 凭据的 `refresh_token`。
const OAUTH_REFRESH_URL: &str =
    "https://passport.bilibili.com/x/passport-login/oauth2/refresh_token";
const FEED_URL: &str = "https://app.bilibili.com/x/v2/feed/index";
const STORY_URL: &str = "https://app.bilibili.com/x/v2/feed/index/story";
/// 直播首页推荐所在的 Web 域前缀；路径由 [`live_recommend_endpoint`] 白名单收窄。
const LIVE_RECOMMEND_BASE: &str = "https://api.live.bilibili.com/xlive/web-interface/v1";
/// 直播首页推荐的两个固定端点（相对 [`LIVE_RECOMMEND_BASE`]）。
const LIVE_HOME_PATH: &str = "/index/getList";
const LIVE_MORE_PATH: &str = "/webMain/getMoreRecList";
const REFERER_VALUE: &str = "https://www.bilibili.com/";
const USER_AGENT_VALUE: &str = "Mozilla/5.0 BiliDroid/8.0.0 (Linux; Android 13)";
const MAX_TOKEN_LEN: usize = 512;
const MAX_QR_URL_LEN: usize = 4096;
// 已验证 TV 凭据有效期为 180 天；允许服务端调整到一年以内，但不接受无限期。
const MAX_EXPIRES_IN: i64 = 366 * 24 * 60 * 60;
/// 最近一次成功远端校验的复用窗口。
///
/// 首页分页和推荐刷新会在短时间内重复创建站点实例。若每次都请求
/// `oauth2/info`，同一份凭据会被同一条慢链路串行验证多次；在当前实机上单次
/// 校验约 5.7 秒。这里只缓存服务端明确成功的结果，失败和风控响应永不缓存。
const AUTHORIZATION_VALIDATION_TTL: Duration = Duration::from_secs(5 * 60);

/// 仅供 Rust 使用的 APP 凭据，不提供调试输出或序列化实现。
#[derive(Clone)]
pub struct AppCredential {
    pub(crate) access_token: String,
    pub(crate) refresh_token: String,
    pub(crate) mid: String,
    pub(crate) expires_at: i64,
}

/// 一次服务端成功校验的短期结果。字段用于确认调用方仍使用同一账号、同一凭据和
/// 同一代理出口；缓存不得跨这些边界复用。
struct CachedAuthorization {
    source_access_token: String,
    source_refresh_token: String,
    source_mid: String,
    source_expires_at: i64,
    credential: AppCredential,
    route: crate::proxy::ProxyRoute,
    validated_at: Instant,
    /// 服务端在 `oauth2/info` 中返回的权威期限。`None` 表示本次校验未返回寿命，
    /// 此时只由短期缓存窗口约束。
    expires_at: Option<i64>,
}

impl CachedAuthorization {
    fn resolve(
        &self,
        credential: &AppCredential,
        route: &crate::proxy::ProxyRoute,
        now: i64,
    ) -> Option<AppAuthorization> {
        self.resolve_at(credential, route, now, Instant::now())
    }

    fn resolve_at(
        &self,
        credential: &AppCredential,
        route: &crate::proxy::ProxyRoute,
        now: i64,
        checked_at: Instant,
    ) -> Option<AppAuthorization> {
        let same_as_source = self.source_access_token == credential.access_token
            && self.source_refresh_token == credential.refresh_token
            && self.source_mid == credential.mid
            && self.source_expires_at == credential.expires_at;
        let same_as_resolved = self.credential.access_token == credential.access_token
            && self.credential.refresh_token == credential.refresh_token
            && self.credential.mid == credential.mid
            && self.credential.expires_at == credential.expires_at;
        if (!same_as_source && !same_as_resolved)
            || &self.route != route
            || checked_at.saturating_duration_since(self.validated_at)
                >= AUTHORIZATION_VALIDATION_TTL
            || self
                .expires_at
                .is_some_and(|expires_at| expiry_reached(expires_at, now))
        {
            return None;
        }
        Some(AppAuthorization {
            credential: self.credential.clone(),
            expires_at: self.expires_at,
            // 并发等待者持有的是刷新前快照。即使它们自己没有发起刷新，也必须
            // 把本轮轮换后的凭据落库，否则下一次进程启动仍会读旧 refresh token。
            renewed: same_as_source
                && (self.source_access_token != self.credential.access_token
                    || self.source_refresh_token != self.credential.refresh_token
                    || self.source_mid != self.credential.mid),
        })
    }
}

/// 同一时刻只允许一条远端授权校验在飞。分页或刷新并发到达时，等待者会在取得
/// 单飞锁后重新读取缓存，不再各自请求同一个慢端点。
static AUTHORIZATION_CHECK_GATE: AsyncMutex<()> = AsyncMutex::const_new(());
static AUTHORIZATION_CACHE: Mutex<Option<CachedAuthorization>> = Mutex::new(None);

fn cached_authorization(
    credential: &AppCredential,
    route: &crate::proxy::ProxyRoute,
    now: i64,
) -> Option<AppAuthorization> {
    let cache = AUTHORIZATION_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cache
        .as_ref()
        .and_then(|cached| cached.resolve(credential, route, now))
}

fn store_authorization(
    source: &AppCredential,
    mut credential: AppCredential,
    route: &crate::proxy::ProxyRoute,
    expires_at: Option<i64>,
) {
    // profile 会用 OAuth 权威寿命校正本地快照。缓存中的 resolved credential 必须
    // 同步采用该值，否则数据库校正后下一次授权会因 expires_at 不同再次走慢校验。
    if let Some(authoritative) = expires_at {
        credential.expires_at = authoritative;
    }
    let mut cache = AUTHORIZATION_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *cache = Some(CachedAuthorization {
        source_access_token: source.access_token.clone(),
        source_refresh_token: source.refresh_token.clone(),
        source_mid: source.mid.clone(),
        source_expires_at: source.expires_at,
        credential,
        route: route.clone(),
        validated_at: Instant::now(),
        expires_at,
    });
}

fn clear_authorization_cache() {
    let mut cache = AUTHORIZATION_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *cache = None;
}

fn invalidate_authorization(access_token: &str) {
    let mut cache = AUTHORIZATION_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if cache.as_ref().is_some_and(|cached| {
        cached.source_access_token == access_token || cached.credential.access_token == access_token
    }) {
        *cache = None;
    }
}

/// 距到期不足该时长时主动续期，而不是等失败后才补救。
///
/// 取一天：足够覆盖长时间运行的会话跨过到期点，又不会在每次启动时都白跑一次
/// 刷新（刷新会轮换 `refresh_token`，属于写操作）。
pub const REFRESH_AHEAD_SECS: i64 = 24 * 60 * 60;

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
    clear_authorization_cache();
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
pub async fn start(route: &crate::proxy::ProxyRoute) -> AppResult<QrLoginStart> {
    let query = sign_params(&[("local_id", "0".into())], None, now());
    let response = login_client(route)?
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

pub async fn poll(qr_key: &str, route: &crate::proxy::ProxyRoute) -> AppResult<AppQrPoll> {
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
    let response = login_client(route)?
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

/// 可用的授权结果。
///
/// 不落库：续期会轮换 `refresh_token`，保存由调用方负责（见 [`AppAuthorization::renewed`]）。
pub struct AppAuthorization {
    /// 用于后续请求的凭据；发生续期时是新的那一份。
    pub credential: AppCredential,
    /// 服务端权威到期秒；服务端未给寿命时为 `None`。
    pub expires_at: Option<i64>,
    /// 凭据是否被续期轮换。为 `true` 时调用方**必须**落库，否则下次仍用旧值。
    pub renewed: bool,
}

/// 距到期不足 [`REFRESH_AHEAD_SECS`] 时应当主动续期。
///
/// 只作为优化：本机时钟可能不准，因此「临近到期」不意味着凭据已失效，
/// 真正的权威判断仍在服务端。
fn needs_refresh(credential: &AppCredential, now: i64) -> bool {
    credential.expires_at > 0 && credential.expires_at - now <= REFRESH_AHEAD_SECS
}

/// 上次主动续期的时刻。用于避免本机时钟大幅偏快时每个请求都续期一次。
static LAST_PROACTIVE_REFRESH: AtomicI64 = AtomicI64::new(0);

/// 同一进程内两次主动续期的最小间隔。
const PROACTIVE_REFRESH_MIN_INTERVAL_SECS: i64 = 60 * 60;

fn proactive_refresh_allowed(now: i64) -> bool {
    let last = LAST_PROACTIVE_REFRESH.load(Ordering::Relaxed);
    last == 0 || now - last >= PROACTIVE_REFRESH_MIN_INTERVAL_SECS
}

/// 校验凭据，并在必要时用 `refresh_token` 续期。
///
/// 最多续期一次，两种触发条件：
/// 1. **主动**：本机时间显示临近到期 —— 省掉一次注定被拒的校验；
/// 2. **被动**：服务端明确拒绝了 access_token —— 此时 `refresh_token` 可能仍然
///    有效（实测：access_token 即使被换成垃圾值，刷新仍能取回可用凭据），
///    续期可以避免用户重新扫码。
///
/// 主动续期带进程内限速：本机时钟大幅偏快时 `needs_refresh` 会恒为真，
/// 不限速就会变成每个请求续期一次。被限速时直接走远端校验，凭据真失效时
/// 仍会由被动路径续期，因此限速不影响正确性。
pub async fn authorize(
    credential: AppCredential,
    route: &crate::proxy::ProxyRoute,
) -> AppResult<AppAuthorization> {
    authorize_with(
        credential,
        route,
        |credential, route| Box::pin(async move { validate(&credential, &route).await }),
        |credential, route| Box::pin(async move { refresh(&credential, &route).await }),
    )
    .await
}

/// `authorize` 的可注入核心，只用于把远端 I/O 替换成确定性的并发回归。
async fn authorize_with<V, R>(
    credential: AppCredential,
    route: &crate::proxy::ProxyRoute,
    validate_op: V,
    refresh_op: R,
) -> AppResult<AppAuthorization>
where
    V: Fn(AppCredential, crate::proxy::ProxyRoute) -> BoxFuture<'static, AppResult<AppValidation>>
        + Send
        + Sync,
    R: Fn(AppCredential, crate::proxy::ProxyRoute) -> BoxFuture<'static, AppResult<AppCredential>>
        + Send
        + Sync,
{
    if !valid_credential_fields(&credential) {
        return Err(auth_required());
    }
    let mut current = now();
    if let Some(authorization) = cached_authorization(&credential, route, current) {
        return Ok(authorization);
    }

    // 缓存未命中时单飞远端校验。必须持锁完成第二次缓存检查，避免同一轮分页的
    // 多个命令都在第一次检查后同时穿到网络请求。
    let _check_guard = AUTHORIZATION_CHECK_GATE.lock().await;
    current = now();
    if let Some(authorization) = cached_authorization(&credential, route, current) {
        return Ok(authorization);
    }

    if needs_refresh(&credential, current) && proactive_refresh_allowed(current) {
        let refreshed = refresh_op(credential.clone(), route.clone()).await?;
        LAST_PROACTIVE_REFRESH.store(current, Ordering::Relaxed);
        store_authorization(
            &credential,
            refreshed.clone(),
            route,
            Some(refreshed.expires_at),
        );
        return Ok(AppAuthorization {
            expires_at: Some(refreshed.expires_at),
            credential: refreshed,
            renewed: true,
        });
    }
    match validate_op(credential.clone(), route.clone()).await {
        Ok(validation) => {
            let mut resolved = credential.clone();
            if let Some(authoritative) = validation.expires_at {
                resolved.expires_at = authoritative;
            }
            store_authorization(&credential, resolved.clone(), route, validation.expires_at);
            Ok(AppAuthorization {
                credential: resolved,
                expires_at: validation.expires_at,
                renewed: false,
            })
        }
        Err(error) if error.code == "bilibili_app_auth_required" => {
            let refreshed = refresh_op(credential.clone(), route.clone()).await?;
            store_authorization(
                &credential,
                refreshed.clone(),
                route,
                Some(refreshed.expires_at),
            );
            Ok(AppAuthorization {
                expires_at: Some(refreshed.expires_at),
                credential: refreshed,
                renewed: true,
            })
        }
        Err(error) => Err(error),
    }
}

/// 校验凭据是否仍被服务端接受，并取得权威到期时间。
///
/// 刻意不用本机时钟做前置判断：时钟被调快时本地判断会把仍然有效的凭据报成
/// 过期，用户为一个时钟问题白跑一次扫码。凭据**格式**仍在此拒绝，非法格式
/// 不必联网。是否真的过期以服务端结论为准。
pub async fn validate(
    credential: &AppCredential,
    route: &crate::proxy::ProxyRoute,
) -> AppResult<AppValidation> {
    if !valid_credential_fields(credential) {
        return Err(auth_required());
    }
    fetch_oauth_info(credential, route).await
}

async fn fetch_oauth_info(
    credential: &AppCredential,
    route: &crate::proxy::ProxyRoute,
) -> AppResult<AppValidation> {
    let query = sign_params(&[], Some(&credential.access_token), now());
    let response = login_client(route)
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

/// 用 `refresh_token` 换取新的凭据对。
///
/// 实测确认的协议（见模块内测试注释）：
/// - 端点是 `x/passport-login/oauth2/refresh_token`，不是 `api/v2/oauth2/refresh_token`
///   （后者对 TV 凭据恒返回 `-101 账号未登录`）。
/// - 只需 `refresh_token` 一个业务参数（`access_key` 可省略），其余为 appkey/ts/sign。
/// - 成功后返回 `data.token_info`，字段与扫码一致，**`access_token` 会轮换**。
///
/// 失败分类：`-101`（不存在的 refresh_token）与 `-400`（缺参数／空值）都表明该
/// 刷新令牌不可用，需要重新扫码；`-3`（签名错误）与本方参数构造有关，属可重试。
/// 实测旧 `refresh_token` 在轮换后仍然可用，因此「刷新成功但落库失败」可以安全重试。
pub async fn refresh(
    credential: &AppCredential,
    route: &crate::proxy::ProxyRoute,
) -> AppResult<AppCredential> {
    if !valid_opaque(&credential.refresh_token, MAX_TOKEN_LEN) {
        return Err(auth_required());
    }
    let query = sign_params(
        &[("refresh_token", credential.refresh_token.clone())],
        None,
        now(),
    );
    let response = login_client(route)
        .map_err(|_| auth_unavailable())?
        .post(OAUTH_REFRESH_URL)
        .header(USER_AGENT, USER_AGENT_VALUE)
        .header(REFERER, REFERER_VALUE)
        .header(ACCEPT, "application/json")
        .form(&query)
        .send()
        .await
        .map_err(|_| auth_unavailable())?;
    if !response.status().is_success() {
        return Err(auth_unavailable());
    }
    let value: Value = response.json().await.map_err(|_| auth_unavailable())?;
    parse_refresh(&value, credential, now())
}

fn parse_refresh(value: &Value, previous: &AppCredential, now: i64) -> AppResult<AppCredential> {
    // 刷新路径的 -400 与 oauth2/info 同理：请求参数由本方保证，能走到这里说明
    // 服务端拒绝的是 refresh_token 本身。但**不能**复用 require_success_code 的
    // `-400 → auth_required`：实测空串/过短值也返回 -400，而那属于本地就该拦下的
    // 输入；这里已被 valid_opaque 过滤，所以 -400 只剩「该刷新令牌不可用」一种解释。
    match api_code(value) {
        Some(0) => {}
        Some(-101 | -400) => return Err(auth_required()),
        _ => return Err(auth_unavailable()),
    }
    let refreshed = parse_credential(&value["data"], now).map_err(|_| auth_unavailable())?;
    // mid 变化意味着服务端把凭据发给了另一个账号，不能默默替换本机授权。
    if refreshed.mid != previous.mid {
        return Err(auth_required());
    }
    Ok(refreshed)
}
/// 已验证的 APP 请求上下文；不持有 Web Cookie。
pub struct AppAuth {
    client: Client,
    access_token: String,
    /// 已知的权威到期秒；服务端未给寿命时为 `None`，表示不设本地期限。
    expires_at: Option<i64>,
    /// 续期轮换后的凭据；非空时调用方应落库，否则下次仍用旧值。
    renewed: Option<AppCredential>,
}

impl AppAuth {
    /// 校验并在必要时续期，再为推荐请求应用给定的代理路由；禁止重定向。
    pub async fn new(
        credential: AppCredential,
        route: &crate::proxy::ProxyRoute,
    ) -> AppResult<Self> {
        let authorization = authorize(credential, route).await?;
        // 该客户端只请求白名单内的固定地址，且携带 access_key；禁止重定向，
        // 同时复用共享代理路由的连接池，避免每次分页都重新建立 TLS 连接。
        let client =
            crate::http_client::build_no_redirect_client(route).map_err(|_| auth_unavailable())?;
        Ok(Self {
            client,
            access_token: authorization.credential.access_token.clone(),
            expires_at: authorization.expires_at,
            renewed: authorization.renewed.then_some(authorization.credential),
        })
    }

    /// 取出续期后的凭据供落库；只能取一次。
    pub fn take_renewed(&mut self) -> Option<AppCredential> {
        self.renewed.take()
    }

    /// 直播首页推荐：只请求 [`LIVE_HOME_PATH`] 与 [`LIVE_MORE_PATH`] 两个固定地址。
    ///
    /// 为什么单独一条而不是复用 [`Self::feed`]：
    ///
    /// - **凭据形态不同**。这两条直播接口只认 **query 里的 `access_key`**（实测：
    ///   Cookie 形态完全无效），而 APP feed 走 appkey/sign 签名；虽然同一份签名
    ///   参数也被直播接口接受（实测 `code=0`），但把「可签名域」放大到直播域
    ///   会让将来误用凭据成为可能。
    ///
    /// 误用的真实代价见 [`live_recommend_endpoint`]：**web-room 系**房间接口
    /// 对有效 TV 凭据一律 `-663`（实测 `web-room/v1/index/getInfoByRoom`、
    /// `web-room/v2/index/getRoomPlayInfo`，裸 `access_key` 与 appkey+sign 相同）。
    /// 这个 `-663` 由「有效 TV 凭据 + web-room」触发，不是「缺 Web Cookie」——
    /// 同一批端点匿名或仅 WBI 签名访问都正常。
    /// - **不携带 Web Cookie**。身份由 `access_key` 决定，而 Web Cookie 只属于
    ///   另一条账号轴；这条路径刻意只带凭据。
    ///
    /// 失败绝不回退匿名请求：调用方据此决定是否回落到 Cookie／匿名路径。
    pub async fn live_recommend(&self, path: &str, query: &[(&str, String)]) -> AppResult<String> {
        let endpoint = live_recommend_endpoint(path)?;
        if self.expires_at.is_some_and(|at| expiry_reached(at, now())) {
            return Err(auth_required());
        }
        let query = sign_params(query, Some(&self.access_token), now());
        let response = self
            .client
            .get(endpoint)
            .header(USER_AGENT, USER_AGENT_VALUE)
            .header(REFERER, REFERER_VALUE)
            .header(ACCEPT, "application/json")
            .query(&query)
            .send()
            .await
            .map_err(|_| auth_unavailable())?;
        if !response.status().is_success() {
            return Err(auth_unavailable());
        }
        let body = response.text().await.map_err(|_| auth_unavailable())?;
        let value: Value = serde_json::from_str(&body).map_err(|_| auth_unavailable())?;
        // 这两条接口对无效令牌同样静默返回 `code=0`（见 `live_recommend_is_personalized`
        // 在站点层的用法），因此这里只拦真正的错误码：风控 `-352`、`-663` 等一律
        // 归为可重试，不能据此断言凭据失效。
        if let Err(error) = require_success_code(&value, false) {
            if error.code == "bilibili_app_auth_required" {
                invalidate_authorization(&self.access_token);
            }
            return Err(error);
        }
        Ok(body)
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
        if let Err(error) = check_feed_body(&body) {
            if error.code == "bilibili_app_auth_required" {
                invalidate_authorization(&self.access_token);
            }
            return Err(error);
        }
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

fn login_client(route: &crate::proxy::ProxyRoute) -> AppResult<Client> {
    // 公共构建器要求 Jar，但每个请求都新建且随客户端丢弃，绝不复用 Web 会话，
    // 也不读取、返回或持久化 Set-Cookie / cookie_info。
    build_login_client(
        SITE,
        Arc::new(Jar::default()),
        TRUSTED_SUFFIXES,
        true,
        route,
    )
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

/// 直播首页推荐端点白名单。
///
/// 与 [`feed_endpoint`] 分开而不是合成一张表：两张表的**凭据形态不同**
/// （这里只认 query `access_key`），合成之后「某个新路径该用哪种形态」
/// 会变成靠调用点记忆的隐式约定。
fn live_recommend_endpoint(path: &str) -> AppResult<String> {
    match path {
        LIVE_HOME_PATH | LIVE_MORE_PATH => Ok(format!("{LIVE_RECOMMEND_BASE}{path}")),
        _ => Err(
            AppError::new("bilibili_app_live_path", "不支持的直播推荐路径").with_site("bilibili"),
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

    static AUTHORIZATION_CACHE_TEST_LOCK: AsyncMutex<()> = AsyncMutex::const_new(());
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

    #[test]
    fn cached_authorization_reuses_a_refresh_for_waiters_holding_the_old_snapshot() {
        let source = credential();
        let mut refreshed = source.clone();
        refreshed.access_token = "test-only-rotated-access-token".into();
        refreshed.refresh_token = "test-only-rotated-refresh-token".into();
        let route = crate::proxy::ProxyRoute::Custom("http://127.0.0.1:7890".into());
        let cached = CachedAuthorization {
            source_access_token: source.access_token.clone(),
            source_refresh_token: source.refresh_token.clone(),
            source_mid: source.mid.clone(),
            source_expires_at: source.expires_at,
            credential: refreshed.clone(),
            route: route.clone(),
            validated_at: Instant::now(),
            expires_at: Some(NOW + 3600),
        };

        // 已进入单飞等待队列、仍持有旧快照的调用者复用同一轮刷新结果，并再次
        // 返回 renewed=true 以便各自走既有的幂等落库路径。
        let from_old = cached.resolve(&source, &route, NOW).unwrap();
        assert!(from_old.renewed);
        assert_eq!(from_old.credential.access_token, refreshed.access_token);

        // 刷新后重新从数据库读取的调用者命中同一缓存，但无需再次落库。
        let from_new = cached.resolve(&refreshed, &route, NOW).unwrap();
        assert!(!from_new.renewed);
        assert_eq!(from_new.credential.access_token, refreshed.access_token);

        let mut other_account = source.clone();
        other_account.mid = "99".into();
        assert!(cached.resolve(&other_account, &route, NOW).is_none());
        let mut externally_updated_source = source.clone();
        externally_updated_source.expires_at += 1;
        assert!(
            cached
                .resolve(&externally_updated_source, &route, NOW)
                .is_none()
        );
        let mut externally_updated_resolved = refreshed.clone();
        externally_updated_resolved.expires_at += 1;
        assert!(
            cached
                .resolve(&externally_updated_resolved, &route, NOW)
                .is_none()
        );
        assert!(
            cached
                .resolve(&source, &crate::proxy::ProxyRoute::Direct, NOW)
                .is_none()
        );
        // 服务端返回的期限已经到达时，不允许短期窗口继续放行。
        assert!(cached.resolve(&source, &route, NOW + 3600).is_none());
        assert!(
            cached
                .resolve_at(
                    &source,
                    &route,
                    NOW,
                    cached.validated_at + AUTHORIZATION_VALIDATION_TTL,
                )
                .is_none(),
            "成功校验缓存必须受有限 TTL 约束"
        );
    }

    #[tokio::test]
    async fn authorize_single_flight_refreshes_once_for_concurrent_old_waiters() {
        use std::sync::atomic::AtomicUsize;

        let _guard = AUTHORIZATION_CACHE_TEST_LOCK.lock().await;
        clear_authorization_cache();
        let mut source = credential();
        source.expires_at = now() + LIFETIME;
        let mut rotated = source.clone();
        rotated.access_token = "test-only-single-flight-access-token".into();
        rotated.refresh_token = "test-only-single-flight-refresh-token".into();
        rotated.expires_at = now() + LIFETIME + 60;
        let route = crate::proxy::ProxyRoute::Custom("http://127.0.0.1:7890".into());
        let validate_calls = Arc::new(AtomicUsize::new(0));
        let refresh_calls = Arc::new(AtomicUsize::new(0));

        let first_validate = {
            let calls = validate_calls.clone();
            move |_: AppCredential, _: crate::proxy::ProxyRoute| {
                calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async {
                    tokio::task::yield_now().await;
                    Err::<AppValidation, _>(auth_required())
                }) as BoxFuture<'static, AppResult<AppValidation>>
            }
        };
        let second_validate = {
            let calls = validate_calls.clone();
            move |_: AppCredential, _: crate::proxy::ProxyRoute| {
                calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async {
                    tokio::task::yield_now().await;
                    Err::<AppValidation, _>(auth_required())
                }) as BoxFuture<'static, AppResult<AppValidation>>
            }
        };
        let first_refresh = {
            let calls = refresh_calls.clone();
            let rotated = rotated.clone();
            move |_: AppCredential, _: crate::proxy::ProxyRoute| {
                calls.fetch_add(1, Ordering::SeqCst);
                let rotated = rotated.clone();
                Box::pin(async move {
                    tokio::task::yield_now().await;
                    Ok(rotated)
                }) as BoxFuture<'static, AppResult<AppCredential>>
            }
        };
        let second_refresh = {
            let calls = refresh_calls.clone();
            let rotated = rotated.clone();
            move |_: AppCredential, _: crate::proxy::ProxyRoute| {
                calls.fetch_add(1, Ordering::SeqCst);
                let rotated = rotated.clone();
                Box::pin(async move {
                    tokio::task::yield_now().await;
                    Ok(rotated)
                }) as BoxFuture<'static, AppResult<AppCredential>>
            }
        };

        let (first, second) = tokio::join!(
            authorize_with(source.clone(), &route, first_validate, first_refresh),
            authorize_with(source, &route, second_validate, second_refresh),
        );
        for result in [first, second] {
            let authorization = result.unwrap();
            assert!(authorization.renewed);
            assert_eq!(authorization.credential.access_token, rotated.access_token);
            assert_eq!(
                authorization.credential.refresh_token,
                rotated.refresh_token
            );
        }
        assert_eq!(validate_calls.load(Ordering::SeqCst), 1);
        assert_eq!(refresh_calls.load(Ordering::SeqCst), 1);
        clear_authorization_cache();
    }

    #[tokio::test]
    async fn authorize_does_not_cache_retryable_validation_failure() {
        use std::sync::atomic::AtomicUsize;

        let _guard = AUTHORIZATION_CACHE_TEST_LOCK.lock().await;
        clear_authorization_cache();
        let mut source = credential();
        source.expires_at = now() + LIFETIME;
        let route = crate::proxy::ProxyRoute::Custom("http://127.0.0.1:7890".into());
        let validate_calls = Arc::new(AtomicUsize::new(0));
        let refresh_calls = Arc::new(AtomicUsize::new(0));

        let first_validate = {
            let calls = validate_calls.clone();
            move |_: AppCredential, _: crate::proxy::ProxyRoute| {
                calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async {
                    Err::<AppValidation, _>(AppError::new(
                        "bilibili_app_unavailable",
                        "temporary validation failure",
                    ))
                }) as BoxFuture<'static, AppResult<AppValidation>>
            }
        };
        let second_validate = {
            let calls = validate_calls.clone();
            move |_: AppCredential, _: crate::proxy::ProxyRoute| {
                calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async {
                    Err::<AppValidation, _>(AppError::new(
                        "bilibili_app_unavailable",
                        "temporary validation failure",
                    ))
                }) as BoxFuture<'static, AppResult<AppValidation>>
            }
        };
        let refresh = {
            let calls = refresh_calls.clone();
            move |_: AppCredential, _: crate::proxy::ProxyRoute| {
                calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async {
                    Err::<AppCredential, AppError>(AppError::new(
                        "unexpected_refresh",
                        "retryable validation failure must not refresh",
                    ))
                }) as BoxFuture<'static, AppResult<AppCredential>>
            }
        };

        let first = authorize_with(source.clone(), &route, first_validate, refresh).await;
        let first = match first {
            Ok(_) => panic!("首次网络失败应向上返回"),
            Err(error) => error,
        };
        assert_eq!(first.code, "bilibili_app_unavailable");
        let refresh = {
            let calls = refresh_calls.clone();
            move |_: AppCredential, _: crate::proxy::ProxyRoute| {
                calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async {
                    Err::<AppCredential, AppError>(AppError::new(
                        "unexpected_refresh",
                        "retryable validation failure must not refresh",
                    ))
                }) as BoxFuture<'static, AppResult<AppCredential>>
            }
        };
        let second = authorize_with(source, &route, second_validate, refresh).await;
        let second = match second {
            Ok(_) => panic!("失败结果未缓存，第二次必须重新校验"),
            Err(error) => error,
        };
        assert_eq!(second.code, "bilibili_app_unavailable");
        assert_eq!(validate_calls.load(Ordering::SeqCst), 2);
        assert_eq!(refresh_calls.load(Ordering::SeqCst), 0);
        clear_authorization_cache();
    }

    #[tokio::test]
    async fn authoritative_expiry_correction_does_not_force_another_validation() {
        use std::sync::atomic::AtomicUsize;

        let _guard = AUTHORIZATION_CACHE_TEST_LOCK.lock().await;
        clear_authorization_cache();
        let mut source = credential();
        source.expires_at = now() + LIFETIME;
        let authoritative = source.expires_at + 3600;
        let route = crate::proxy::ProxyRoute::Custom("http://127.0.0.1:7890".into());
        let validate_calls = Arc::new(AtomicUsize::new(0));
        let refresh_calls = Arc::new(AtomicUsize::new(0));

        let first_validate = {
            let calls = validate_calls.clone();
            move |_: AppCredential, _: crate::proxy::ProxyRoute| {
                calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async move {
                    Ok(AppValidation {
                        expires_at: Some(authoritative),
                    })
                }) as BoxFuture<'static, AppResult<AppValidation>>
            }
        };
        let refresh = {
            let calls = refresh_calls.clone();
            move |_: AppCredential, _: crate::proxy::ProxyRoute| {
                calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async {
                    Err::<AppCredential, AppError>(AppError::new(
                        "unexpected_refresh",
                        "profile expiry correction must not refresh tokens",
                    ))
                }) as BoxFuture<'static, AppResult<AppCredential>>
            }
        };
        let first = authorize_with(source.clone(), &route, first_validate, refresh)
            .await
            .unwrap();
        assert!(!first.renewed, "仅校正寿命不得误标 token rotation");
        assert_eq!(first.credential.expires_at, authoritative);
        assert_eq!(first.expires_at, Some(authoritative));

        // 与 commands/account.rs profile 分支一致：非续期但权威寿命不同，保存校正快照。
        let conn = open_in_memory().unwrap();
        save(&conn, &source).unwrap();
        let corrected = if let Some(authoritative_expiry) = first.expires_at
            && authoritative_expiry != source.expires_at
        {
            let mut corrected = source.clone();
            corrected.expires_at = authoritative_expiry;
            Some(corrected)
        } else {
            None
        };
        if let Some(corrected) = corrected {
            save(&conn, &corrected).unwrap();
        }
        let persisted = load(&conn).unwrap().unwrap();
        assert_eq!(persisted.expires_at, authoritative);

        let second_validate = {
            let calls = validate_calls.clone();
            move |_: AppCredential, _: crate::proxy::ProxyRoute| {
                calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async {
                    Err::<AppValidation, _>(AppError::new(
                        "unexpected_validation",
                        "corrected profile must hit authorization cache",
                    ))
                }) as BoxFuture<'static, AppResult<AppValidation>>
            }
        };
        let refresh = {
            let calls = refresh_calls.clone();
            move |_: AppCredential, _: crate::proxy::ProxyRoute| {
                calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async {
                    Err::<AppCredential, AppError>(AppError::new(
                        "unexpected_refresh",
                        "corrected profile must hit authorization cache",
                    ))
                }) as BoxFuture<'static, AppResult<AppCredential>>
            }
        };
        let second = authorize_with(persisted, &route, second_validate, refresh)
            .await
            .unwrap();
        assert!(!second.renewed);
        assert_eq!(second.credential.expires_at, authoritative);
        assert_eq!(validate_calls.load(Ordering::SeqCst), 1);
        assert_eq!(refresh_calls.load(Ordering::SeqCst), 0);
        clear_authorization_cache();
    }

    #[tokio::test]
    async fn explicit_auth_rejection_invalidates_only_the_matching_cache_entry() {
        let _guard = AUTHORIZATION_CACHE_TEST_LOCK.lock().await;
        clear_authorization_cache();
        let source = credential();
        let route = crate::proxy::ProxyRoute::Custom("http://127.0.0.1:7890".into());
        store_authorization(&source, source.clone(), &route, Some(source.expires_at));
        assert!(cached_authorization(&source, &route, NOW).is_some());

        invalidate_authorization("unrelated-token");
        assert!(
            cached_authorization(&source, &route, NOW).is_some(),
            "其他命令的鉴权失败不得误伤当前凭据"
        );
        invalidate_authorization(&source.access_token);
        assert!(
            cached_authorization(&source, &route, NOW).is_none(),
            "明确 auth_required 后必须让下一次命令重新校验"
        );
        clear_authorization_cache();
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

    #[tokio::test]
    async fn credentials_crud_is_separate_from_web_cookies() {
        let _guard = AUTHORIZATION_CACHE_TEST_LOCK.lock().await;
        clear_authorization_cache();
        let conn = open_in_memory().unwrap();
        assert!(load(&conn).unwrap().is_none());
        let credential = credential();
        save(&conn, &credential).unwrap();
        let loaded = load(&conn).unwrap().unwrap();
        assert_eq!(loaded.access_token, credential.access_token);
        assert_eq!(loaded.refresh_token, credential.refresh_token);
        assert_eq!(loaded.mid, credential.mid);
        assert_eq!(loaded.expires_at, credential.expires_at);
        let mut replacement = AppCredential {
            access_token: "replacement".into(),
            ..credential
        };
        replacement.expires_at = now() + LIFETIME;
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
        let route = crate::proxy::ProxyRoute::Direct;
        store_authorization(
            &replacement,
            replacement.clone(),
            &route,
            Some(replacement.expires_at),
        );
        assert!(cached_authorization(&replacement, &route, now()).is_some());
        clear(&conn).unwrap();
        assert!(
            cached_authorization(&replacement, &route, now()).is_none(),
            "显式退出登录必须同步清空授权校验缓存"
        );
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
            error_of(validate(&expired, &crate::proxy::ProxyRoute::Direct).await).code,
            "bilibili_app_auth_required"
        );
        assert_eq!(
            error_of(AppAuth::new(expired, &crate::proxy::ProxyRoute::Direct).await).code,
            "bilibili_app_auth_required"
        );
        let auth = AppAuth {
            client: Client::builder().no_proxy().build().unwrap(),
            access_token: TEST_TOKEN.into(),
            expires_at: Some(1),
            renewed: None,
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
            renewed: None,
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

    /// 直播首页推荐只能走两个白名单路径。
    ///
    /// 这条白名单是「凭据不得外流」的唯一执行点：把有效 TV 凭据发给 web-room
    /// 系房间接口会得到 `-663`，一旦能拼出任意路径，误用就只会被上游拦住而不是
    /// 被本机拦住。
    #[test]
    fn live_recommend_endpoints_are_a_closed_allowlist() {
        assert_eq!(
            live_recommend_endpoint(LIVE_HOME_PATH).unwrap(),
            format!("{LIVE_RECOMMEND_BASE}{LIVE_HOME_PATH}")
        );
        assert_eq!(
            live_recommend_endpoint(LIVE_MORE_PATH).unwrap(),
            format!("{LIVE_RECOMMEND_BASE}{LIVE_MORE_PATH}")
        );
        for path in [
            "",
            "/",
            "/index/getList/",
            "/../index/getList",
            "/web-room/v2/index/getRoomPlayInfo",
            "/index/getRoomPlayInfo",
            "https://evil.test/",
            "//evil.test/",
            "/index/getList?x=1",
        ] {
            assert_eq!(
                error_of(live_recommend_endpoint(path)).code,
                "bilibili_app_live_path",
                "路径必须被拒：{path}"
            );
        }
    }

    /// 直播推荐与 APP feed 是两条独立通道，各自的过期守卫都必须生效。
    #[tokio::test]
    async fn expired_credential_never_reaches_the_live_recommend_endpoint() {
        let auth = AppAuth {
            client: Client::builder().no_proxy().build().unwrap(),
            access_token: TEST_TOKEN.into(),
            expires_at: Some(1),
            renewed: None,
        };
        assert_eq!(
            error_of(auth.live_recommend(LIVE_HOME_PATH, &[]).await).code,
            "bilibili_app_auth_required"
        );
        // 无寿命（服务端未给）时不设本地期限，但仍要过路径白名单。
        let unknown_expiry = AppAuth {
            client: Client::builder().no_proxy().build().unwrap(),
            access_token: TEST_TOKEN.into(),
            expires_at: None,
            renewed: None,
        };
        assert_eq!(
            error_of(
                unknown_expiry
                    .live_recommend("/index/getRoomPlayInfo", &[])
                    .await
            )
            .code,
            "bilibili_app_live_path"
        );
    }

    /// 直播接口对无效凭据静默降级（`code=0`），因此业务码不能当失效判据；
    /// 但真正的错误码（风控 `-352`、`-663`）必须原样上报，不能被当成「成功」。
    #[test]
    fn live_recommend_body_codes_are_classified_without_claiming_invalidity() {
        for (body, expected) in [
            (r#"{"code":0,"data":{"recommend_room_list":[]}}"#, None),
            (
                r#"{"code":-352,"message":"-352"}"#,
                Some("bilibili_app_auth_unavailable"),
            ),
            (
                r#"{"code":-663,"message":"-663"}"#,
                Some("bilibili_app_auth_unavailable"),
            ),
            // 服务端明确拒绝登录态时仍归为需重新授权，与 feed 同一套分类。
            (r#"{"code":-101}"#, Some("bilibili_app_auth_required")),
            (r#"{"code":61000}"#, Some("bilibili_app_auth_required")),
        ] {
            let value: Value = serde_json::from_str(body).unwrap();
            match require_success_code(&value, false) {
                Ok(()) => assert_eq!(expected, None, "不应报错：{body}"),
                Err(error) => assert_eq!(Some(error.code.as_str()), expected, "分类不符：{body}"),
            }
        }
    }

    /// 刷新协议的错误分类（实测依据见 `refresh` 的文档注释）。
    ///
    /// 关键区分：`-101`/`-400` 表示该 `refresh_token` 不可用（需重新扫码），
    /// `-3`（签名）与其他未知码只说明本次请求没成，不应让用户重扫。
    #[tokio::test]
    async fn refresh_classifies_expired_refresh_token_separately_from_retryable_failures() {
        let previous = credential();
        let token_info = |overrides: Value| {
            let mut token = token_data();
            if let Some(object) = overrides.as_object() {
                for (key, value) in object {
                    token[key] = value.clone();
                }
            }
            json!({"code": 0, "data": {"token_info": token}})
        };

        // 成功：返回轮换后的凭据。
        let refreshed = parse_refresh(&token_info(json!({})), &previous, NOW).unwrap();
        assert_eq!(refreshed.mid, previous.mid);
        assert_eq!(refreshed.expires_at, NOW + LIFETIME);

        for response in [
            json!({"code": -101}),
            json!({"code": -400}),
            // mid 变化说明凭据被发给了另一个账号，不能默默替换本机授权。
            token_info(json!({"mid": 43})),
        ] {
            let error = error_of(parse_refresh(&response, &previous, NOW));
            assert_eq!(error.code, "bilibili_app_auth_required");
            assert!(!error.retryable);
        }
        for response in [
            // 签名错误由本方参数构造引起，不是凭据问题。
            json!({"code": -3}),
            json!({"code": -412}),
            json!({"code": -500}),
            json!({"code": 0, "data": {}}),
            json!({"code": 0, "data": {"token_info": {"access_token": "bad!"}}}),
            json!({}),
        ] {
            let error = error_of(parse_refresh(&response, &previous, NOW));
            assert_eq!(error.code, "bilibili_app_auth_unavailable");
            assert!(error.retryable);
        }
        // 本地就能判定格式非法的 refresh_token 不必联网。
        let broken = AppCredential {
            refresh_token: "bad!token".into(),
            ..credential()
        };
        assert_eq!(
            error_of(refresh(&broken, &crate::proxy::ProxyRoute::Direct).await).code,
            "bilibili_app_auth_required"
        );
    }

    /// 刷新后的 `access_token` 实测为 220 字符（含连字符），必须通过本地校验，
    /// 否则续期成功却会被自己的格式检查拒绝。
    #[test]
    fn refresh_accepts_the_longer_rotated_access_token_shape() {
        let mut token = token_data();
        token["access_token"] = json!(format!("{}-{}", "a".repeat(217), "b".repeat(2)));
        let refreshed = parse_refresh(
            &json!({"code": 0, "data": {"token_info": token}}),
            &credential(),
            NOW,
        )
        .unwrap();
        assert_eq!(refreshed.access_token.len(), 220);
        assert!(valid_credential_fields(&refreshed));
    }

    /// 主动续期只在临近到期时触发，且带进程内限速。
    #[test]
    fn proactive_refresh_only_triggers_near_expiry_and_is_rate_limited() {
        let now = NOW;
        let mut far = credential();
        far.expires_at = now + REFRESH_AHEAD_SECS + 1;
        assert!(!needs_refresh(&far, now));

        let mut near = credential();
        near.expires_at = now + REFRESH_AHEAD_SECS;
        assert!(needs_refresh(&near, now));

        // 非正到期时间视为「没有权威寿命」，交由远端判断。
        let mut unknown = credential();
        unknown.expires_at = 0;
        assert!(!needs_refresh(&unknown, now));

        // 限速：首次允许，间隔内拒绝，超过间隔后再次允许。
        let base = now + 1_000_000;
        LAST_PROACTIVE_REFRESH.store(0, Ordering::Relaxed);
        assert!(proactive_refresh_allowed(base));
        LAST_PROACTIVE_REFRESH.store(base, Ordering::Relaxed);
        assert!(!proactive_refresh_allowed(
            base + PROACTIVE_REFRESH_MIN_INTERVAL_SECS - 1
        ));
        assert!(proactive_refresh_allowed(
            base + PROACTIVE_REFRESH_MIN_INTERVAL_SECS
        ));
        LAST_PROACTIVE_REFRESH.store(0, Ordering::Relaxed);
    }
}
