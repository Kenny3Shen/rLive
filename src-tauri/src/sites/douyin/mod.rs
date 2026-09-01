//! 抖音直播站点客户端。
//!
//! 抖音的公开列表接口受浏览器挑战保护：每个请求都携带由其自身 query 字符串
//! 派生的 `a_bogus` 签名。签名在本地计算（参见 [`a_bogus`]），
//! 因此浏览列表可以与 Web 客户端一样使用可分页的
//! `partition/detail/room/v2` 接口，从而加载多页。
//! 房间详情与线路仍来自 SSR 房间页和官方回源接口。
//! 调用方未提供 `ttwid` 会话时，从直播首页获取一份。

mod a_bogus;

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use reqwest::header::{COOKIE, HeaderMap, REFERER, SET_COOKIE, USER_AGENT};
use reqwest::{Client, Url};
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::http_client;
use crate::models::live::{
    LiveCategory, LivePlayQuality, LiveRoomDetail, LiveRoomItem, LiveRoomStatus, LiveSubCategory,
    PlayUrl, RoomListPage, SiteId, parse_live_started_at,
};
use crate::sites::traits::LiveSite;

/// 抖音 Web 直播接口使用的浏览器 UA。保持稳定很重要：
/// 部分边缘节点把 `ttwid` 绑定到浏览器家族上。
pub const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const LIVE_ROOT: &str = "https://live.douyin.com/";
const ROOM_REFLOW_URL: &str = "https://webcast.amemv.com/webcast/room/reflow/info/";
const LIVE_SEARCH_URL: &str = "https://www.douyin.com/aweme/v1/web/live/search/";
/// Web 客户端用于分类列表和首页信息流的可分页浏览接口。
const PARTITION_ROOMS_URL: &str = "https://live.douyin.com/webcast/web/partition/detail/room/v2/";
/// 首页信息流并不是真实的分类。抖音 Web 客户端用这个合成分区从分区接口读取
/// 它，这正是推荐列表能够翻页的原因。
const RECOMMEND_PARTITION_ID: &str = "720";
const RECOMMEND_PARTITION_TYPE: &str = "1";
/// Web 首页信息流接口。与分类浏览不同，每次调用返回一批轮换的推荐房间，
/// 且不带偏移量：相邻调用的结果只是部分重叠，
/// 因此重复请求能带出新房间。已保存的账号 Cookie 自动随行；
/// 匿名会话（仅新 `ttwid`）同样被服务。
const RECOMMEND_FEED_URL: &str = "https://live.douyin.com/webcast/feed/";
/// 每个列表页请求的房间数。抖音自己的 `offset` 正好按这个值推进，
/// 因此页码可以映射到稳定的偏移量。
const LIST_PAGE_SIZE: u32 = 15;
/// Web 客户端在列表请求中发送的 `msToken` 长度。
const MS_TOKEN_LENGTH: usize = 107;
const MS_TOKEN_CHARSET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/// 匿名直播首页引导 cookie 在进程内保持有效的时长。`ttwid` 本身的寿命长得多；
/// 这个 TTL 只是限制陈旧程度。
const WEB_SESSION_CACHE_TTL: Duration = Duration::from_secs(30 * 60);
/// 每个推荐页并发抓取的信息流批次数。相邻批次高度重叠（20 个房间里约 15 个），
/// 单次往返只能带来少量新房间；
/// 两个并发批次让去重后的产出翻倍，
/// 而不增加额外等待时间。
const RECOMMEND_FEED_BATCHES: usize = 2;

/// 进程级缓存直播首页下发的匿名引导 cookie（`ttwid` 等）。站点实例按 IPC 命令
/// 创建，没有这份缓存时，每个列表请求都要重新下载约 1 MB 的首页，
/// 只为重启同一个匿名会话。只缓存首页响应贡献的 cookie，
/// 已保存的账号 Cookie 绝不进入缓存。
struct CachedWebSession {
    cookie_pairs: Vec<(String, String)>,
    expires_at: Instant,
}

static WEB_SESSION_CACHE: Mutex<Option<CachedWebSession>> = Mutex::new(None);

fn cached_web_session_pairs() -> Option<Vec<(String, String)>> {
    let cache = WEB_SESSION_CACHE.lock().ok()?;
    let session = cache.as_ref()?;
    if Instant::now() >= session.expires_at {
        return None;
    }
    Some(session.cookie_pairs.clone())
}

fn store_web_session_pairs(pairs: &[(String, String)]) {
    if pairs.is_empty() {
        return;
    }
    if let Ok(mut cache) = WEB_SESSION_CACHE.lock() {
        *cache = Some(CachedWebSession {
            cookie_pairs: pairs.to_vec(),
            expires_at: Instant::now() + WEB_SESSION_CACHE_TTL,
        });
    }
}

/// 抖音站点实例只持有临时的、只读的请求状态。初始 cookie 来自账号存储；
/// `ttwid`、`msToken` 等响应 cookie 留在内存中，绝不写回磁盘。
pub struct DouyinSite {
    client: Client,
    cookie: Mutex<String>,
    /// 该实例是否已持有一个可用的临时 Web 会话。实例按命令调用创建，
    /// 因此首次使用通常从 [`WEB_SESSION_CACHE`] 播种，
    /// 而不是访问直播首页。
    web_session_initialized: Mutex<bool>,
}

impl Default for DouyinSite {
    fn default() -> Self {
        Self::new(http_client::default_client(), String::new())
    }
}

impl DouyinSite {
    pub fn new(client: Client, cookie: String) -> Self {
        let cookie = normalize_cookie(&cookie);
        Self {
            client,
            cookie: Mutex::new(cookie),
            web_session_initialized: Mutex::new(false),
        }
    }

    fn err(message: impl Into<String>) -> AppError {
        AppError::new("douyin_api_error", message)
            .with_site("douyin")
            .retryable()
    }

    fn parse_err(message: impl Into<String>) -> AppError {
        AppError::new("douyin_parse_error", message).with_site("douyin")
    }

    fn login_required() -> AppError {
        AppError::new(
            "douyin_login_required",
            "抖音直播搜索需要登录，请在账号管理中配置完整的抖音 Cookie",
        )
        .with_site("douyin")
    }

    fn cookie(&self) -> AppResult<String> {
        self.cookie
            .lock()
            .map(|cookie| cookie.clone())
            .map_err(|_| {
                AppError::new("douyin_lock", "Douyin session mutex poisoned").with_site("douyin")
            })
    }

    fn has_cookie(&self, key: &str) -> AppResult<bool> {
        Ok(cookie_pairs(&self.cookie()?)
            .iter()
            .any(|(candidate, value)| candidate.eq_ignore_ascii_case(key) && !value.is_empty()))
    }

    fn web_session_is_initialized(&self) -> AppResult<bool> {
        self.web_session_initialized
            .lock()
            .map(|state| *state)
            .map_err(|_| {
                AppError::new("douyin_lock", "Douyin session mutex poisoned").with_site("douyin")
            })
    }

    fn mark_web_session_initialized(&self) -> AppResult<()> {
        let mut state = self.web_session_initialized.lock().map_err(|_| {
            AppError::new("douyin_lock", "Douyin session mutex poisoned").with_site("douyin")
        })?;
        *state = true;
        Ok(())
    }

    fn remember_response_cookies(&self, headers: &HeaderMap) -> AppResult<()> {
        let mut received = Vec::new();
        for header in headers.get_all(SET_COOKIE) {
            let Ok(header) = header.to_str() else {
                continue;
            };
            let first = header.split(';').next().unwrap_or_default().trim();
            if first.contains('=') {
                received.push(first.to_string());
            }
        }
        // 直播首页目前返回短时效的 `x-ms-token` 头，而不是（或除了）
        // `msToken` Set-Cookie。把它放进同一份内存会话，
        // 因为房间接口接受它作为 `msToken` query 参数。
        // 不接受分隔符/控制字节：
        // 该值稍后会被放入本地会话的 Cookie 头中。
        if let Some(ms_token) = headers
            .get_all("x-ms-token")
            .iter()
            .filter_map(|header| header.to_str().ok())
            .map(str::trim)
            .find(|value| is_safe_session_value(value))
        {
            received.push(format!("msToken={ms_token}"));
        }
        if received.is_empty() {
            return Ok(());
        }

        let mut cookie = self.cookie.lock().map_err(|_| {
            AppError::new("douyin_lock", "Douyin session mutex poisoned").with_site("douyin")
        })?;
        *cookie = merge_cookie_values(&cookie, &received.join("; "));
        Ok(())
    }

    async fn get_text(
        &self,
        url: &str,
        params: &[(String, String)],
        referer: &str,
        accept_json: bool,
    ) -> AppResult<String> {
        let cookie = self.cookie()?;
        let mut request = self
            .client
            .get(url)
            .header(USER_AGENT, DEFAULT_USER_AGENT)
            .header(REFERER, referer)
            .header("accept-language", "zh-CN,zh;q=0.9,en;q=0.8")
            .header(
                "accept",
                if accept_json {
                    "application/json, text/plain, */*"
                } else {
                    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
                },
            );
        // 手动保存的 `.douyin.com` Cookie 绝不能被重放到其他可注册域，
        // 例如 `webcast.amemv.com`。
        let sends_douyin_cookie = is_douyin_cookie_url(url);
        if sends_douyin_cookie && !cookie.is_empty() {
            request = request.header(COOKIE, cookie);
        }
        for (key, value) in params {
            request = request.query(&[(key.as_str(), value.as_str())]);
        }

        let response = request
            .send()
            .await
            // `reqwest::Error` 可能包含完整的请求 URL，包括 msToken 等 query 参数。
            // 不要把这些细节带入面向用户的错误信息和 tracing 输出。
            .map_err(|_| Self::err("HTTP request failed"))?;
        let status = response.status();
        let headers = response.headers().clone();
        let text = response
            .text()
            .await
            .map_err(|_| Self::err("HTTP response body failed"))?;
        if sends_douyin_cookie {
            self.remember_response_cookies(&headers)?;
        }

        if !status.is_success() {
            // 响应 body 可能由边缘节点生成，并可能反映请求取值。
            // 这里用状态码做诊断已经足够安全。
            return Err(Self::err(format!("HTTP {status}")));
        }
        if text.trim() == "blocked" {
            return Err(Self::err("请求被抖音风控拦截，请稍后重试或更新 Cookie"));
        }
        Ok(text)
    }

    async fn get_json(
        &self,
        url: &str,
        params: &[(String, String)],
        referer: &str,
    ) -> AppResult<Value> {
        let text = self.get_text(url, params, referer, true).await?;
        if text.trim().is_empty() {
            return Err(Self::err("抖音接口返回为空，可能触发访问验证"));
        }
        let value: Value = serde_json::from_str(&text)
            .map_err(|error| Self::parse_err(format!("JSON 响应解析失败: {error}")))?;
        self.ensure_api_success(&value)?;
        Ok(value)
    }

