//! Bilibili 直播站点客户端。

mod api;
pub mod video;

pub use video::{VIDEO_SEARCH_ZONES, VIDEO_ZONES};

pub use api::{
    DEFAULT_REFERER, DEFAULT_USER_AGENT, now_unix, parse_account_recommend_rooms, parse_categories,
    parse_category_rooms, parse_play_qualities, parse_play_urls, parse_recommend_rooms,
    parse_search_rooms, parse_wbi_keys, wbi_sign_params,
};

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use reqwest::Client;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{Mutex as AsyncMutex, OnceCell};

use crate::error::{AppError, AppResult};
use crate::models::live::{
    LiveCategory, LivePlayQuality, LiveRoomDetail, LiveRoomStatus, LiveSubCategory, PlayUrl,
    RoomListPage,
};
use crate::sites::traits::LiveSite;

use api::{buvid_from_cookie, parse_buvid, parse_room_detail_from_data, parse_room_live_status};

/// 跨请求共享的 WBI 签名密钥。
#[derive(Default)]
struct Session {
    img_key: String,
    sub_key: String,
}

/// 进程级设备指纹槽（`buvid3` / `buvid4`）。
///
/// 为什么需要它：[`BilibiliSite`] 按 IPC 命令新建（见 `commands::video::resolve_bilibili`
/// 与 `sites::registry`），而 [`BilibiliSite::ensure_buvid`] 的缓存挂在**实例**上 ——
/// 没有这层进程级共享时，只要保存的 Cookie 不含 `buvid3`/`buvid4`，**每条命令都会去
/// `/x/frontend/finger/spi` 换一个新的设备号**。
///
/// 实测（真机登录态 Cookie，keys 只有 SESSDATA/bili_jct/DedeUserID/…）：轮换设备号会让
/// 匿名 story feed 每次都从同一个冷启动小池取内容，连续补货约 7~21 次后 `has_more`
/// 变假、流在 ~100 条处枯竭；固定设备号则连续 80 次调用仍在产出（累计 2378+ 条）。
/// 因此「同一进程内稳定设备号」是短视频能一直滑下去的前提，与 `sites::douyin` 的
/// `WEB_SESSION_CACHE` 同一思路。
///
/// 只放内存、不落盘：设备号是临时指纹，且扫码登录的 Cookie 自带 `buvid3`/`buvid4`
/// （见 `account::bilibili_qr` 的 `COOKIE_KEYS`）时根本走不到这里；跨重启换一个匿名
/// 设备号不会重新引入本 bug —— 触发条件是**同一进程内**每条命令都换号。
static DEVICE_BUVIDS: Mutex<Option<(String, String)>> = Mutex::new(None);

fn cached_device_buvids() -> Option<(String, String)> {
    DEVICE_BUVIDS.lock().ok()?.clone()
}

fn store_device_buvids(ids: &(String, String)) {
    if ids.0.is_empty() && ids.1.is_empty() {
        return;
    }
    if let Ok(mut slot) = DEVICE_BUVIDS.lock() {
        *slot = Some(ids.clone());
    }
}

/// 清空进程级设备槽。仅测试用：多个用例共享同一进程静态量，必须显式复位。
#[cfg(test)]
fn reset_device_buvids() {
    if let Ok(mut slot) = DEVICE_BUVIDS.lock() {
        *slot = None;
    }
}

pub struct BilibiliSite {
    client: Client,
    cookie: String,
    session: Mutex<Session>,
    /// 指纹接口失败时也缓存空结果，避免同一次房间加载并发发起重复请求。
    buvids: OnceCell<(String, String)>,
    /// 以最小间隔串行化 play-info 请求（上游节流）。
    play_gate: AsyncMutex<Option<Instant>>,
}

const DANMAKU_INFO_URL: &str = "https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo";
/// 较旧的官方接口。当较新的 Web 接口在返回短时效 token 之前
/// 被 Bilibili 风控拦截时，它仍然有用。
const LEGACY_DANMAKU_INFO_URL: &str = "https://api.live.bilibili.com/room/v1/Danmu/getConf";

/// 同时接受原始浏览器 Cookie 值和复制来的 `Cookie: ...` 请求头。
/// 后者是常见的粘贴格式，绝不能成为第一个 cookie 字段值的一部分。
fn normalize_cookie_header(value: &str) -> String {
    let value = value.trim();
    let value = match value.get(..7) {
        Some(prefix) if prefix.eq_ignore_ascii_case("cookie:") => &value[7..],
        _ => value,
    };
    value.trim().to_string()
}