    fn ensure_api_success(&self, value: &Value) -> AppResult<()> {
        let Some(code) = value.get("status_code").and_then(json_i64_opt) else {
            return Ok(());
        };
        if code == 0 {
            return Ok(());
        }
        if code == 2483 {
            return Err(Self::login_required());
        }
        let message = json_str(
            value
                .get("status_msg")
                .or_else(|| value.get("message"))
                .unwrap_or(&Value::Null),
        );
        if code == 101 || code == 444 || message.contains("验证") {
            return Err(AppError::new(
                "douyin_browser_verification",
                "抖音当前要求网页访问验证，应用无法自动完成；请稍后重试或在官方网页观看",
            )
            .with_site("douyin")
            .retryable());
        }
        // 不要展示任意服务器文本：部分网关会回显 query 参数，
        // 可能泄露短时效的 msToken。
        Err(Self::err(format!("抖音接口错误 code={code}")))
    }

    /// 抓取一次直播首页以获得匿名 `ttwid` cookie。此前引导的进程级缓存仍然新鲜时
    /// 可直接短路这次访问；已保存的账号 Cookie 取值始终优先于缓存值。
    async fn ensure_web_session(&self) -> AppResult<()> {
        if self.web_session_is_initialized()? {
            return Ok(());
        }
        if let Some(cached) = cached_web_session_pairs() {
            let mut cookie = self.cookie.lock().map_err(|_| {
                AppError::new("douyin_lock", "Douyin session mutex poisoned").with_site("douyin")
            })?;
            // 缓存值补齐缺口；已经持有的取值（保存的登录身份、更早的响应 cookie）
            // 保持优先。
            *cookie = merge_cookie_values(
                &cached
                    .iter()
                    .map(|(k, v)| format!("{k}={v}"))
                    .collect::<Vec<_>>()
                    .join("; "),
                &cookie,
            );
            drop(cookie);
            self.mark_web_session_initialized()?;
            return Ok(());
        }
        let before = self.cookie()?;
        let _ = self.get_text(LIVE_ROOT, &[], LIVE_ROOT, false).await?;
        if self.has_cookie("ttwid")? {
            let gained = changed_cookie_pairs(&before, &self.cookie()?);
            store_web_session_pairs(&gained);
            self.mark_web_session_initialized()?;
            Ok(())
        } else {
            Err(Self::err(
                "未能从抖音直播页获取 ttwid，会话初始化失败，请稍后重试",
            ))
        }
    }

    async fn get_ssr_page(&self, path: &str) -> AppResult<String> {
        self.ensure_web_session().await?;
        let url = format!("https://live.douyin.com/{path}");
        self.get_text(&url, &[], LIVE_ROOT, false).await
    }

    /// GET 一个经浏览器签名的抖音 Web API。
    ///
    /// `a_bogus` 覆盖的是实际发送的那条 query 字符串，因此参数在这里编码一次，
    /// 并把签名追加到同一条字符串上，
    /// 而不是作为单独的键值对交给 `reqwest`。
    async fn get_signed_json(
        &self,
        url: &str,
        params: &[(String, String)],
        referer: &str,
    ) -> AppResult<Value> {
        let query = encode_query(params);
        let signature = a_bogus::generate_a_bogus(&query, DEFAULT_USER_AGENT);
        let signed = format!("{url}?{query}&a_bogus={}", url_encode(&signature));
        // `get_json` 不会追加任何内容：URL 已携带签名后的 query，
        // 在这里再加参数会使签名失效。
        self.get_json(&signed, &[], referer).await
    }

    /// 从可分页浏览接口抓取一页房间。
    ///
    /// `partition` 是抖音分区 id 及其类型；首页信息流使用合成的
    /// [`RECOMMEND_PARTITION_ID`]。
    async fn get_partition_rooms(
        &self,
        partition: &str,
        partition_type: &str,
        page: u32,
        referer: &str,
    ) -> AppResult<RoomListPage> {
        self.ensure_web_session().await?;
        let offset = page.saturating_sub(1).saturating_mul(LIST_PAGE_SIZE);
        let params = vec![
            ("aid".into(), "6383".into()),
            ("app_name".into(), "douyin_web".into()),
            ("live_id".into(), "1".into()),
            ("device_platform".into(), "web".into()),
            ("language".into(), "zh-CN".into()),
            ("enter_from".into(), "web_homepage_hot".into()),
            ("cookie_enabled".into(), "true".into()),
            ("screen_width".into(), "1920".into()),
            ("screen_height".into(), "1080".into()),
            ("browser_language".into(), "zh-CN".into()),
            ("browser_platform".into(), "Win32".into()),
            ("browser_name".into(), "Chrome".into()),
            ("browser_version".into(), "125.0.0.0".into()),
            ("count".into(), LIST_PAGE_SIZE.to_string()),
            ("offset".into(), offset.to_string()),
            ("partition".into(), partition.to_string()),
            ("partition_type".into(), partition_type.to_string()),
            ("req_from".into(), "2".into()),
            ("msToken".into(), generate_ms_token()),
        ];
        let value = self
            .get_signed_json(PARTITION_ROOMS_URL, &params, referer)
            .await?;
        parse_partition_rooms(&value, offset)
    }

    async fn get_reflow_room(&self, room_id: &str) -> AppResult<Value> {
        // 这个官方回源接口使用公开房间号即可工作，
        // 并且刻意不带 `.douyin.com` Cookie/会话请求。
        let params = vec![
            ("type_id".into(), "0".into()),
            ("live_id".into(), "1".into()),
            ("room_id".into(), room_id.to_string()),
            ("sec_user_id".into(), String::new()),
            ("version_code".into(), "99.99.99".into()),
            ("app_id".into(), "6383".into()),
        ];
        self.get_json(ROOM_REFLOW_URL, &params, LIVE_ROOT).await
    }

    async fn get_reflow_room_detail(&self, room_id: &str) -> AppResult<LiveRoomDetail> {
        let root = self.get_reflow_room(room_id).await?;
        let detail = parse_reflow_room_detail(&root, room_id)?;
        if detail.status && !has_playable_stream(&detail) {
            return Err(Self::err(
                "抖音房间未返回可播放数据，会话可能已失效，请刷新后重试",
            ));
        }
        Ok(detail)
    }

    async fn get_room_detail_from_html(&self, web_rid: &str) -> AppResult<LiveRoomDetail> {
        self.ensure_web_session().await?;
        let html = self
            .get_text(
                &format!("https://live.douyin.com/{web_rid}"),
                &[],
                LIVE_ROOT,
                false,
            )
            .await?;
        let mut detail = parse_room_detail_html(&html, web_rid)?;
        // SSR 负载携带会话自身的 web id。把它附加到不透明的原始负载上，
        // 使弹幕 WSS 用与访问房间页相同的指纹签名，
        // 而不是本地随机 id。
        if let Some(web_id) = parse_render_data_web_id(&html)
            .or_else(|| session_web_id(&self.cookie().unwrap_or_default()))
            && let Some(obj) = detail.raw.as_object_mut()
        {
            obj.insert("user_unique_id".into(), Value::String(web_id));
        }
        Ok(detail)
    }

    /// 对公开 Web 房间号避免使用需浏览器签名的 web-enter 接口。
    /// SSR 页面提供内部房间 id，
    /// 官方回源接口无需重放登录 Cookie 即可提供线路元数据。
    async fn get_ssr_room_detail_or_reflow(&self, web_rid: &str) -> AppResult<LiveRoomDetail> {
        let ssr_detail = self.get_room_detail_from_html(web_rid).await?;
        if !ssr_detail.status || has_playable_stream(&ssr_detail) {
            return Ok(ssr_detail);
        }

        // 没有线路的直播 SSR 负载无法播放。保留回源失败原因，
        // 而不是返回不可用的元数据，
        // 把有用的诊断（如浏览器验证）掩盖成笼统的"无线路"错误。
        let internal_room_id = reflow_room_id(&ssr_detail)?;
        self.get_reflow_room_detail(&internal_room_id).await
    }

    /// Web 房间页在其 SSR 负载中暴露开播状态。与房间详情解析不同，
    /// 这里刻意不检查线路数据，也不为播放元数据解析回源兜底。
    async fn get_ssr_room_live_status(&self, web_rid: &str) -> AppResult<LiveRoomStatus> {
        let html = self.get_ssr_page(web_rid).await?;
        parse_room_live_status_html(&html)
    }

    /// 抖音内部房间 id 使用轻量的回源房间信封。关注刷新只读取其状态与开播时间。
    async fn get_reflow_room_live_status(&self, room_id: &str) -> AppResult<LiveRoomStatus> {
        let root = self.get_reflow_room(room_id).await?;
        parse_reflow_room_live_status(&root)
    }

    /// 来自 Web 首页信息流的一批轮换数据。无需请求签名；
    /// `ensure_web_session` 获得的临时 `ttwid` 足以匿名访问，
    /// 存在已保存账号 Cookie 时会一并发送。
    async fn get_recommend_feed(&self) -> AppResult<RoomListPage> {
        self.ensure_web_session().await?;
        let params = vec![
            ("aid".into(), "6383".into()),
            ("app_name".into(), "douyin_web".into()),
            ("need_map".into(), "1".into()),
            ("is_draw".into(), "1".into()),
            ("inner_from_drawer".into(), "0".into()),
            (
                "enter_source".into(),
                "web_homepage_hot_web_live_card".into(),
            ),
            ("source_key".into(), "web_homepage_hot_web_live_card".into()),
        ];
        let value = self
            .get_json(RECOMMEND_FEED_URL, &params, &format!("{LIVE_ROOT}hot_live"))
            .await?;
        parse_recommend_feed(&value)
    }
}

#[async_trait::async_trait]
impl LiveSite for DouyinSite {
    fn danmaku_session_cookie(&self) -> AppResult<Option<String>> {
        let cookie = self.cookie()?;
        Ok((!cookie.is_empty()).then_some(cookie))
    }

    async fn get_categories(&self) -> AppResult<Vec<LiveCategory>> {
        self.ensure_web_session().await?;
        let html = self.get_text(LIVE_ROOT, &[], LIVE_ROOT, false).await?;
        parse_categories_html(&html)
    }