/// 保存的 Bilibili 浏览器 Cookie 是否仍被平台接受。
///
/// nav 接口报告有效的已登录会话时返回 `Some(true)`；Bilibili 明确拒绝该
/// Cookie（过期或已登出，常见 `code = -101`）时返回 `Some(false)`；
/// 无法验证会话（网络失败或无法识别的响应）时返回 `None`。
/// 调用方用 `false` 回退到匿名弹幕并提示用户。
pub async fn cookie_session_status(cookie: &str, proxy: Option<&str>) -> Option<bool> {
    let cookie = normalize_cookie_header(cookie);
    if cookie.is_empty() {
        return Some(false);
    }
    let client = crate::http_client::client_for_proxy(proxy).ok()?;
    let response = client
        .get("https://api.bilibili.com/x/web-interface/nav")
        .header("user-agent", DEFAULT_USER_AGENT)
        .header("referer", DEFAULT_REFERER)
        .header("cookie", cookie)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    parse_nav_session_status(&response.text().await.ok()?)
}

/// `code != 0`（常见 `-101`）表示 Bilibili 明确拒绝了 Cookie。
/// 只有 `data.isLogin` 确认存在已登录会话时才接受 `code = 0` 的应答，
/// 否则该 Cookie 已不再携带身份。
fn parse_nav_session_status(body: &str) -> Option<bool> {
    let response: Value = serde_json::from_str(body).ok()?;
    let code = response.get("code")?.as_i64()?;
    if code != 0 {
        return Some(false);
    }
    Some(
        response
            .pointer("/data/isLogin")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    )
}

/// 保留用户提供的 cookie 值，仅在字段缺失（或为空）时添加生成的值。
/// 这里刻意只是一个小的 Cookie 头合并器，而不是 Set-Cookie 解析器：
/// 账号数据以请求头值的形式存储，而非浏览器 cookie 属性。
fn merge_missing_cookie_value(cookie: &str, key: &str, generated: &str) -> String {
    let generated = generated.trim();
    let mut found = false;
    let mut merged = Vec::new();

    for part in cookie
        .split(';')
        .map(str::trim)
        .filter(|part| !part.is_empty())
    {
        let Some((name, value)) = part.split_once('=') else {
            merged.push(part.to_string());
            continue;
        };
        if !name.trim().eq_ignore_ascii_case(key) {
            merged.push(part.to_string());
            continue;
        }

        // 同名的 cookie 有歧义。保留第一个非空的用户值并丢弃后续重复项；
        // 若为空，则在有可用生成值时以设备标识符替换。
        if found {
            continue;
        }
        found = true;
        if value.trim().is_empty() && !generated.is_empty() {
            merged.push(format!("{key}={generated}"));
        } else {
            merged.push(part.to_string());
        }
    }

    if !found && !generated.is_empty() {
        merged.push(format!("{key}={generated}"));
    }
    merged.join("; ")
}

fn cookie_with_buvids(cookie: &str, buvid3: &str, buvid4: &str) -> String {
    let cookie = merge_missing_cookie_value(cookie, "buvid3", buvid3);
    merge_missing_cookie_value(&cookie, "buvid4", buvid4)
}

/// 把任一 Bilibili 弹幕接口返回的主机数组转换为
/// `parse_room_detail_from_data` 消费的形态。
///
/// `getDanmuInfo` 称其为 `host_list`，而较旧的官方 `getConf` 接口使用
/// `host_server_list`（部分历史响应则用 `server_list`）。只保留非空主机名，
/// 其余部分原样保留上游对象，
/// 以便将来的消费方在需要时可以使用其端口元数据。
fn normalized_danmaku_hosts(data: &Value) -> Vec<Value> {
    for field in ["host_list", "host_server_list", "server_list"] {
        let Some(entries) = data.get(field).and_then(Value::as_array) else {
            continue;
        };
        let hosts = entries
            .iter()
            .filter_map(|entry| {
                let host = entry
                    .as_str()
                    .or_else(|| entry.get("host").and_then(Value::as_str))?
                    .trim();
                if host.is_empty() {
                    return None;
                }

                let mut normalized = entry.clone();
                if normalized.is_object() {
                    normalized["host"] = Value::String(host.to_string());
                } else {
                    normalized = serde_json::json!({ "host": host });
                }
                Some(normalized)
            })
            .collect::<Vec<_>>();
        if !hosts.is_empty() {
            return hosts;
        }
    }

    data.get("host")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .map(|host| vec![serde_json::json!({ "host": host })])
        .unwrap_or_default()
}

/// 只返回包含可用 token 的官方弹幕响应 data 对象。对某个特定的
/// Cookie/设备组合，Bilibili 可能在返回 `code = 0` 的同时省略短时效 token；
/// 把它当作成功会在稍后 WebSocket 启动时失败。
/// 在这里把旧接口的主机字段归一化，
/// 使连接管线的其余部分保持统一。
fn danmaku_data_with_token(text: &str) -> Option<Value> {
    let mut data = serde_json::from_str::<Value>(text)
        .ok()?
        .get("data")?
        .clone();
    let token = data
        .get("token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|token| !token.is_empty())?;
    // 去除发往 WebSocket 的取值两侧意外的空白字符，
    // 同时不记录也不暴露 token 本身。
    data["token"] = Value::String(token.to_string());
    let hosts = normalized_danmaku_hosts(&data);
    if !hosts.is_empty() {
        data["host_list"] = Value::Array(hosts);
    }
    Some(data)
}

impl BilibiliSite {
    pub fn new(client: Client, cookie: String) -> Self {
        Self {
            client,
            cookie: normalize_cookie_header(&cookie),
            session: Mutex::new(Session::default()),
            buvids: OnceCell::const_new(),
            play_gate: AsyncMutex::new(None),
        }
    }

    async fn ensure_buvid(&self) -> AppResult<(String, String)> {
        let ids = self
            .buvids
            .get_or_init(|| async {
                let (saved_b3, saved_b4) = buvid_from_cookie(&self.cookie).unwrap_or_default();
                if !saved_b3.is_empty() && !saved_b4.is_empty() {
                    return (saved_b3, saved_b4);
                }

                // 进程级设备槽：站点实例按命令新建，先看这里能不能补齐缺失的一半，
                // 否则每条命令都会换一个设备号（见 `DEVICE_BUVIDS`）。
                let (cached_b3, cached_b4) = cached_device_buvids().unwrap_or_default();
                let b3 = if saved_b3.is_empty() { cached_b3 } else { saved_b3 };
                let b4 = if saved_b4.is_empty() { cached_b4 } else { saved_b4 };
                if !b3.is_empty() && !b4.is_empty() {
                    return (b3, b4);
                }

                let (fetched_b3, fetched_b4) = match self.fetch_buvid().await {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::warn!(error = %e, "bilibili get_buvid failed; continuing empty");
                        (String::new(), String::new())
                    }
                };
                let merged = (
                    if b3.is_empty() { fetched_b3 } else { b3 },
                    if b4.is_empty() { fetched_b4 } else { b4 },
                );
                store_device_buvids(&merged);
                merged
            })
            .await;
        Ok(ids.clone())
    }

    async fn fetch_buvid(&self) -> AppResult<(String, String)> {
        let mut request = self
            .client
            .get("https://api.bilibili.com/x/frontend/finger/spi")
            .header("user-agent", DEFAULT_USER_AGENT)
            .header("referer", DEFAULT_REFERER);
        if !self.cookie.is_empty() {
            request = request.header("cookie", &self.cookie);
        }
        let resp = request.send().await.map_err(map_http)?;
        let text = resp.text().await.map_err(map_http)?;
        parse_buvid(&text)
    }

    async fn headers(&self) -> AppResult<Vec<(&'static str, String)>> {
        let (b3, b4) = self.ensure_buvid().await?;
        let cookie = cookie_with_buvids(&self.cookie, &b3, &b4);
        let mut headers = vec![
            ("user-agent", DEFAULT_USER_AGENT.to_string()),
            ("referer", DEFAULT_REFERER.to_string()),
        ];
        if !cookie.is_empty() {
            headers.push(("cookie", cookie));
        }
        Ok(headers)
    }

    /// 五个 GET JSON 包装共享的传输与校验实现：header 注入、逐对追加 query、
    /// 429 检查、HTTP 状态检查与 `code != 0` 解包。
    ///
    /// `public_headers = true` 时不引导 buvid 也不携带 cookie（见
    /// [`Self::get_public_json`]）；`checks` 决定校验档位。
    async fn get_json_request<T>(
        &self,
        url: &str,
        query: &[T],
        public_headers: bool,
        checks: ResponseChecks,
    ) -> AppResult<String>
    where
        T: Serialize,
    {
        self.get_json_request_with(url, query, public_headers, checks, &[])
            .await
    }

    /// [`Self::get_json_request`] 加额外请求头。
    ///
    /// `extra` 在标准 header 之后追加，给那些要求非 cookie 形态设备标识的接口用
    /// （目前只有 story feed 的 `buvid` 头，见
    /// [`Self::get_json_with_buvid_header`]）。
    async fn get_json_request_with<T>(
        &self,
        url: &str,
        query: &[T],
        public_headers: bool,
        checks: ResponseChecks,
        extra: &[(&'static str, String)],
    ) -> AppResult<String>
    where
        T: Serialize,
    {
        let headers = if public_headers {
            vec![
                ("user-agent", DEFAULT_USER_AGENT.to_string()),
                ("referer", DEFAULT_REFERER.to_string()),
            ]
        } else {
            self.headers().await?
        };
        let mut req = self.client.get(url);
        for (k, v) in headers {
            req = req.header(k, v);
        }
        for (k, v) in extra {
            req = req.header(*k, v);
        }
        for pair in query {
            req = req.query(&[pair]);
        }
        let resp = req.send().await.map_err(map_http)?;
        let status = resp.status();
        let text = resp.text().await.map_err(map_http)?;
        let strict = !matches!(checks, ResponseChecks::Raw);
        if strict && status.as_u16() == 429 {
            return Err(
                AppError::new("bilibili_rate_limit", "HTTP 429 from Bilibili")
                    .with_site("bilibili")
                    .retryable(),
            );
        }
        if !status.is_success() {
            let message = match checks {
                ResponseChecks::Full => format!(
                    "HTTP {status}: {}",
                    text.chars().take(200).collect::<String>()
                ),
                _ => format!("HTTP {status}"),
            };
            return Err(AppError::new("bilibili_http_error", message).with_site("bilibili"));
        }
        // Bilibili 经常在 HTTP 200 的 body 中返回 code != 0。
        if strict
            && let Ok(v) = serde_json::from_str::<Value>(&text)
            && let Some(code) = v.get("code").and_then(|c| c.as_i64())
            && code != 0
        {
            let msg = v
                .get("message")
                .or_else(|| v.get("msg"))
                .and_then(|m| m.as_str())
                .unwrap_or("unknown");
            return Err(
                AppError::new("bilibili_api_error", format!("code={code} message={msg}"))
                    .with_site("bilibili"),
            );
        }
        Ok(text)
    }

    async fn get_json(&self, url: &str, query: &[(&str, String)]) -> AppResult<String> {
        self.get_json_request(url, query, false, ResponseChecks::Full)
            .await
    }

    /// 额外携带独立的 `buvid` 请求头（story feed 专用）。
    ///
    /// 只把 buvid3 写进 cookie 对这个接口不生效：上游按这个**请求头**决定是否启用
    /// 推荐引擎（带头 `track_id = story_0.router-story-…`，不带则
    /// `gateway_fallback_…`，已实测）。因为是行为观测而非上游承诺，指纹接口失败时
    /// （[`Self::ensure_buvid`] 会缓存空串）不报错，只不带该头 —— 代价是降级流，
    /// 仍能出内容。
    pub(super) async fn get_json_with_buvid_header(
        &self,
        url: &str,
        query: &[(&str, String)],
    ) -> AppResult<String> {
        let (b3, _) = self.ensure_buvid().await?;
        let extra = if b3.is_empty() {
            Vec::new()
        } else {
            vec![("buvid", b3)]
        };
        self.get_json_request_with(url, query, false, ResponseChecks::Full, &extra)
            .await
    }

    /// 不引导设备 id，直接获取公开的 Bilibili 响应。
    ///
    /// 关注列表刷新只需要房间的开播/下播状态。调用普通的 JSON 辅助函数会先执行
    /// `ensure_buvid`，为每个新站点实例增加一次指纹请求。该接口是公开的，
    /// UA 与 Referer 已足够，
    /// 使这次探测保持为单个请求。
    async fn get_public_json(&self, url: &str, query: &[(&str, String)]) -> AppResult<String> {
        self.get_json_request(url, query, true, ResponseChecks::Full)
            .await
    }

    async fn ensure_wbi_keys(&self) -> AppResult<(String, String)> {
        {
            let s = self.session.lock().map_err(|_| {
                AppError::new("bilibili_lock", "session mutex poisoned").with_site("bilibili")
            })?;
            if !s.img_key.is_empty() && !s.sub_key.is_empty() {
                return Ok((s.img_key.clone(), s.sub_key.clone()));
            }
        }
        // 登出状态下 nav 常返回 code != 0，但仍携带 wbi_img。
        let text = self
            .get_json_raw("https://api.bilibili.com/x/web-interface/nav", &[])
            .await?;
        let (img, sub) = parse_wbi_keys(&text)?;
        let mut s = self.session.lock().map_err(|_| {
            AppError::new("bilibili_lock", "session mutex poisoned").with_site("bilibili")
        })?;
        s.img_key = img.clone();
        s.sub_key = sub.clone();
        Ok((img, sub))
    }

    /// 不要求 API `code == 0` 的 HTTP GET（用于 nav / WBI 密钥）。
    async fn get_json_raw(&self, url: &str, query: &[(&str, String)]) -> AppResult<String> {
        self.get_json_request(url, query, false, ResponseChecks::Raw)
            .await
    }

    async fn signed_query(
        &self,
        base_params: BTreeMap<String, String>,
    ) -> AppResult<Vec<(String, String)>> {
        let (img, sub) = self.ensure_wbi_keys().await?;
        let signed = wbi_sign_params(base_params, &img, &sub, now_unix());
        Ok(signed.into_iter().collect())
    }

    async fn get_json_signed(
        &self,
        url: &str,
        params: BTreeMap<String, String>,
    ) -> AppResult<String> {
        let signed = self.signed_query(params).await?;
        self.get_json_request(url, &signed, false, ResponseChecks::Standard)
            .await
    }

    /// WBI 签名但不携带任何 cookie（也不引导 buvid）。
    ///
    /// 给评论区这类「匿名 + 设备 id 会被截断成 3 条、裸请求又会吃 -352」的接口用：
    /// 签名路径放行，无 cookie 才给全量。登录态请改用 [`Self::get_json_signed`]。
    async fn get_public_json_signed(
        &self,
        url: &str,
        params: BTreeMap<String, String>,
    ) -> AppResult<String> {
        let signed = self.signed_query(params).await?;
        self.get_json_request(url, &signed, true, ResponseChecks::Standard)
            .await
    }

    /// 为房间聊天 WebSocket 解析 token 与 websocket 主机列表。
    ///
    /// `getDanmuInfo` 处于 WBI 风控之后，对所有未签名请求一律回答 `code = -352`，
    /// 与房间 id 或设备 cookie 无关，因此只允许带签名调用。较旧的 `getConf`
    /// 接口不需要 WBI 密钥且仍能返回可用 token，
    /// 在密钥获取本身失败时（`nav` 被限流、网络抖动）
    /// 弹幕仍能继续工作。
    async fn get_danmaku_data(&self, room_id: &str) -> Option<Value> {
        let mut params = BTreeMap::new();
        params.insert("id".into(), room_id.to_string());
        params.insert("type".into(), "0".into());
        match self.get_json_signed(DANMAKU_INFO_URL, params).await {
            Ok(text) => {
                if let Some(data) = danmaku_data_with_token(&text) {
                    tracing::info!(
                        room_id,
                        endpoint = "getDanmuInfo_wbi",
                        "bilibili danmaku info ok"
                    );
                    return Some(data);
                }
                tracing::warn!(
                    room_id,
                    "bilibili signed getDanmuInfo omitted token; trying legacy endpoint"
                );
            }
            Err(error) => {
                tracing::warn!(error = %error, room_id, "bilibili signed getDanmuInfo failed; trying legacy endpoint");
            }
        }

        match self
            .get_json(
                LEGACY_DANMAKU_INFO_URL,
                &[("room_id", room_id.to_string()), ("platform", "web".into())],
            )
            .await
        {
            Ok(text) => {
                let data = danmaku_data_with_token(&text);
                if data.is_some() {
                    tracing::info!(room_id, endpoint = "getConf", "bilibili danmaku info ok");
                } else {
                    tracing::warn!(room_id, "bilibili legacy danmaku endpoint omitted token");
                }
                data
            }
            Err(error) => {
                tracing::warn!(error = %error, room_id, "bilibili legacy danmaku endpoint failed");
                None
            }
        }
    }

    async fn get_room_play_info(&self, query: BTreeMap<String, String>) -> AppResult<String> {
        const RETRY_DELAYS_MS: &[u64] = &[800, 1600];
        let url = "https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo";
        let mut last_err = None;
        for (attempt, delay) in RETRY_DELAYS_MS
            .iter()
            .copied()
            .chain(std::iter::once(0))
            .enumerate()
        {
            // 节流：play-info 调用之间至少间隔 450ms。
            {
                let mut gate = self.play_gate.lock().await;
                if let Some(prev) = *gate {
                    let elapsed = prev.elapsed();
                    if elapsed < Duration::from_millis(450) {
                        tokio::time::sleep(Duration::from_millis(450) - elapsed).await;
                    }
                }
                *gate = Some(Instant::now());
            }

            match self.get_json_with_map(url, &query).await {
                Ok(text) => return Ok(text),
                Err(e) => {
                    let is_429 = e.code == "bilibili_rate_limit";
                    if is_429 && attempt < RETRY_DELAYS_MS.len() {
                        tracing::warn!(
                            attempt = attempt + 1,
                            delay_ms = delay,
                            "bilibili play info 429; retrying"
                        );
                        tokio::time::sleep(Duration::from_millis(delay)).await;
                        last_err = Some(e);
                        continue;
                    }
                    return Err(e);
                }
            }
        }
        Err(last_err.unwrap_or_else(|| {
            AppError::new("bilibili_play_info", "B站播放信息接口重试失败").with_site("bilibili")
        }))
    }

    async fn get_json_with_map(
        &self,
        url: &str,
        query: &BTreeMap<String, String>,
    ) -> AppResult<String> {
        let pairs: Vec<(&str, &str)> = query
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        self.get_json_request(url, &pairs, false, ResponseChecks::Standard)
            .await
    }

    async fn get_public_recommend_rooms(&self, page: u32) -> AppResult<RoomListPage> {
        let mut params = BTreeMap::new();
        params.insert("platform".into(), "web".into());
        params.insert("sort".into(), "online".into());
        params.insert("page_size".into(), "30".into());
        params.insert("page".into(), page.to_string());
        let text = self
            .get_json_signed(
                "https://api.live.bilibili.com/xlive/web-interface/v1/second/getListByArea",
                params,
            )
            .await?;
        parse_recommend_rooms(&text)
    }

    /// Bilibili 已登录首页负载是单个不分页的页面。
    /// 只有存在已保存 Cookie 时调用方才会走到这个辅助函数。
    async fn get_account_recommend_rooms(&self, page: u32) -> AppResult<RoomListPage> {
        if page.max(1) > 1 {
            return Ok(RoomListPage::empty());
        }
        let text = self
            .get_json(
                "https://api.live.bilibili.com/xlive/web-interface/v1/index/getList",
                &[("platform", "web".into())],
            )
            .await?;
        parse_account_recommend_rooms(&text)
    }
}

fn map_http(e: reqwest::Error) -> AppError {
    AppError::new(
        "bilibili_http_error",
        crate::http_client::describe_request_error(&e),
    )
    .with_site("bilibili")
    .retryable()
}

/// GET JSON 包装的响应校验档位。
enum ResponseChecks {
    /// 429 → `bilibili_rate_limit`；HTTP 错误信息附带响应体摘要；解包 `code != 0`。
    Full,
    /// 429 → `bilibili_rate_limit`；HTTP 错误信息不带摘要；解包 `code != 0`。
    Standard,
    /// 仅要求 HTTP 成功：不检查 429，也不解包 `code`（nav / WBI 密钥路径）。
    Raw,
}

#[async_trait::async_trait]
impl LiveSite for BilibiliSite {
    async fn get_categories(&self) -> AppResult<Vec<LiveCategory>> {
        let text = self
            .get_json(
                "https://api.live.bilibili.com/room/v1/Area/getList",
                &[("need_entrance", "1".into()), ("parent_id", "0".into())],
            )
            .await?;
        parse_categories(&text)
    }

    async fn get_recommend_rooms(&self, page: u32) -> AppResult<RoomListPage> {
        if self.cookie.is_empty() {
            return self.get_public_recommend_rooms(page).await;
        }

        match self.get_account_recommend_rooms(page).await {
            Ok(recommendations) if !recommendations.items.is_empty() || page.max(1) > 1 => {
                Ok(recommendations)
            }
            Ok(_) => {
                tracing::warn!(
                    "bilibili account recommendation returned no rooms; falling back to public feed"
                );
                self.get_public_recommend_rooms(page).await
            }
            Err(error) => {
                tracing::warn!(
                    error = %error,
                    "bilibili account recommendation failed; falling back to public feed"
                );
                self.get_public_recommend_rooms(page).await
            }
        }
    }

    async fn get_category_rooms(
        &self,
        category: &LiveSubCategory,
        page: u32,
    ) -> AppResult<RoomListPage> {
        let text = self
            .get_json(
                "https://api.live.bilibili.com/room/v1/Area/getRoomList",
                &[
                    ("platform", "web".into()),
                    ("parent_area_id", category.parent_id.clone()),
                    ("area_id", category.id.clone()),
                    ("page", page.to_string()),
                    ("page_size", "30".into()),
                ],
            )
            .await?;
        parse_category_rooms(&text, 30)
    }

    async fn search_rooms(&self, keyword: &str, page: u32) -> AppResult<RoomListPage> {
        let text = self
            .get_json(
                "https://api.bilibili.com/x/web-interface/search/type",
                &[
                    ("context", "".into()),
                    ("search_type", "live".into()),
                    ("cover_type", "user_cover".into()),
                    ("order", "".into()),
                    ("keyword", keyword.into()),
                    ("category_id", "".into()),
                    ("__refresh__", "".into()),
                    ("_extra", "".into()),
                    ("highlight", "0".into()),
                    ("single_column", "0".into()),
                    ("page", page.to_string()),
                ],
            )
            .await?;
        parse_search_rooms(&text, page)
    }

    async fn get_room_live_status(&self, room_id: &str) -> AppResult<LiveRoomStatus> {
        let text = self
            .get_public_json(
                "https://api.live.bilibili.com/room/v1/Room/get_info",
                &[("room_id", room_id.to_string())],
            )
            .await?;
        parse_room_live_status(&text)
    }

    async fn get_room_detail(&self, room_id: &str) -> AppResult<LiveRoomDetail> {
        let mut params = BTreeMap::new();
        params.insert("room_id".into(), room_id.to_string());
        let info_text = self
            .get_json_signed(
                "https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByRoom",
                params,
            )
            .await?;
        let info_root: Value = serde_json::from_str(&info_text).map_err(|e| {
            AppError::new("bilibili_parse_error", format!("room info: {e}")).with_site("bilibili")
        })?;
        let data = info_root.get("data").cloned().ok_or_else(|| {
            AppError::new("bilibili_parse_error", "room info missing data").with_site("bilibili")
        })?;
        let real_room_id = data
            .pointer("/room_info/room_id")
            .map(|v| match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            })
            .unwrap_or_else(|| room_id.to_string());

        // 弹幕信息尽力而为（上游约定：失败不得阻塞进入房间）。
        let danmaku = self.get_danmaku_data(&real_room_id).await;

        let (b3, _) = self.ensure_buvid().await.unwrap_or_default();
        parse_room_detail_from_data(&data, danmaku.as_ref(), &b3, &self.cookie)
    }

    async fn get_play_qualities(&self, detail: &LiveRoomDetail) -> AppResult<Vec<LivePlayQuality>> {
        let mut q = BTreeMap::new();
        q.insert("room_id".into(), detail.room_id.clone());
        q.insert("protocol".into(), "0,1".into());
        q.insert("format".into(), "0,1,2".into());
        q.insert("codec".into(), "0,1".into());
        q.insert("platform".into(), "web".into());
        let text = self.get_room_play_info(q).await?;
        parse_play_qualities(&text)
    }

    async fn get_play_urls(
        &self,
        detail: &LiveRoomDetail,
        quality: &LivePlayQuality,
    ) -> AppResult<Vec<PlayUrl>> {
        let qn = match &quality.data {
            Value::Number(n) => n.to_string(),
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        let mut q = BTreeMap::new();
        q.insert("room_id".into(), detail.room_id.clone());
        q.insert("protocol".into(), "0,1".into());
        q.insert("format".into(), "0,2".into());
        q.insert("codec".into(), "0".into());
        q.insert("platform".into(), "web".into());
        q.insert("qn".into(), qn);
        let text = self.get_room_play_info(q).await?;
        parse_play_urls(&text)
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;

    /// 进程级设备槽（`DEVICE_BUVIDS`）是全局静态量，并行测试会互相覆盖。
    /// 所有触碰它的用例都必须先取得这把锁。用 tokio 的 async 感知锁：
    /// 用例体是 async 的，持有 `std::sync` 锁跨 await 会被 clippy 拦下。
    static DEVICE_BUVID_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    async fn lock_device_buvids() -> tokio::sync::MutexGuard<'static, ()> {
        DEVICE_BUVID_TEST_LOCK.lock().await
    }

    #[test]
    fn copied_cookie_header_is_normalized_and_missing_buvid_is_added() {
        let site = BilibiliSite::new(
            reqwest::Client::new(),
            "  Cookie: SESSDATA=session; buvid3=saved-device  ".into(),
        );
        assert_eq!(site.cookie, "SESSDATA=session; buvid3=saved-device");
        assert_eq!(
            cookie_with_buvids(&site.cookie, "fresh-device-3", "fresh-device-4"),
            "SESSDATA=session; buvid3=saved-device; buvid4=fresh-device-4"
        );
        assert_eq!(
            cookie_with_buvids("SESSDATA=session; buvid3=", "fresh-device-3", ""),
            "SESSDATA=session; buvid3=fresh-device-3"
        );
    }

    #[tokio::test]
    async fn failed_buvid_fetch_is_shared_and_preserves_saved_device_ids() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // 进程级设备槽是全局静态量，用例之间会互相污染，先上锁并复位。
        let _guard = lock_device_buvids().await;
        reset_device_buvids();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let request_count = AtomicUsize::new(0);
        let site = BilibiliSite::new(
            crate::http_client::client_for_proxy(Some(&format!("http://{address}"))).unwrap(),
            "buvid4=device-4".into(),
        );
        let server = async {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    assert!(request.len() < 4096);
                    request.push(stream.read_u8().await.unwrap());
                }
                request_count.fetch_add(1, Ordering::SeqCst);
                stream
                    .write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .await
                    .unwrap();
            }
        };
        tokio::time::timeout(Duration::from_secs(5), async {
            tokio::select! {
                _ = server => unreachable!(),
                _ = async {
                    let (first, second) = tokio::join!(site.ensure_buvid(), site.ensure_buvid());
                    for result in [first, second, site.ensure_buvid().await] {
                        assert_eq!(result.unwrap(), (String::new(), "device-4".into()));
                    }
                } => {}
            }
        })
        .await
        .unwrap();
        assert_eq!(request_count.load(Ordering::SeqCst), 1);
    }

    /// 站点实例按 IPC 命令新建，没有进程级设备槽时，只要 Cookie 不含设备号，
    /// 每条命令都会重新拉指纹、换一个新的 `buvid`，匿名 story feed 因此很快枯竭。
    /// 这里用一个不可达的代理客户端证明复用：若 `ensure_buvid` 真去拉指纹，它必然失败。
    #[tokio::test]
    async fn process_device_slot_is_reused_by_later_site_instances() {
        let _guard = lock_device_buvids().await;
        reset_device_buvids();
        store_device_buvids(&("dev-3".into(), "dev-4".into()));

        let site = BilibiliSite::new(
            crate::http_client::client_for_proxy(Some("http://127.0.0.1:1")).unwrap(),
            String::new(),
        );
        assert_eq!(
            site.ensure_buvid().await.unwrap(),
            ("dev-3".into(), "dev-4".into()),
            "必须复用进程级设备槽，而不是换一个新的设备号"
        );

        reset_device_buvids();
    }

    #[test]
    fn danmaku_info_requires_a_nonempty_token() {
        assert!(danmaku_data_with_token(r#"{"code":0,"data":{"token":""}}"#).is_none());
        assert!(danmaku_data_with_token(r#"{"code":0,"data":{}}"#).is_none());
        assert!(danmaku_data_with_token("not json").is_none());

        let data =
            danmaku_data_with_token(r#"{"code":0,"data":{"token":" token ","host_list":[]}}"#)
                .expect("usable token");
        assert_eq!(data["token"], "token");
    }

    #[test]
    fn nav_session_status_detects_expired_cookie() {
        assert_eq!(
            parse_nav_session_status(r#"{"code":0,"data":{"isLogin":true,"uname":"小明"}}"#),
            Some(true)
        );
        assert_eq!(
            parse_nav_session_status(r#"{"code":-101,"message":"账号未登录"}"#),
            Some(false)
        );
        assert_eq!(
            parse_nav_session_status(r#"{"code":0,"data":{"isLogin":false}}"#),
            Some(false)
        );
        assert_eq!(parse_nav_session_status("not json"), None);
    }

    #[test]
    fn legacy_danmaku_info_normalizes_its_server_list() {
        let data = danmaku_data_with_token(
            r#"{"code":0,"data":{"token":" legacy-token ","host_server_list":[{"host":" legacy-1.example ","wss_port":443},{"host":"legacy-2.example","wss_port":443}]}}"#,
        )
        .expect("legacy token and hosts");

        assert_eq!(data["token"], "legacy-token");
        assert_eq!(data["host_list"][0]["host"], "legacy-1.example");
        assert_eq!(data["host_list"][1]["host"], "legacy-2.example");
    }

    /// 守住 -352 回归：`getDanmuInfo` 处于 WBI 风控之后，对任何未签名请求都回答
    /// `code = -352`，因此必须由带签名的那次调用成功 ——
    /// 而且完全不应触及旧接口。
    #[tokio::test]
    #[ignore = "live network smoke — run with --ignored"]
    async fn live_signed_danmaku_info_smoke() {
        let site = BilibiliSite::new(reqwest::Client::new(), String::new());

        let unsigned = site
            .get_json(
                DANMAKU_INFO_URL,
                &[("id", "7734200".into()), ("type", "0".into())],
            )
            .await;
        let error = unsigned.expect_err("unsigned getDanmuInfo should stay risk-controlled");
        assert!(
            error.to_string().contains("-352"),
            "expected -352 risk control, got: {error}"
        );

        let mut params = BTreeMap::new();
        params.insert("id".into(), "7734200".to_string());
        params.insert("type".into(), "0".into());
        let text = site
            .get_json_signed(DANMAKU_INFO_URL, params)
            .await
            .expect("signed getDanmuInfo should succeed");
        let data = danmaku_data_with_token(&text).expect("signed response carries a token");
        assert!(!data["host_list"].as_array().unwrap().is_empty());
    }

    /// 关键词刻意用主播名而不是游戏名：`live_user` 索引只在关键词命中主播昵称时
    /// 才有内容，游戏名只会撞出一堆在播房间，覆盖不到未开播分支。
    #[tokio::test]
    #[ignore = "live network smoke — run with --ignored"]
    async fn live_search_covers_offline_users_smoke() {
        let site = BilibiliSite::new(reqwest::Client::new(), String::new());
        let page = site.search_rooms("旭旭宝宝", 1).await.unwrap();

        assert!(
            page.items.iter().any(|item| item.live_status == Some(true)),
            "search page 1 returned no live rooms"
        );
        let offline = page
            .items
            .iter()
            .find(|item| item.live_status == Some(false))
            .expect("search page 1 returned no offline anchors");
        assert!(
            offline.title.is_empty(),
            "offline anchors carry no room title"
        );
        assert!(!offline.user_name.is_empty());
        assert!(
            !offline.cover.is_empty(),
            "offline anchors fall back to the avatar"
        );
    }

    #[tokio::test]
    #[ignore = "live network smoke — run with --ignored"]
    async fn live_recommend_smoke() {
        let site = BilibiliSite::new(reqwest::Client::new(), String::new());
        let page = site.get_recommend_rooms(1).await.unwrap();
        assert!(!page.items.is_empty());
    }

    #[tokio::test]
    #[ignore = "live network smoke — run with --ignored"]
    async fn live_categories_smoke() {
        let site = BilibiliSite::new(reqwest::Client::new(), String::new());
        let cats = site.get_categories().await.unwrap();
        assert!(!cats.is_empty());
        assert!(!cats[0].children.is_empty());
    }

    /// 完整链路：推荐 → 直播间 → 播放地址列表（Web 播放器消费这些）。
    #[tokio::test]
    #[ignore = "live network smoke — run with --ignored"]
    async fn live_play_url_smoke() {
        let site = BilibiliSite::new(reqwest::Client::new(), String::new());
        let page = site.get_recommend_rooms(1).await.expect("recommend");
        assert!(!page.items.is_empty());

        let mut detail = None;
        for item in page.items.iter().take(10) {
            if let Ok(d) = site.get_room_detail(&item.room_id).await
                && d.status
            {
                detail = Some(d);
                break;
            }
        }
        let detail = detail.expect("need at least one live room in recommend");
        let qualities = site.get_play_qualities(&detail).await.expect("qualities");
        assert!(!qualities.is_empty(), "no play qualities");
        let urls = site
            .get_play_urls(&detail, &qualities[0])
            .await
            .expect("play urls");
        assert!(!urls.is_empty(), "no play urls");
        assert!(
            urls[0].url.starts_with("http"),
            "play url should be http(s): {}",
            urls[0].url
        );
    }
}