    async fn get_recommend_rooms(&self, page: u32) -> AppResult<RoomListPage> {
        // 优先使用 Web 首页信息流：每次调用都会产出一批部分轮换的结果，配合前端的
        // 跨页去重，可在每次刷新或加载更多时呈现新房间。该信息流没有分页游标，
        // 因此每个页码只是再请求一批；由于相邻批次高度重叠，
        // 会并发抓取多批。信息流不可用时（风控、空负载），
        // 回退到热门分区浏览 —— 它通过合成分区 id 稳定分页，
        // 其第一页与 `hot_live` SSR 负载一致，
        // 仅作为该页的最后兜底保留。
        let page = page.max(1);
        let requests = (0..RECOMMEND_FEED_BATCHES).map(|_| self.get_recommend_feed());
        let results = futures_util::future::join_all(requests).await;
        let batches = results.into_iter().flatten().collect::<Vec<_>>();
        let combined = combine_feed_batches(batches);
        if !combined.items.is_empty() {
            return Ok(combined);
        }
        match self
            .get_partition_rooms(
                RECOMMEND_PARTITION_ID,
                RECOMMEND_PARTITION_TYPE,
                page,
                &format!("{LIVE_ROOT}hot_live"),
            )
            .await
        {
            Ok(rooms) => Ok(rooms),
            // 即使签名接口不可用也要保证首屏可用；
            // 后续页面没有 SSR 等价物可供兜底。
            Err(error) if page == 1 => match self.get_ssr_page("hot_live").await {
                Ok(html) => parse_ssr_rooms(&html),
                Err(_) => Err(error),
            },
            Err(error) => Err(error),
        }
    }

    async fn get_category_rooms(
        &self,
        category: &LiveSubCategory,
        page: u32,
    ) -> AppResult<RoomListPage> {
        let (partition, partition_type) = category_partition(category)?;
        self.get_partition_rooms(
            partition,
            partition_type,
            page.max(1),
            &format!("{LIVE_ROOT}category/{partition}_{partition_type}"),
        )
        .await
    }

    async fn search_rooms(&self, keyword: &str, page: u32) -> AppResult<RoomListPage> {
        let keyword = keyword.trim();
        if keyword.is_empty() {
            return Ok(RoomListPage::empty());
        }
        self.ensure_web_session().await?;
        let page = page.max(1);
        let params = vec![
            ("device_platform".into(), "webapp".into()),
            ("aid".into(), "6383".into()),
            ("channel".into(), "channel_pc_web".into()),
            ("search_channel".into(), "aweme_live".into()),
            ("keyword".into(), keyword.to_string()),
            ("search_source".into(), "switch_tab".into()),
            ("query_correct_type".into(), "1".into()),
            ("is_filter_search".into(), "0".into()),
            ("offset".into(), ((page - 1) * 10).to_string()),
            ("count".into(), "10".into()),
            ("pc_client_type".into(), "1".into()),
            ("version_code".into(), "170400".into()),
            ("version_name".into(), "17.4.0".into()),
            ("cookie_enabled".into(), "true".into()),
            ("screen_width".into(), "1980".into()),
            ("screen_height".into(), "1080".into()),
            ("browser_language".into(), "zh-CN".into()),
            ("browser_platform".into(), "Win32".into()),
            ("browser_name".into(), "Edge".into()),
            ("browser_version".into(), "125.0.0.0".into()),
            ("browser_online".into(), "true".into()),
            ("engine_name".into(), "Blink".into()),
            ("engine_version".into(), "125.0.0.0".into()),
            ("os_name".into(), "Windows".into()),
            ("os_version".into(), "10".into()),
            ("platform".into(), "PC".into()),
        ];
        let result = self
            .get_json(
                LIVE_SEARCH_URL,
                &params,
                &format!("https://www.douyin.com/search/{keyword}?type=live"),
            )
            .await?;
        parse_search_rooms(&result)
    }

    async fn get_room_live_status(&self, room_id: &str) -> AppResult<LiveRoomStatus> {
        let room_id = normalize_room_id(room_id)?;
        // 公开 Web 房间号较短，而回源返回的内部 id 更长。公开路径保持在 SSR 页面上，
        // 使刷新关注绝不需要为了知道开播状态而去构建播放元数据。
        if room_id.len() <= 16 {
            self.get_ssr_room_live_status(&room_id).await
        } else {
            self.get_reflow_room_live_status(&room_id).await
        }
    }

    async fn get_room_detail(&self, room_id: &str) -> AppResult<LiveRoomDetail> {
        let room_id = normalize_room_id(room_id)?;
        if room_id.len() <= 16 {
            self.get_ssr_room_detail_or_reflow(&room_id).await
        } else {
            self.get_reflow_room_detail(&room_id).await
        }
    }

    async fn get_play_qualities(&self, detail: &LiveRoomDetail) -> AppResult<Vec<LivePlayQuality>> {
        if !detail.status {
            return Err(AppError::new(
                "douyin_not_live",
                "该抖音直播间当前未开播，无法获取播放地址",
            )
            .with_site("douyin"));
        }
        let stream_url = detail
            .raw
            .get("stream_url")
            .or_else(|| detail.raw.get("streamUrl"))
            .unwrap_or(&Value::Null);
        parse_play_qualities(stream_url)
    }

    async fn get_play_urls(
        &self,
        detail: &LiveRoomDetail,
        quality: &LivePlayQuality,
    ) -> AppResult<Vec<PlayUrl>> {
        let Some(values) = quality.data.get("urls").and_then(Value::as_array) else {
            return Err(Self::parse_err("播放清晰度缺少 URL 数据"));
        };
        let mut headers = HashMap::new();
        headers.insert("user-agent".into(), DEFAULT_USER_AGENT.into());
        headers.insert(
            "referer".into(),
            format!("https://live.douyin.com/{}", detail.room_id),
        );

        let mut urls = Vec::new();
        for (index, value) in values.iter().enumerate() {
            let url = json_str(value);
            if !is_http_url(&url) || urls.iter().any(|item: &PlayUrl| item.url == url) {
                continue;
            }
            urls.push(PlayUrl::inferred(
                format!("douyin:{}", index + 1),
                format!("线路{}", index + 1),
                index as u32,
                url,
                headers.clone(),
            ));
        }
        if urls.is_empty() {
            return Err(Self::err("抖音播放地址为空或已失效，请刷新直播间后重试"));
        }
        Ok(urls)
    }
}

fn numeric_id<'a>(value: &'a str, label: &str) -> AppResult<&'a str> {
    if value.is_empty() || value.len() > 32 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(
            AppError::new("douyin_invalid_id", format!("无效的抖音{label}")).with_site("douyin"),
        );
    }
    Ok(value)
}

fn normalize_room_id(room_id: &str) -> AppResult<String> {
    let room_id = room_id.trim();
    let room_id = room_id
        .strip_prefix("https://live.douyin.com/")
        .or_else(|| room_id.strip_prefix("http://live.douyin.com/"))
        .unwrap_or(room_id);
    let room_id = room_id
        .split(['?', '#', '/'])
        .next()
        .unwrap_or_default()
        .trim();
    Ok(numeric_id(room_id, "房间号")?.to_string())
}

fn normalize_cookie(value: &str) -> String {
    merge_cookie_values(
        "",
        value.trim().strip_prefix("Cookie:").unwrap_or(value).trim(),
    )
}

/// 保存的账号 cookie 的作用域限定为抖音自有 Web 主机。保持这条边界显式可见，
/// 因为房间回源 API 托管在 amemv.com 上。
fn is_douyin_cookie_url(value: &str) -> bool {
    Url::parse(value)
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
        .is_some_and(|host| host == "douyin.com" || host.ends_with(".douyin.com"))
}

fn cookie_pairs(value: &str) -> Vec<(String, String)> {
    value
        .split(';')
        .filter_map(|part| {
            let (key, value) = part.trim().split_once('=')?;
            let key = key.trim();
            if key.is_empty() {
                None
            } else {
                Some((key.to_string(), value.trim().to_string()))
            }
        })
        .collect()
}

/// 本次首页引导相对于访问前的 cookie 新增或刷新了哪些键值对。只有这些匿名
/// 会话取值会进入进程级共享缓存；
/// 已保存的账号取值绝不进入。
fn changed_cookie_pairs(before: &str, after: &str) -> Vec<(String, String)> {
    let previous = cookie_pairs(before);
    cookie_pairs(after)
        .into_iter()
        .filter(|(key, value)| {
            !previous
                .iter()
                .any(|(old_key, old_value)| old_key.eq_ignore_ascii_case(key) && old_value == value)
        })
        .collect()
}

fn merge_cookie_values(base: &str, updates: &str) -> String {
    let mut merged = cookie_pairs(base);
    for (key, value) in cookie_pairs(updates) {
        if let Some((_, previous)) = merged
            .iter_mut()
            .find(|(previous_key, _)| previous_key.eq_ignore_ascii_case(&key))
        {
            *previous = value;
        } else {
            merged.push((key, value));
        }
    }
    merged
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("; ")
}

fn is_safe_session_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4_096
        && !value
            .bytes()
            .any(|byte| byte == b';' || byte.is_ascii_control())
}

/// 对一个 query 组成部分做百分号编码，只保留 unreserved 集合。
///
/// `a_bogus` 签的是字面 query 字符串，因此被签名的取值与实际发送的取值
/// 必须采用完全相同的编码。放在这里可以让两侧共用同一个实现。
fn url_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn encode_query(params: &[(String, String)]) -> String {
    params
        .iter()
        .map(|(key, value)| format!("{}={}", url_encode(key), url_encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

/// 构造 Web 客户端在列表调用中发送的一次性 `msToken`。
///
/// 上游取值是不透明的浏览器 token。接口只检查其形态，
/// 因此每个请求生成一条预期长度的随机字符串即可；
/// 它被刻意设计为不持久化、也不作为标识符复用。
fn generate_ms_token() -> String {
    // uuid v4 已经是 CSPRNG 支持的来源，而且本来就是依赖，
    // 不必为了填充一次性 token 再引入 `rand`。
    let mut token = String::with_capacity(MS_TOKEN_LENGTH);
    while token.len() < MS_TOKEN_LENGTH {
        for byte in uuid::Uuid::new_v4().as_bytes() {
            if token.len() == MS_TOKEN_LENGTH {
                break;
            }
            let index = usize::from(*byte) % MS_TOKEN_CHARSET.len();
            token.push(char::from(MS_TOKEN_CHARSET[index]));
        }
    }
    token
}

/// 把存储的分类 id 拆分为抖音的 `partition` 与 `partition_type`。
///
/// [`parse_categories_html`] 把它们以 `id,type` 形式拼接存储；
/// 浏览接口需要它们作为独立参数。两者都必须是数字，
/// 使任何一方都无法向签名后的字符串注入额外的 query 参数。
fn split_partition(category_id: &str) -> AppResult<(&str, &str)> {
    let (partition, partition_type) = category_id
        .split_once(',')
        .ok_or_else(|| DouyinSite::parse_err("抖音分区标识缺少类型，请刷新分类后重试"))?;
    Ok((
        numeric_id(partition.trim(), "分区标识")?,
        numeric_id(partition_type.trim(), "分区类型")?,
    ))
}

/// 解析某个分类要浏览的 `partition` / `partition_type`。
///
/// 分类浏览器会在最前面放一个 id 为 `0` 的合成"全部<分区>"条目，
/// 它不是真实分区；浏览它等于浏览其父分区。
fn category_partition(category: &LiveSubCategory) -> AppResult<(&str, &str)> {
    let id = if category.id.trim() == "0" {
        category.parent_id.trim()
    } else {
        category.id.trim()
    };
    split_partition(id)
}

/// 读取可分页浏览接口的一页。
///
/// 抖音在这里不发送 `has_more`，因此只有当返回的是整页、且其自身的 `offset`
/// 持续越过所请求的值时才假设还有下一页。这可以避免 UI 提供一个
/// 永远返回相同房间的"加载更多"。
fn parse_partition_rooms(value: &Value, requested_offset: u32) -> AppResult<RoomListPage> {
    let data = value
        .get("data")
        .ok_or_else(|| DouyinSite::parse_err("抖音房间列表缺少 data"))?;
    let rooms = data
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| DouyinSite::parse_err("抖音房间列表缺少 data 数组"))?;
    let items = rooms
        .iter()
        .filter_map(|item| room_item_from_value(item.get("room").unwrap_or(item)))
        .collect::<Vec<_>>();

    let next_offset = data.get("offset").map(json_i64).unwrap_or_default();
    let advanced = next_offset > i64::from(requested_offset);
    let has_more = match data.get("has_more").and_then(Value::as_bool) {
        Some(has_more) => has_more && advanced,
        None => rooms.len() >= LIST_PAGE_SIZE as usize && advanced,
    };

    Ok(RoomListPage { has_more, items })
}

/// 解析 Web 首页信息流的一批轮换数据。
///
/// 负载是信封列表，每个信封把一个房间包装成对象或内嵌 JSON 字符串
/// （两种形态都观测到过）。广告卡片与没有可用房间号的条目会被丢弃；
/// 同一批次内的重复房间号会被合并。
fn parse_recommend_feed(value: &Value) -> AppResult<RoomListPage> {
    let envelopes = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| DouyinSite::parse_err("抖音推荐流缺少 data 数组"))?;
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    for envelope in envelopes {
        let Some(item) = feed_room_item(envelope) else {
            continue;
        };
        if seen.insert(item.room_id.clone()) {
            items.push(item);
        }
    }
    // 非空批次说明信息流还有更多：下一次请求会返回另一份部分轮换的选择。
    // 空批次则结束。
    Ok(RoomListPage {
        has_more: !items.is_empty(),
        items,
    })
}

/// 把并发的信息流批次合并为一页，保留每个房间的首次出现并维持批次顺序。
fn combine_feed_batches(batches: Vec<RoomListPage>) -> RoomListPage {
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    for batch in batches {
        for item in batch.items {
            if seen.insert(item.room_id.clone()) {
                items.push(item);
            }
        }
    }
    RoomListPage {
        has_more: !items.is_empty(),
        items,
    }
}

/// 从一个信息流信封中提取房间条目。
fn feed_room_item(envelope: &Value) -> Option<LiveRoomItem> {
    if envelope
        .get("is_ad")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    let owned;
    let room = match envelope.get("data") {
        Some(value) if value.is_object() => value,
        Some(Value::String(text)) if text.trim_start().starts_with('{') => {
            owned = serde_json::from_str(text).ok()?;
            &owned
        }
        // 某些代次的信封直接携带房间字段。
        _ => envelope,
    };
    let mut item = room_item_from_value(room)?;
    // 公开的短 web_rid 附着在信封上；优先使用它而不是内部长 id，
    // 使详情/播放请求继续走快速的 SSR 路径而不是回源。
    let web_rid = first_non_empty([
        json_str(envelope.get("web_rid").unwrap_or(&Value::Null)),
        json_str(room.pointer("/owner/web_rid").unwrap_or(&Value::Null)),
    ]);
    if !web_rid.is_empty() {
        item.room_id = web_rid;
    }
    Some(item)
}

fn json_i64_opt(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
        .or_else(|| value.as_str().and_then(|number| number.trim().parse().ok()))
}

fn json_i64(value: &Value) -> i64 {
    json_i64_opt(value).unwrap_or(0)
}

fn json_str(value: &Value) -> String {
    match value {
        Value::String(value) => value.trim().to_string(),
        Value::Number(value) => value.to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn first_non_empty(values: impl IntoIterator<Item = String>) -> String {
    values
        .into_iter()
        .find(|value| !value.trim().is_empty())
        .unwrap_or_default()
}

fn first_image_url(value: &Value) -> String {
    match value {
        Value::String(value) => normalize_image_url(value),
        Value::Array(values) => values
            .iter()
            .map(first_image_url)
            .find(|value| !value.is_empty())
            .unwrap_or_default(),
        Value::Object(object) => {
            for key in [
                "url_list",
                "url",
                "uri",
                "icon",
                "icons",
                "cover",
                "background",
                "avatar_thumb",
                "image",
                "image_url",
                "static_icon",
            ] {
                if let Some(candidate) = object.get(key) {
                    let url = first_image_url(candidate);
                    if !url.is_empty() {
                        return url;
                    }
                }
            }
            String::new()
        }
        _ => String::new(),
    }
}

/// 归一化一个图片地址，丢弃任何无法抓取的内容。
///
/// 抖音图片对象同时携带 `url_list`（真实 CDN 地址）和 `uri`
/// （裸存储键，如 `aweme-avatar/tos-cn-i-0813_…`）。当 `url_list` 缺失或为空时，
/// [`first_image_url`] 的键查找会落到 `uri` 上，而这个值什么也加载不了：
/// 前端会丢弃它，存了它的录制会一直保持空白缩略图。在这里拒绝它，
/// 让调用方继续处理下一个候选 —— 实践中就是主播头像 ——
/// 而不是持久化一个永远无法渲染的地址。
fn normalize_image_url(value: &str) -> String {
    let value = value.trim();
    let normalized = match value.strip_prefix("//") {
        Some(rest) => format!("https://{rest}"),
        None => value.to_string(),
    };
    if is_http_url(&normalized) {
        normalized
    } else {
        String::new()
    }
}

fn is_http_url(value: &str) -> bool {
    value.starts_with("https://") || value.starts_with("http://")
}

/// 解码嵌在抖音 RSC JavaScript 字符串中的一个 JSON 值。
///
/// 页面包含形如 `roomsData\":{\"count\":15,...}` 的文本。
/// 普通的括号扫描会被 `stream_data` 中的花括号干扰，
/// 因此在先解码外层字符串转义之后扫描，
/// 并正确处理 JSON 字符串边界。
fn decode_embedded_json_value(source: &str, opening: char) -> AppResult<String> {
    let closing = match opening {
        '{' => '}',
        '[' => ']',
        _ => {
            return Err(
                AppError::new("douyin_parse_error", "unsupported embedded JSON delimiter")
                    .with_site("douyin"),
            );
        }
    };

    let mut output = String::new();
    let mut chars = source.chars();
    let mut depth = 0i32;
    let mut in_string = false;
    let mut json_escape = false;

    while let Some(character) = chars.next() {
        let decoded = if character == '\\' {
            let escaped = chars.next().ok_or_else(|| {
                AppError::new("douyin_parse_error", "truncated embedded JSON escape")
                    .with_site("douyin")
            })?;
            match escaped {
                '"' => '"',
                '\\' => '\\',
                '/' => '/',
                'b' => '\u{0008}',
                'f' => '\u{000C}',
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                'u' => {
                    let hex = chars.by_ref().take(4).collect::<String>();
                    if hex.len() != 4 {
                        return Err(AppError::new(
                            "douyin_parse_error",
                            "truncated embedded unicode escape",
                        )
                        .with_site("douyin"));
                    }
                    let code = u32::from_str_radix(&hex, 16).map_err(|_| {
                        AppError::new("douyin_parse_error", "invalid embedded unicode escape")
                            .with_site("douyin")
                    })?;
                    // 让孤立代理项转义保持对 serde_json 合法；
                    // 合法的 Unicode 转义可以直接解码。
                    if let Some(character) = char::from_u32(code) {
                        character
                    } else {
                        output.push_str("\\u");
                        output.push_str(&hex);
                        continue;
                    }
                }
                other => other,
            }
        } else {
            character
        };

        output.push(decoded);
        if in_string {
            if json_escape {
                json_escape = false;
            } else if decoded == '\\' {
                json_escape = true;
            } else if decoded == '"' {
                in_string = false;
            }
            continue;
        }

        if decoded == '"' {
            in_string = true;
        } else if decoded == opening {
            depth += 1;
        } else if decoded == closing {
            depth -= 1;
            if depth == 0 {
                return Ok(output);
            }
        }
    }

    Err(AppError::new("douyin_parse_error", "embedded JSON is not balanced").with_site("douyin"))
}

fn extract_embedded_json(source: &str, key: &str, opening: char) -> AppResult<String> {
    for (index, _) in source.match_indices(key) {
        let tail = &source[index + key.len()..];
        let Some(start) = tail.find(opening) else {
            continue;
        };
        // 真实的对象/数组值紧跟在转义冒号之后的键名后面。
        // 这样可以避免在庞大的 RSC 负载中误扫到远处无关的 JS 标识符。
        if start > 96 {
            continue;
        }
        if let Ok(value) = decode_embedded_json_value(&tail[start..], opening) {
            return Ok(value);
        }
    }
    Err(AppError::new(
        "douyin_parse_error",
        format!("Douyin SSR payload missing {key}"),
    )
    .with_site("douyin"))
}

fn parse_categories_html(html: &str) -> AppResult<Vec<LiveCategory>> {
    let raw = extract_embedded_json(html, "categoryData", '[')?;
    let data: Value = serde_json::from_str(&raw)
        .map_err(|error| DouyinSite::parse_err(format!("分类 SSR JSON 解析失败: {error}")))?;
    let Some(categories) = data.as_array() else {
        return Err(DouyinSite::parse_err("分类 SSR 数据不是数组"));
    };

    let mut output = Vec::new();
    for category in categories {
        let partition = category.get("partition").unwrap_or(&Value::Null);
        let id = partition_id(partition);
        let name = json_str(partition.get("title").unwrap_or(&Value::Null));
        if id.is_empty() || name.is_empty() {
            continue;
        }
        let image = first_image_url(partition);
        let mut children = vec![LiveSubCategory {
            id: id.clone(),
            name: name.clone(),
            parent_id: id.clone(),
            pic: (!image.is_empty()).then_some(image.clone()),
        }];
        collect_subcategories(category.get("sub_partition"), &id, &image, &mut children);
        output.push(LiveCategory { id, name, children });
    }
    if output.is_empty() {
        return Err(DouyinSite::parse_err("未在抖音 SSR 页面中找到直播分类"));
    }
    Ok(output)
}

fn partition_id(partition: &Value) -> String {
    let id = first_non_empty([
        json_str(partition.get("id_str").unwrap_or(&Value::Null)),
        json_str(partition.get("id").unwrap_or(&Value::Null)),
        json_str(partition.get("partition_id").unwrap_or(&Value::Null)),
    ]);
    let partition_type = first_non_empty([
        json_str(partition.get("type").unwrap_or(&Value::Null)),
        json_str(partition.get("partition_type").unwrap_or(&Value::Null)),
    ]);
    if id.is_empty() {
        String::new()
    } else if partition_type.is_empty() {
        id
    } else {
        format!("{id},{partition_type}")
    }
}

fn collect_subcategories(
    values: Option<&Value>,
    parent_id: &str,
    inherited_image: &str,
    output: &mut Vec<LiveSubCategory>,
) {
    let Some(values) = values.and_then(Value::as_array) else {
        return;
    };
    for item in values {
        let partition = item.get("partition").unwrap_or(&Value::Null);
        let id = partition_id(partition);
        let name = json_str(partition.get("title").unwrap_or(&Value::Null));
        if id.is_empty() || name.is_empty() {
            continue;
        }
        let image = first_image_url(partition);
        output.push(LiveSubCategory {
            id: id.clone(),
            name,
            parent_id: parent_id.to_string(),
            pic: (!image.is_empty())
                .then_some(image.clone())
                .or_else(|| (!inherited_image.is_empty()).then_some(inherited_image.to_string())),
        });
        collect_subcategories(
            item.get("sub_partition"),
            &id,
            if image.is_empty() {
                inherited_image
            } else {
                &image
            },
            output,
        );
    }
}

fn parse_ssr_rooms(html: &str) -> AppResult<RoomListPage> {
    let raw = extract_embedded_json(html, "roomsData", '{')?;
    let value: Value = serde_json::from_str(&raw)
        .map_err(|error| DouyinSite::parse_err(format!("房间列表 SSR JSON 解析失败: {error}")))?;
    parse_room_list_data(&value)
}

fn parse_room_list_data(value: &Value) -> AppResult<RoomListPage> {
    let data = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| DouyinSite::parse_err("抖音房间列表缺少 data 数组"))?;
    let items = data
        .iter()
        .filter_map(|item| room_item_from_value(item.get("room").unwrap_or(item)))
        .collect::<Vec<_>>();
    Ok(RoomListPage {
        // `roomsData.offset` 始终是首个 SSR 页面的下一页偏移，
        // 即使调用方附加了 `offset` query。不要向 UI 宣告不存在的下一页、
        // 喂进重复房间。
        has_more: false,
        items,
    })
}

fn parse_search_rooms(value: &Value) -> AppResult<RoomListPage> {
    let data = value
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut items = Vec::new();
    for item in data {
        let raw = item
            .pointer("/lives/rawdata")
            .or_else(|| item.pointer("/live/rawdata"))
            .and_then(Value::as_str);
        let room = raw
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .unwrap_or(item);
        if let Some(room) = room_item_from_value(&room) {
            items.push(room);
        }
    }
    let has_more = value
        .get("has_more")
        .and_then(Value::as_bool)
        .unwrap_or(items.len() >= 10);
    Ok(RoomListPage { has_more, items })
}

fn room_item_from_value(room: &Value) -> Option<LiveRoomItem> {
    let owner = room.get("owner").unwrap_or(&Value::Null);
    let room_id = first_non_empty([
        json_str(owner.get("web_rid").unwrap_or(&Value::Null)),
        json_str(room.get("web_rid").unwrap_or(&Value::Null)),
        json_str(room.get("id_str").unwrap_or(&Value::Null)),
        json_str(room.get("id").unwrap_or(&Value::Null)),
    ]);
    if room_id.is_empty() {
        return None;
    }
    Some(LiveRoomItem {
        site_id: SiteId::Douyin,
        room_id,
        title: json_str(room.get("title").unwrap_or(&Value::Null)),
        cover: first_image_url(room.get("cover").unwrap_or(&Value::Null)),
        user_name: first_non_empty([
            json_str(owner.get("nickname").unwrap_or(&Value::Null)),
            json_str(room.pointer("/user/nickname").unwrap_or(&Value::Null)),
        ]),
        online: first_non_empty_i64([
            room.pointer("/room_view_stats/display_value"),
            room.pointer("/stats/total_user"),
            room.get("user_count"),
            room.get("user_count_str"),
        ]),
        live_status: None,
    })
}

fn first_non_empty_i64<'a>(values: impl IntoIterator<Item = Option<&'a Value>>) -> i64 {
    values
        .into_iter()
        .flatten()
        .map(json_i64)
        .find(|value| *value != 0)
        .unwrap_or(0)
}

fn parse_reflow_room_detail(root: &Value, requested_room_id: &str) -> AppResult<LiveRoomDetail> {
    let data = root
        .get("data")
        .ok_or_else(|| DouyinSite::parse_err("抖音 reflow 接口缺少 data"))?;
    let room = data
        .get("room")
        .ok_or_else(|| DouyinSite::parse_err("抖音 reflow 接口未返回房间数据"))?;
    parse_room_detail(room, data.get("user"), requested_room_id)
}

fn parse_reflow_room_live_status(root: &Value) -> AppResult<LiveRoomStatus> {
    let data = root
        .get("data")
        .ok_or_else(|| DouyinSite::parse_err("抖音 reflow 接口缺少 data"))?;
    let room = data
        .get("room")
        .ok_or_else(|| DouyinSite::parse_err("抖音 reflow 接口未返回房间数据"))?;
    parse_room_live_status(room)
}

fn parse_room_live_status_html(html: &str) -> AppResult<LiveRoomStatus> {
    for (index, _) in html.match_indices("roomInfo") {
        let tail = &html[index + "roomInfo".len()..];
        let Some(start) = tail.find('{') else {
            continue;
        };
        if start > 96 {
            continue;
        }
        let Ok(raw) = decode_embedded_json_value(&tail[start..], '{') else {
            continue;
        };
        let Ok(info) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        if let Some(room) = info.get("room") {
            return parse_room_live_status(room);
        }
    }
    Err(DouyinSite::parse_err(
        "抖音直播页未包含可用房间状态，可能已下播或页面结构发生变化",
    ))
}

/// 只读取与房间直播状态一起渲染的字段。把它与 `parse_room_detail` 分开，
/// 可以从结构上杜绝关注刷新意外保留线路地址
/// 或触发其解析路径的可能。
fn parse_room_live_status(room: &Value) -> AppResult<LiveRoomStatus> {
    if !room.is_object() {
        return Err(DouyinSite::parse_err("抖音房间状态数据格式异常"));
    }
    let status = json_i64(
        room.get("status")
            .or_else(|| room.get("live_status"))
            .or_else(|| room.get("room_status"))
            .unwrap_or(&Value::Null),
    ) == 2;
    Ok(LiveRoomStatus {
        status,
        live_started_at: status
            .then(|| {
                parse_live_started_at(
                    room.get("live_start_time")
                        .or_else(|| room.get("start_time"))
                        .or_else(|| room.get("room_start_time")),
                )
            })
            .flatten(),
    })
}

fn parse_room_detail_html(html: &str, requested_web_rid: &str) -> AppResult<LiveRoomDetail> {
    for (index, _) in html.match_indices("roomInfo") {
        let tail = &html[index + "roomInfo".len()..];
        let Some(start) = tail.find('{') else {
            continue;
        };
        if start > 96 {
            continue;
        }
        let Ok(raw) = decode_embedded_json_value(&tail[start..], '{') else {
            continue;
        };
        let Ok(info) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        if let Some(room) = info.get("room") {
            return parse_room_detail(room, info.get("anchor"), requested_web_rid);
        }
    }
    Err(DouyinSite::parse_err(
        "抖音直播页未包含可用房间数据，可能已下播或页面结构发生变化",
    ))
}

/// 房间页的 `RENDER_DATA` 脚本携带会话自身的 web id
/// （`app.odin.user_unique_id`）。优先使用它而不是本地生成的 id，
/// 使 WSS 请求指纹与同一浏览器会话的 cookie 相互对应 ——
/// webcast 风控引擎正是据此关联的。
fn parse_render_data_web_id(html: &str) -> Option<String> {
    const MARKER: &str = r#"<script id="RENDER_DATA" type="application/json">"#;
    let start = html.find(MARKER)?;
    let body_start = start + MARKER.len();
    let body = html.get(body_start..)?;
    let body = &body[..body.find("</script>")?];
    let value: Value = serde_json::from_str(&percent_decode(body)).ok()?;
    match value.pointer("/app/odin/user_unique_id")? {
        Value::String(id) if !id.is_empty() => Some(id.clone()),
        Value::Number(id) => Some(id.to_string()),
        _ => None,
    }
}

/// 百分号解码但不套用 URL 表单的 `+` → 空格规则；`RENDER_DATA` 只用百分号
/// 转义，而字面加号是合法 JSON。
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let high = (bytes[index + 1] as char).to_digit(16);
            let low = (bytes[index + 2] as char).to_digit(16);
            if let (Some(high), Some(low)) = (high, low) {
                decoded.push((high * 16 + low) as u8);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

/// 兜底 web id：`s_v_web_id` cookie 是同一会话的真实浏览器指纹，
/// 在 `RENDER_DATA` 缺少显式 id 时使用。
///
/// 多数 cookie 携带的 `verify_…` 指纹无法被弹幕签名消费（过长，且 `_` 会在
/// 带分隔符的 stub 中伪造字段）；这些会被丢弃，
/// 使弹幕层保留其匿名 id 而不是让握手失败。
fn session_web_id(cookie: &str) -> Option<String> {
    cookie
        .split(';')
        .map(str::trim)
        .find_map(|pair| pair.strip_prefix("s_v_web_id="))
        .filter(|id| crate::danmu_rs::douyin_sign::is_valid_web_id(id))
        .map(str::to_string)
}

fn parse_room_detail(
    room: &Value,
    fallback_user: Option<&Value>,
    requested_id: &str,
) -> AppResult<LiveRoomDetail> {
    if !room.is_object() {
        return Err(DouyinSite::parse_err("抖音房间数据格式异常"));
    }
    let owner = room.get("owner").unwrap_or(&Value::Null);
    let fallback_user = fallback_user.unwrap_or(&Value::Null);
    let room_id = first_non_empty([
        json_str(owner.get("web_rid").unwrap_or(&Value::Null)),
        json_str(room.get("web_rid").unwrap_or(&Value::Null)),
        requested_id.to_string(),
    ]);
    let actual_room_id = first_non_empty([
        json_str(room.get("id_str").unwrap_or(&Value::Null)),
        json_str(room.get("id").unwrap_or(&Value::Null)),
        requested_id.to_string(),
    ]);
    let owner_name = first_non_empty([
        json_str(owner.get("nickname").unwrap_or(&Value::Null)),
        json_str(fallback_user.get("nickname").unwrap_or(&Value::Null)),
    ]);
    let avatar = first_non_empty([
        first_image_url(owner.get("avatar_thumb").unwrap_or(&Value::Null)),
        first_image_url(fallback_user.get("avatar_thumb").unwrap_or(&Value::Null)),
    ]);
    let status = json_i64(
        room.get("status")
            .or_else(|| room.get("live_status"))
            .or_else(|| room.get("room_status"))
            .unwrap_or(&Value::Null),
    ) == 2;
    let stream_url = room.get("stream_url").cloned().unwrap_or(Value::Null);

    Ok(LiveRoomDetail {
        site_id: SiteId::Douyin,
        room_id: room_id.clone(),
        title: json_str(room.get("title").unwrap_or(&Value::Null)),
        cover: if status {
            first_image_url(room.get("cover").unwrap_or(&Value::Null))
        } else {
            String::new()
        },
        user_name: owner_name,
        user_avatar: avatar,
        online: if status {
            first_non_empty_i64([
                room.pointer("/room_view_stats/display_value"),
                room.pointer("/stats/total_user"),
                room.get("user_count"),
                room.get("user_count_str"),
            ])
        } else {
            0
        },
        status,
        live_started_at: parse_live_started_at(
            room.get("live_start_time")
                .or_else(|| room.get("start_time"))
                .or_else(|| room.get("room_start_time")),
        ),
        notice: first_non_empty([
            json_str(owner.get("signature").unwrap_or(&Value::Null)),
            json_str(fallback_user.get("signature").unwrap_or(&Value::Null)),
        ]),
        url: format!("https://live.douyin.com/{room_id}"),
        raw: serde_json::json!({
            "room_id": actual_room_id,
            "web_rid": room_id,
            "stream_url": stream_url,
        }),
    })
}

fn reflow_room_id(detail: &LiveRoomDetail) -> AppResult<String> {
    let room_id = detail.raw.get("room_id").map(json_str).unwrap_or_default();
    let room_id = numeric_id(&room_id, "内部房间号")?;
    if room_id.len() <= 16 {
        return Err(DouyinSite::parse_err("抖音房间接口未返回内部房间号"));
    }
    Ok(room_id.to_string())
}

fn has_playable_stream(detail: &LiveRoomDetail) -> bool {
    detail
        .raw
        .get("stream_url")
        .or_else(|| detail.raw.get("streamUrl"))
        .is_some_and(|stream_url| parse_play_qualities(stream_url).is_ok())
}

fn parse_play_qualities(stream_url: &Value) -> AppResult<Vec<LivePlayQuality>> {
    if !stream_url.is_object() {
        return Err(DouyinSite::parse_err("抖音房间未提供直播流数据"));
    }
    let stream_data = stream_url
        .pointer("/live_core_sdk_data/pull_data/stream_data")
        .and_then(Value::as_str)
        .and_then(|data| serde_json::from_str::<Value>(data).ok())
        .unwrap_or(Value::Null);
    let qualities = stream_url
        .pointer("/live_core_sdk_data/pull_data/options/qualities")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut result = Vec::new();
    for quality in qualities {
        if json_i64(quality.get("disable").unwrap_or(&Value::Null)) != 0 {
            continue;
        }
        let key = json_str(quality.get("sdk_key").unwrap_or(&Value::Null));
        let level = json_i64(quality.get("level").unwrap_or(&Value::Null));
        let mut urls = stream_urls_for_sdk_key(&stream_data, &key);
        if urls.is_empty() {
            urls = fallback_urls_for_sdk_key(stream_url, &key, level);
        }
        if urls.is_empty() {
            continue;
        }
        let name = json_str(quality.get("name").unwrap_or(&Value::Null));
        result.push((
            level,
            LivePlayQuality {
                quality: if name.is_empty() {
                    quality_name(&key)
                } else {
                    name
                },
                data: serde_json::json!({ "urls": urls, "level": level, "sdk_key": key }),
            },
        ));
    }

    if result.is_empty() {
        result = fallback_qualities(stream_url);
    }
    result.sort_by(|(left, _), (right, _)| right.cmp(left));
    let result = result
        .into_iter()
        .map(|(_, quality)| quality)
        .collect::<Vec<_>>();
    if result.is_empty() {
        return Err(DouyinSite::err("抖音直播流中未找到可播放的清晰度"));
    }
    Ok(result)
}

fn stream_urls_for_sdk_key(stream_data: &Value, key: &str) -> Vec<String> {
    if key.is_empty() {
        return Vec::new();
    }
    let main = stream_data
        .pointer(&format!("/data/{key}/main"))
        .unwrap_or(&Value::Null);
    dedupe_urls([main.get("flv"), main.get("hls"), main.get("hls_url")])
}

fn fallback_urls_for_sdk_key(stream_url: &Value, key: &str, level: i64) -> Vec<String> {
    let mut candidates = match key {
        "origin" => vec!["FULL_HD1", "ORIGIN"],
        "hd" => vec!["HD1", "HD"],
        "sd" => vec!["SD2", "SD"],
        "ld" => vec!["SD1", "LD"],
        "md" => vec!["MD", "LD"],
        _ => vec![key],
    };
    if candidates.is_empty() && level > 0 {
        candidates.push("HD1");
    }
    for candidate in candidates {
        let urls = urls_for_resolution(stream_url, candidate);
        if !urls.is_empty() {
            return urls;
        }
    }
    Vec::new()
}

fn urls_for_resolution(stream_url: &Value, resolution: &str) -> Vec<String> {
    dedupe_urls([
        stream_url.pointer(&format!("/flv_pull_url/{resolution}")),
        stream_url.pointer(&format!("/hls_pull_url_map/{resolution}")),
        stream_url.pointer(&format!("/hls_pull_url/{resolution}")),
    ])
}

fn dedupe_urls<'a>(values: impl IntoIterator<Item = Option<&'a Value>>) -> Vec<String> {
    let mut output = Vec::new();
    for value in values.into_iter().flatten() {
        collect_urls(value, &mut output);
    }
    output
}

fn collect_urls(value: &Value, output: &mut Vec<String>) {
    match value {
        Value::String(value) if is_http_url(value) => {
            if !output.iter().any(|candidate| candidate == value) {
                output.push(value.to_string());
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_urls(value, output);
            }
        }
        Value::Object(values) => {
            for key in ["url", "url_list", "main"] {
                if let Some(value) = values.get(key) {
                    collect_urls(value, output);
                }
            }
        }
        _ => {}
    }
}

fn fallback_qualities(stream_url: &Value) -> Vec<(i64, LivePlayQuality)> {
    let mut resolutions = stream_url
        .get("flv_pull_url")
        .and_then(Value::as_object)
        .map(|values| values.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    if resolutions.is_empty() {
        resolutions = stream_url
            .get("hls_pull_url_map")
            .and_then(Value::as_object)
            .map(|values| values.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
    }
    resolutions
        .into_iter()
        .filter_map(|resolution| {
            let urls = urls_for_resolution(stream_url, &resolution);
            if urls.is_empty() {
                return None;
            }
            let level = resolution_rank(&resolution);
            Some((
                level,
                LivePlayQuality {
                    quality: quality_name(&resolution),
                    data: serde_json::json!({
                        "urls": urls,
                        "level": level,
                        "sdk_key": resolution,
                    }),
                },
            ))
        })
        .collect()
}

fn resolution_rank(value: &str) -> i64 {
    let value = value.to_ascii_uppercase();
    if value.contains("FULL") || value.contains("ORIGIN") {
        100
    } else if value.starts_with("HD") {
        80
    } else if value == "SD2" || value == "SD" {
        60
    } else if value == "SD1" || value == "LD" {
        40
    } else if value == "MD" {
        20
    } else {
        0
    }
}

fn quality_name(value: &str) -> String {
    let value = value.to_ascii_lowercase();
    if value.contains("origin") || value.contains("full") {
        "原画".into()
    } else if value.starts_with("hd") {
        "高清".into()
    } else if value == "sd" || value == "sd2" {
        "标清".into()
    } else if value == "ld" || value == "sd1" || value == "md" {
        "流畅".into()
    } else if value == "ao" {
        "纯音频".into()
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    use super::*;

    /// 抖音图片对象总会在 `url_list` 旁附带裸的 `uri` 存储键。当 CDN 列表缺失或为
    /// 空时，键查找绝不能把这个键交回去：没有任何东西能抓取它，
    /// 存了它的录制将永远带着无法加载的缩略图。
    /// 房间详情随后会落到主播头像这一兜底上。
    #[test]
    fn image_lookup_skips_bare_storage_keys() {
        let uri_only = serde_json::json!({
            "url_list": [],
            "uri": "aweme-avatar/tos-cn-i-0813_owu79eqipENAAAA02CuixC0iIOBA7uAVFgfLgz",
        });
        assert_eq!(first_image_url(&uri_only), "");

        // 可用的 CDN 地址仍然胜出，协议相对地址会被升级。
        let with_urls = serde_json::json!({
            "url_list": ["//p11-webcast.douyinpic.com/img/cover.image"],
            "uri": "aweme-avatar/tos-cn-i-0813_owu79eqip",
        });
        assert_eq!(
            first_image_url(&with_urls),
            "https://p11-webcast.douyinpic.com/img/cover.image"
        );
    }

    #[test]
    fn merges_response_cookies_without_losing_saved_cookie() {
        let merged = merge_cookie_values(
            "sessionid=old; ttwid=old",
            "ttwid=new; msToken=token; Path=/; HttpOnly",
        );
        assert!(merged.contains("sessionid=old"));
        assert!(merged.contains("ttwid=new"));
        assert!(merged.contains("msToken=token"));
    }

    #[test]
    fn empty_ttwid_does_not_count_as_an_initialized_web_session() {
        let site = DouyinSite::new(
            http_client::default_client(),
            "sessionid=fixture-session; ttwid=; msToken=fixture-ms-token".into(),
        );

        assert!(!site.has_cookie("ttwid").unwrap());
        assert!(!site.web_session_is_initialized().unwrap());
    }

    #[test]
    fn saved_cookie_still_requires_a_live_home_bootstrap() {
        let saved = DouyinSite::new(http_client::default_client(), "sessionid=fixture".into());

        assert!(!saved.web_session_is_initialized().unwrap());
    }

    #[test]
    fn api_error_does_not_echo_untrusted_status_message() {
        let site = DouyinSite::default();
        let error = site
            .ensure_api_success(&serde_json::json!({
                "status_code": 101,
                "status_msg": "fixture-ms-token-must-not-be-exposed"
            }))
            .unwrap_err();

        assert_eq!(error.code, "douyin_browser_verification");
        assert!(error.message.contains("网页访问验证"));
        assert!(!error.message.contains("fixture-ms-token"));
    }

    #[test]
    fn danmaku_session_cookie_keeps_transient_web_session_in_memory() {
        let site = DouyinSite::new(http_client::default_client(), "sessionid=saved".into());
        let mut headers = HeaderMap::new();
        headers.append(
            SET_COOKIE,
            "ttwid=transient; Path=/; HttpOnly".parse().unwrap(),
        );
        headers.append(SET_COOKIE, "msToken=ephemeral; Path=/".parse().unwrap());
        site.remember_response_cookies(&headers).unwrap();

        let cookie = site.danmaku_session_cookie().unwrap().unwrap();
        assert!(cookie.contains("sessionid=saved"));
        assert!(cookie.contains("ttwid=transient"));
        assert!(cookie.contains("msToken=ephemeral"));
    }

    #[test]
    fn response_ms_token_header_updates_only_the_in_memory_session() {
        let site = DouyinSite::new(
            http_client::default_client(),
            "sessionid=saved; msToken=stale-token".into(),
        );
        let mut headers = HeaderMap::new();
        headers.insert("x-ms-token", "fresh-token".parse().unwrap());
        site.remember_response_cookies(&headers).unwrap();

        assert!(site.cookie().unwrap().contains("msToken=fresh-token"));
        assert!(site.cookie().unwrap().contains("sessionid=saved"));
    }

    #[test]
    fn sends_cookies_only_to_douyin_owned_web_hosts() {
        assert!(is_douyin_cookie_url("https://live.douyin.com/123"));
        assert!(is_douyin_cookie_url("https://www.douyin.com/"));
        assert!(!is_douyin_cookie_url(
            "https://webcast.amemv.com/webcast/room/reflow/info/"
        ));
        assert!(!is_douyin_cookie_url("https://douyin.com.example.test/"));
    }

    #[tokio::test]
    async fn cross_domain_room_request_does_not_replay_saved_cookie() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 2048];
            let length = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..length]).to_ascii_lowercase();
            assert!(!request.contains("cookie:"));
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                )
                .unwrap();
        });

        let site = DouyinSite::new(
            reqwest::Client::builder().no_proxy().build().unwrap(),
            "sessionid=fixture-session; msToken=fixture-token".into(),
        );
        let body = site
            .get_text(
                &format!("http://{address}/webcast/room/reflow/info/"),
                &[],
                LIVE_ROOT,
                true,
            )
            .await
            .unwrap();

        assert_eq!(body, "{}");
        server.join().unwrap();
    }

    #[test]
    fn parses_nested_ssr_categories() {
        let html = r#"<script>categoryData\":[{\"partition\":{\"id_str\":\"103\",\"type\":4,\"title\":\"游戏\",\"icon\":\"//img.example/game.png\"},\"sub_partition\":[{\"partition\":{\"id_str\":\"1\",\"type\":1,\"title\":\"射击\"},\"sub_partition\":[{\"partition\":{\"id_str\":\"1010032\",\"type\":1,\"title\":\"和平精英\"},\"sub_partition\":[]}]}]}]</script>"#;
        let categories = parse_categories_html(html).expect("categories");
        assert_eq!(categories.len(), 1);
        assert_eq!(categories[0].id, "103,4");
        assert!(
            categories[0]
                .children
                .iter()
                .any(|item| item.id == "1010032,1")
        );
        assert_eq!(
            categories[0].children[0].pic.as_deref(),
            Some("https://img.example/game.png")
        );
    }

    #[test]
    fn parses_ssr_room_list() {
        let html = r#"<script>roomsData\":{\"count\":15,\"offset\":15,\"data\":[{\"room\":{\"id_str\":\"7666175273884879635\",\"title\":\"测试直播\",\"cover\":{\"url_list\":[\"https://img.example/cover.jpg\"]},\"owner\":{\"web_rid\":\"522864404974\",\"nickname\":\"主播\"},\"room_view_stats\":{\"display_value\":42}}}]}</script>"#;
        let page = parse_ssr_rooms(html).expect("room page");
        assert!(!page.has_more);
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].room_id, "522864404974");
        assert_eq!(page.items[0].online, 42);
    }

    /// 浏览接口的一页，形态与直播响应一致：公开的 `web_rid`
    /// 位于外层条目和 `room.owner` 上。
    fn partition_page(count: usize, offset: i64) -> Value {
        let rooms = (0..count)
            .map(|index| {
                serde_json::json!({
                    "web_rid": format!("100000000{index}"),
                    "room": {
                        "id_str": format!("76661752738848796{index:02}"),
                        "title": format!("房间 {index}"),
                        "cover": {"url_list": ["https://img.example/cover.jpg"]},
                        "owner": {
                            "web_rid": format!("100000000{index}"),
                            "nickname": format!("主播 {index}")
                        },
                        "room_view_stats": {"display_value": 1_000 + index}
                    }
                })
            })
            .collect::<Vec<_>>();
        serde_json::json!({
            "status_code": 0,
            "data": {"count": count, "offset": offset, "data": rooms}
        })
    }

    #[test]
    fn full_partition_page_with_advancing_offset_has_more() {
        let page = parse_partition_rooms(&partition_page(15, 15), 0).expect("partition page");

        assert_eq!(page.items.len(), 15);
        assert_eq!(page.items[0].room_id, "1000000000");
        assert_eq!(page.items[0].online, 1_000);
        assert!(page.has_more);
    }

    #[test]
    fn short_partition_page_ends_pagination() {
        let page = parse_partition_rooms(&partition_page(7, 22), 15).expect("partition page");

        assert_eq!(page.items.len(), 7);
        assert!(!page.has_more);
    }

    /// 停滞的游标会让无限滚动永远重新抓取相同的房间，
    /// 因此不再前进的偏移必须结束分页。
    #[test]
    fn stalled_offset_ends_pagination_even_on_a_full_page() {
        let page = parse_partition_rooms(&partition_page(15, 15), 15).expect("partition page");

        assert_eq!(page.items.len(), 15);
        assert!(!page.has_more);
    }

    #[test]
    fn explicit_has_more_false_is_respected() {
        let mut value = partition_page(15, 30);
        value["data"]["has_more"] = Value::Bool(false);

        assert!(!parse_partition_rooms(&value, 15).unwrap().has_more);
    }

    fn feed_envelope(web_rid: &str, title: &str) -> Value {
        serde_json::json!({
            "type": 1,
            "web_rid": web_rid,
            "is_ad": false,
            "data": {
                "id_str": format!("760000000000000000{i}", i = &web_rid[web_rid.len() - 2..]),
                "title": title,
                "user_count": 88,
                "cover": {"url_list": ["https://img.example/cover.jpg"]},
                "owner": {"nickname": format!("{title} 主播")}
            }
        })
    }

    #[test]
    fn feed_batch_prefers_the_envelope_web_rid() {
        let payload = serde_json::json!({
            "status_code": 0,
            "data": [feed_envelope("33233584288", "推荐房间")],
        });

        let page = parse_recommend_feed(&payload).expect("feed page");

        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].room_id, "33233584288");
        assert_eq!(page.items[0].title, "推荐房间");
        assert_eq!(page.items[0].user_name, "推荐房间 主播");
        assert_eq!(page.items[0].online, 88);
        assert!(page.has_more);
    }

    /// 两种信封形态都在真实环境中出现过：房间作为内嵌 JSON 字符串
    /// （2026 年之后的响应）或普通对象。
    #[test]
    fn feed_batch_decodes_embedded_json_string_rooms() {
        let mut envelope = feed_envelope("50828500437", "字符串房间");
        let room = envelope["data"].clone();
        envelope["data"] = Value::String(room.to_string());
        let payload = serde_json::json!({"status_code": 0, "data": [envelope]});

        let page = parse_recommend_feed(&payload).expect("feed page");

        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].room_id, "50828500437");
        assert_eq!(page.items[0].title, "字符串房间");
    }

    #[test]
    fn feed_batch_drops_ads_and_duplicate_rooms() {
        let mut ad = feed_envelope("44444444444", "广告房间");
        ad["is_ad"] = Value::Bool(true);
        let payload = serde_json::json!({
            "status_code": 0,
            "data": [
                feed_envelope("33233584288", "第一次出现"),
                feed_envelope("33233584288", "重复出现"),
                ad,
            ],
        });

        let page = parse_recommend_feed(&payload).expect("feed page");

        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].title, "第一次出现");
    }

    #[test]
    fn empty_feed_batch_ends_pagination() {
        let payload = serde_json::json!({"status_code": 0, "data": []});

        let page = parse_recommend_feed(&payload).expect("feed page");

        assert!(page.items.is_empty());
        assert!(!page.has_more);
    }

    #[test]
    fn combine_feed_batches_dedupes_across_batches() {
        let batch = |ids: &[&str]| RoomListPage {
            has_more: true,
            items: ids
                .iter()
                .map(|id| LiveRoomItem {
                    site_id: SiteId::Douyin,
                    room_id: (*id).to_string(),
                    title: "标题".into(),
                    cover: String::new(),
                    user_name: "主播".into(),
                    online: 1,
                    live_status: None,
                })
                .collect(),
        };

        let combined = combine_feed_batches(vec![batch(&["a", "b", "c"]), batch(&["b", "d"])]);

        let ids = combined
            .items
            .iter()
            .map(|item| item.room_id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["a", "b", "c", "d"]);
        assert!(combined.has_more);
    }

    /// 引导缓存只能保存首页响应贡献的匿名取值；
    /// 已保存的账号 cookie 绝不进入。
    #[test]
    fn changed_cookie_pairs_reports_only_new_or_refreshed_values() {
        let before = "sessionid=secret; ttwid=old";
        let after = "sessionid=secret; ttwid=fresh; UIFID_TEMP=abc";

        let gained = changed_cookie_pairs(before, after);

        let pairs = gained
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(pairs, vec![("ttwid", "fresh"), ("UIFID_TEMP", "abc")]);
    }

    /// 两个行为共用一个测试，因为它们依赖同一个进程级会话缓存；
    /// 并行测试会互相覆盖。
    #[tokio::test]
    async fn cached_web_session_seeds_instances_and_yields_to_saved_login() {
        store_web_session_pairs(&[
            ("ttwid".into(), "cached".into()),
            ("UIFID_TEMP".into(), "fill".into()),
        ]);

        // 匿名实例：缓存的键值对直接播种出可用会话，
        // 无需访问直播首页。
        let anonymous = DouyinSite::new(
            reqwest::Client::builder().no_proxy().build().unwrap(),
            String::new(),
        );
        anonymous.ensure_web_session().await.unwrap();
        assert_eq!(anonymous.cookie().unwrap(), "ttwid=cached; UIFID_TEMP=fill");
        assert!(anonymous.web_session_is_initialized().unwrap());

        // 已登录实例：缓存值补齐缺口，
        // 但已保存的身份始终优先于其缓存对应值。
        let saved = DouyinSite::new(
            reqwest::Client::builder().no_proxy().build().unwrap(),
            "sessionid=secret; ttwid=saved".into(),
        );
        saved.ensure_web_session().await.unwrap();

        let cookie = saved.cookie().unwrap();
        assert!(cookie.contains("sessionid=secret"));
        assert!(cookie.contains("ttwid=saved"));
        assert!(cookie.contains("UIFID_TEMP=fill"));
    }

    #[test]
    fn category_partition_splits_id_and_type() {
        assert_eq!(
            category_partition(&sub_category("1010032,1", "103,4")).unwrap(),
            ("1010032", "1")
        );
        assert_eq!(
            category_partition(&sub_category("103,4", "103,4")).unwrap(),
            ("103", "4")
        );
    }

    #[test]
    fn render_data_web_id_is_extracted_from_room_page() {
        let html = r#"<html><head></head><body><script id="RENDER_DATA" type="application/json">%7B%22app%22%3A%7B%22odin%22%3A%7B%22user_unique_id%22%3A%227392091211001140287%22%7D%7D%7D</script></body></html>"#;
        assert_eq!(
            parse_render_data_web_id(html).as_deref(),
            Some("7392091211001140287")
        );
        assert_eq!(parse_render_data_web_id("<html></html>"), None);
        // 缺少 odin 块时不得 panic。
        let empty =
            r#"<script id="RENDER_DATA" type="application/json">%7B%22app%22%3A%7B%7D%7D</script>"#;
        assert_eq!(parse_render_data_web_id(empty), None);
    }

    #[test]
    fn session_web_id_prefers_s_v_web_id() {
        let cookie = "ttwid=1|abc; s_v_web_id=deadbeef; msToken=xyz";
        assert_eq!(session_web_id(cookie).as_deref(), Some("deadbeef"));
        assert_eq!(session_web_id("ttwid=1|abc; msToken=xyz"), None);
        assert_eq!(session_web_id(""), None);
    }

    /// 浏览器真实的 `s_v_web_id` 是弹幕签名无法消费的 `verify_…` 指纹，
    /// 因此不能把它附加为房间的 `user_unique_id`。
    #[test]
    fn session_web_id_drops_unsignable_verify_fingerprints() {
        let cookie = "ttwid=1|abc; s_v_web_id=verify_m9x0k1a2_HqLpZzXk_8T1c_4Vd2_Wm5NpQrStUvW";
        assert_eq!(session_web_id(cookie), None);
    }

    /// 分类浏览器注入 id 为 `0` 的合成"全部X"磁贴。
    /// 它不是抖音分区，因此必须使用其父级分区。
    #[test]
    fn all_category_falls_back_to_its_parent_partition() {
        assert_eq!(
            category_partition(&sub_category("0", "103,4")).unwrap(),
            ("103", "4")
        );
    }

    #[test]
    fn category_partition_rejects_non_numeric_ids() {
        assert!(category_partition(&sub_category("103;drop,4", "103,4")).is_err());
        assert!(category_partition(&sub_category("103", "0")).is_err());
    }

    fn sub_category(id: &str, parent_id: &str) -> LiveSubCategory {
        LiveSubCategory {
            id: id.into(),
            name: "测试分区".into(),
            parent_id: parent_id.into(),
            pic: None,
        }
    }

    #[test]
    fn ms_token_has_the_expected_shape_and_is_not_reused() {
        let token = generate_ms_token();

        assert_eq!(token.len(), MS_TOKEN_LENGTH);
        assert!(token.bytes().all(|byte| MS_TOKEN_CHARSET.contains(&byte)));
        assert_ne!(token, generate_ms_token());
    }

    /// 签名覆盖的是字面 query 字符串，因此编码必须在签名之前完成，
    /// 且 HTTP 客户端绝不能再编码第二次。
    #[test]
    fn query_encoding_escapes_values_once() {
        let query = encode_query(&[
            ("partition".into(), "1010032".into()),
            ("keyword".into(), "a b&c=d".into()),
        ]);

        assert_eq!(query, "partition=1010032&keyword=a%20b%26c%3Dd");
    }

    #[test]
    fn ssr_room_metadata_uses_its_internal_id_for_reflow() {
        let html = r#"<script>roomInfo\":{\"room\":{\"id_str\":\"7666175273884879635\",\"status\":2,\"title\":\"轻量房间数据\",\"owner\":{\"web_rid\":\"522864404974\",\"nickname\":\"主播\"},\"stream_url\":{}},\"anchor\":{\"nickname\":\"主播\"}}</script>"#;
        let detail = parse_room_detail_html(html, "522864404974").expect("SSR room detail");

        assert!(detail.status);
        assert!(!has_playable_stream(&detail));
        assert_eq!(reflow_room_id(&detail).unwrap(), "7666175273884879635");
    }

    #[test]
    fn parses_ssr_room_live_status_without_stream_metadata() {
        let html = r#"<script>roomInfo\":{\"room\":{\"status\":2,\"live_start_time\":\"1720000000\",\"stream_url\":{\"ignored\":true}}}</script>"#;

        let status = parse_room_live_status_html(html).expect("SSR room status");

        assert!(status.status);
        assert_eq!(status.live_started_at, Some(1_720_000_000_000));
    }

    #[test]
    fn parses_reflow_offline_status_without_a_start_time() {
        let status = parse_reflow_room_live_status(&serde_json::json!({
            "data": {
                "room": {
                    "status": 4,
                    "live_start_time": "1720000000",
                    "stream_url": {"ignored": true}
                }
            }
        }))
        .expect("reflow room status");

        assert!(!status.status);
        assert_eq!(status.live_started_at, None);
    }

    #[test]
    fn parses_detail_and_sorts_play_qualities() {
        let stream_data = serde_json::json!({
            "data": {
                "origin": {"main": {"flv": "https://cdn.example/origin.flv", "hls": "https://cdn.example/origin.m3u8"}},
                "ld": {"main": {"flv": "https://cdn.example/ld.flv", "hls": "https://cdn.example/ld.m3u8"}}
            }
        });
        let room = serde_json::json!({
            "id_str": "7666175273884879635",
            "status": 2,
            "title": "测试直播",
            "cover": {"url_list": ["https://img.example/cover.jpg"]},
            "owner": {
                "web_rid": "522864404974",
                "nickname": "主播",
                "avatar_thumb": {"url_list": ["https://img.example/avatar.jpg"]}
            },
            "room_view_stats": {"display_value": 42},
            "stream_url": {
                "live_core_sdk_data": {
                    "pull_data": {
                        "stream_data": stream_data.to_string(),
                        "options": {"qualities": [
                            {"name": "流畅", "sdk_key": "ld", "level": 1},
                            {"name": "蓝光", "sdk_key": "origin", "level": 4}
                        ]}
                    }
                }
            }
        });
        let detail = parse_reflow_room_detail(
            &serde_json::json!({
                "data": {
                    "room": room,
                    "user": {"nickname": "主播"}
                }
            }),
            "522864404974",
        )
        .expect("reflow detail");
        assert!(detail.status);
        assert_eq!(detail.room_id, "522864404974");
        assert!(has_playable_stream(&detail));
        let qualities =
            parse_play_qualities(detail.raw.get("stream_url").unwrap()).expect("qualities");
        assert_eq!(qualities[0].quality, "蓝光");
        assert_eq!(qualities[1].quality, "流畅");
        assert_eq!(
            qualities[0].data.pointer("/urls/0").and_then(Value::as_str),
            Some("https://cdn.example/origin.flv")
        );
    }

    #[test]
    fn extracts_room_detail_from_ssr_fallback() {
        let html = r#"<script>roomInfo\":{} roomInfo\":{\"room\":{\"id_str\":\"7666175273884879635\",\"status\":2,\"title\":\"回退直播\",\"owner\":{\"web_rid\":\"522864404974\",\"nickname\":\"主播\"},\"stream_url\":{}},\"anchor\":{\"nickname\":\"主播\"}}</script>"#;
        let detail = parse_room_detail_html(html, "522864404974").expect("fallback detail");
        assert!(detail.status);
        assert_eq!(detail.title, "回退直播");
    }

    #[test]
    fn ssr_detail_remains_usable_without_a_web_enter_payload() {
        let html = r#"<script>roomInfo\":{\"room\":{\"id_str\":\"7666175273884879635\",\"status\":2,\"title\":\"SSR 直播\",\"owner\":{\"web_rid\":\"522864404974\",\"nickname\":\"主播\"},\"stream_url\":{}},\"anchor\":{\"nickname\":\"主播\"}}</script>"#;
        let detail = parse_room_detail_html(html, "522864404974").expect("SSR fallback detail");
        assert_eq!(detail.title, "SSR 直播");
    }

    /// 真实演练带签名的浏览接口：本地计算出的、被抖音拒绝的 `a_bogus`
    /// 仍会被解析成合法（空）负载，只有真实请求才能证明签名被接受，
    /// 且第二页返回的是不同房间。
    #[tokio::test]
    #[ignore = "live Douyin browse smoke; requires external network"]
    async fn live_signed_browse_pagination_smoke() {
        let site = DouyinSite::new(
            reqwest::Client::builder().no_proxy().build().unwrap(),
            String::new(),
        );

        let first = site.get_recommend_rooms(1).await.expect("first page");
        assert!(
            !first.items.is_empty(),
            "recommend page 1 returned no rooms"
        );
        assert!(first.has_more, "recommend page 1 should offer another page");

        let second = site.get_recommend_rooms(2).await.expect("second page");
        assert!(
            !second.items.is_empty(),
            "recommend page 2 returned no rooms"
        );
        let first_ids: Vec<_> = first.items.iter().map(|item| &item.room_id).collect();
        assert!(
            second
                .items
                .iter()
                .any(|item| !first_ids.contains(&&item.room_id)),
            "recommend page 2 repeated page 1 exactly"
        );

        // 真实的分类 id，与 `parse_categories_html` 存储的一致。
        let category = LiveSubCategory {
            id: "1010032,1".into(),
            name: "和平精英".into(),
            parent_id: "103,4".into(),
            pic: None,
        };
        let rooms = site
            .get_category_rooms(&category, 1)
            .await
            .expect("category page");
        assert!(!rooms.items.is_empty(), "category page returned no rooms");
    }
}
