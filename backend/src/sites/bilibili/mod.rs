//! Bilibili live site client — ported from simple_live_core bilibili_site.dart.

mod api;

pub use api::{
    DEFAULT_REFERER, DEFAULT_USER_AGENT, parse_account_recommend_rooms, parse_categories,
    parse_category_rooms, parse_live_status, parse_play_qualities, parse_play_urls,
    parse_recommend_rooms, parse_search_rooms,
};

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use reqwest::Client;
use serde_json::Value;
use tokio::sync::Mutex as AsyncMutex;

use crate::error::{AppError, AppResult};
use crate::models::live::{
    LiveCategory, LivePlayQuality, LiveRoomDetail, LiveRoomStatus, LiveSubCategory, PlayUrl,
    RoomListPage,
};
use crate::sites::traits::LiveSite;

use api::{
    buvid_from_cookie, now_unix, parse_buvid, parse_room_detail_from_data, parse_wbi_keys,
    wbi_sign_params,
};

/// Mutable session fields shared across requests (buvid / wbi keys).
#[derive(Default)]
struct Session {
    buvid3: String,
    buvid4: String,
    img_key: String,
    sub_key: String,
}

pub struct BilibiliSite {
    client: Client,
    cookie: String,
    session: Mutex<Session>,
    /// Serializes play-info requests with a min interval (upstream throttle).
    play_gate: AsyncMutex<Option<Instant>>,
}

const DANMAKU_INFO_URL: &str = "https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo";
/// Older official endpoint. It remains useful when the newer web endpoint is
/// challenged by Bilibili risk control before it returns a short-lived token.
const LEGACY_DANMAKU_INFO_URL: &str = "https://api.live.bilibili.com/room/v1/Danmu/getConf";

/// Accept both a raw browser Cookie value and a copied `Cookie: ...` request
/// header. The latter is a common paste format and must not become part of the
/// value of the first cookie field.
fn normalize_cookie_header(value: &str) -> String {
    let value = value.trim();
    let value = match value.get(..7) {
        Some(prefix) if prefix.eq_ignore_ascii_case("cookie:") => &value[7..],
        _ => value,
    };
    value.trim().to_string()
}

/// Preserve user-supplied cookie values and add a generated value only when a
/// field is absent (or empty). This is deliberately a small Cookie-header
/// merger rather than a Set-Cookie parser: account data is stored as a request
/// header value, not as browser cookie attributes.
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

        // Cookies with the same name are ambiguous. Keep the first non-empty
        // user value and discard later duplicates; if it is empty, replace it
        // with the generated device identifier when one is available.
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

/// Convert a host array from either Bilibili danmaku endpoint into the shape
/// consumed by `parse_room_detail_from_data`.
///
/// `getDanmuInfo` calls it `host_list`, while the older official `getConf`
/// endpoint uses `host_server_list` (and some historical responses use
/// `server_list`). Keep only non-empty host names, but otherwise preserve the
/// upstream object so future consumers can use its port metadata if needed.
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

/// Return only an official danmaku response data object that contains a usable
/// token. Bilibili can return `code = 0` while omitting the short-lived token
/// for a particular Cookie/device combination; treating that as success would
/// later fail at WebSocket startup. Normalize the legacy endpoint's host field
/// at the boundary so the remainder of the connection pipeline stays uniform.
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
    // Keep the value sent to the WebSocket free of accidental surrounding
    // whitespace without logging or exposing the token itself.
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
            play_gate: AsyncMutex::new(None),
        }
    }

    async fn ensure_buvid(&self) -> AppResult<(String, String)> {
        {
            let s = self.session.lock().map_err(|_| {
                AppError::new("bilibili_lock", "session mutex poisoned").with_site("bilibili")
            })?;
            if !s.buvid3.is_empty() {
                return Ok((s.buvid3.clone(), s.buvid4.clone()));
            }
        }

        let (saved_b3, saved_b4) = buvid_from_cookie(&self.cookie).unwrap_or_default();
        if !saved_b3.is_empty() && !saved_b4.is_empty() {
            let mut s = self.session.lock().map_err(|_| {
                AppError::new("bilibili_lock", "session mutex poisoned").with_site("bilibili")
            })?;
            s.buvid3 = saved_b3.clone();
            s.buvid4 = saved_b4.clone();
            return Ok((saved_b3, saved_b4));
        }

        let (fetched_b3, fetched_b4) = match self.fetch_buvid().await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "bilibili get_buvid failed; continuing empty");
                (String::new(), String::new())
            }
        };
        let b3 = if saved_b3.is_empty() {
            fetched_b3
        } else {
            saved_b3
        };
        let b4 = if saved_b4.is_empty() {
            fetched_b4
        } else {
            saved_b4
        };
        let mut s = self.session.lock().map_err(|_| {
            AppError::new("bilibili_lock", "session mutex poisoned").with_site("bilibili")
        })?;
        s.buvid3 = b3.clone();
        s.buvid4 = b4.clone();
        Ok((b3, b4))
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
        let resp = request.send().await.map_err(|e| map_http(e))?;
        let text = resp.text().await.map_err(|e| map_http(e))?;
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

    async fn get_json(&self, url: &str, query: &[(&str, String)]) -> AppResult<String> {
        let headers = self.headers().await?;
        let mut req = self.client.get(url);
        for (k, v) in headers {
            req = req.header(k, v);
        }
        for (k, v) in query {
            req = req.query(&[(k, v)]);
        }
        let resp = req.send().await.map_err(map_http)?;
        let status = resp.status();
        let text = resp.text().await.map_err(map_http)?;
        if status.as_u16() == 429 {
            return Err(
                AppError::new("bilibili_rate_limit", "HTTP 429 from Bilibili")
                    .with_site("bilibili")
                    .retryable(),
            );
        }
        if !status.is_success() {
            return Err(AppError::new(
                "bilibili_http_error",
                format!(
                    "HTTP {status}: {}",
                    text.chars().take(200).collect::<String>()
                ),
            )
            .with_site("bilibili"));
        }
        // Bilibili often returns code != 0 in body with HTTP 200.
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            if let Some(code) = v.get("code").and_then(|c| c.as_i64()) {
                if code != 0 {
                    let msg = v
                        .get("message")
                        .or_else(|| v.get("msg"))
                        .and_then(|m| m.as_str())
                        .unwrap_or("unknown");
                    return Err(AppError::new(
                        "bilibili_api_error",
                        format!("code={code} message={msg}"),
                    )
                    .with_site("bilibili"));
                }
            }
        }
        Ok(text)
    }

    /// Fetch a public Bilibili response without bootstrapping device IDs.
    ///
    /// Follow-list refreshes only need the room's on/off state.  Calling the
    /// normal JSON helper would first call `ensure_buvid`, which can add a
    /// fingerprint request for every fresh site instance.  This endpoint is
    /// public, so a UA and Referer are sufficient and keep the probe to one
    /// request.
    async fn get_public_json(&self, url: &str, query: &[(&str, String)]) -> AppResult<String> {
        let mut request = self
            .client
            .get(url)
            .header("user-agent", DEFAULT_USER_AGENT)
            .header("referer", DEFAULT_REFERER);
        for (key, value) in query {
            request = request.query(&[(key, value)]);
        }

        let response = request.send().await.map_err(map_http)?;
        let status = response.status();
        let text = response.text().await.map_err(map_http)?;
        if status.as_u16() == 429 {
            return Err(
                AppError::new("bilibili_rate_limit", "HTTP 429 from Bilibili")
                    .with_site("bilibili")
                    .retryable(),
            );
        }
        if !status.is_success() {
            return Err(AppError::new(
                "bilibili_http_error",
                format!(
                    "HTTP {status}: {}",
                    text.chars().take(200).collect::<String>()
                ),
            )
            .with_site("bilibili"));
        }
        if let Ok(response) = serde_json::from_str::<Value>(&text) {
            if let Some(code) = response.get("code").and_then(Value::as_i64) {
                if code != 0 {
                    let message = response
                        .get("message")
                        .or_else(|| response.get("msg"))
                        .and_then(Value::as_str)
                        .unwrap_or("unknown");
                    return Err(AppError::new(
                        "bilibili_api_error",
                        format!("code={code} message={message}"),
                    )
                    .with_site("bilibili"));
                }
            }
        }
        Ok(text)
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
        // Nav often returns code != 0 when logged out but still includes wbi_img.
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

    /// HTTP GET that does not require API `code == 0` (for nav / WBI keys).
    async fn get_json_raw(&self, url: &str, query: &[(&str, String)]) -> AppResult<String> {
        let headers = self.headers().await?;
        let mut req = self.client.get(url);
        for (k, v) in headers {
            req = req.header(k, v);
        }
        for (k, v) in query {
            req = req.query(&[(k, v)]);
        }
        let resp = req.send().await.map_err(map_http)?;
        let status = resp.status();
        let text = resp.text().await.map_err(map_http)?;
        if !status.is_success() {
            return Err(
                AppError::new("bilibili_http_error", format!("HTTP {status}"))
                    .with_site("bilibili"),
            );
        }
        Ok(text)
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
        let query: Vec<(&str, String)> = signed
            .iter()
            .map(|(k, v)| (k.as_str(), v.clone()))
            .collect();
        // Lifetime workaround: rebuild with owned pairs via query builder
        let headers = self.headers().await?;
        let mut req = self.client.get(url);
        for (k, v) in headers {
            req = req.header(k, v);
        }
        for (k, v) in &signed {
            req = req.query(&[(k.as_str(), v.as_str())]);
        }
        let _ = query; // silence if unused after rebuild
        let resp = req.send().await.map_err(map_http)?;
        let status = resp.status();
        let text = resp.text().await.map_err(map_http)?;
        if status.as_u16() == 429 {
            return Err(
                AppError::new("bilibili_rate_limit", "HTTP 429 from Bilibili")
                    .with_site("bilibili")
                    .retryable(),
            );
        }
        if !status.is_success() {
            return Err(
                AppError::new("bilibili_http_error", format!("HTTP {status}"))
                    .with_site("bilibili"),
            );
        }
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            if let Some(code) = v.get("code").and_then(|c| c.as_i64()) {
                if code != 0 {
                    let msg = v
                        .get("message")
                        .or_else(|| v.get("msg"))
                        .and_then(|m| m.as_str())
                        .unwrap_or("unknown");
                    return Err(AppError::new(
                        "bilibili_api_error",
                        format!("code={code} message={msg}"),
                    )
                    .with_site("bilibili"));
                }
            }
        }
        Ok(text)
    }

    /// Resolve a token and websocket hosts without letting a risk-control
    /// response from one official endpoint turn into a misleading local
    /// "token missing" error. The legacy endpoint is deliberately tried
    /// before WBI: it is a normal official response, does not require WBI
    /// keys, and remains available when `getDanmuInfo` returns code -352.
    async fn get_danmaku_data(&self, room_id: &str) -> Option<Value> {
        match self
            .get_json(
                DANMAKU_INFO_URL,
                &[("id", room_id.to_string()), ("type", "0".into())],
            )
            .await
        {
            Ok(text) => {
                if let Some(data) = danmaku_data_with_token(&text) {
                    tracing::info!(
                        room_id,
                        endpoint = "getDanmuInfo",
                        "bilibili danmaku info ok"
                    );
                    return Some(data);
                }
                tracing::warn!(
                    room_id,
                    "bilibili getDanmuInfo omitted token; trying legacy endpoint"
                );
            }
            Err(error) => {
                tracing::warn!(error = %error, room_id, "bilibili getDanmuInfo failed; trying legacy endpoint");
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
                if let Some(data) = danmaku_data_with_token(&text) {
                    tracing::info!(room_id, endpoint = "getConf", "bilibili danmaku info ok");
                    return Some(data);
                }
                tracing::warn!(
                    room_id,
                    "bilibili legacy danmaku endpoint omitted token; trying signed endpoint"
                );
            }
            Err(error) => {
                tracing::warn!(error = %error, room_id, "bilibili legacy danmaku endpoint failed; trying signed endpoint");
            }
        }

        let mut params = BTreeMap::new();
        params.insert("id".into(), room_id.to_string());
        params.insert("type".into(), "0".into());
        match self.get_json_signed(DANMAKU_INFO_URL, params).await {
            Ok(text) => {
                let data = danmaku_data_with_token(&text);
                if data.is_some() {
                    tracing::info!(
                        room_id,
                        endpoint = "getDanmuInfo_wbi",
                        "bilibili danmaku info ok"
                    );
                } else {
                    tracing::warn!(room_id, "bilibili signed danmaku endpoint omitted token");
                }
                data
            }
            Err(error) => {
                tracing::warn!(error = %error, room_id, "bilibili signed danmaku endpoint failed");
                None
            }
        }
    }

    async fn get_room_play_info(&self, query: BTreeMap<String, String>) -> AppResult<String> {
        const RETRY_DELAYS_MS: &[u64] = &[800, 1600];
        let url = "https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo";
        let mut last_err = None;
        for attempt in 0..=RETRY_DELAYS_MS.len() {
            // Throttle: min 450ms between play-info calls.
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
                        let delay = RETRY_DELAYS_MS[attempt];
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
        let headers = self.headers().await?;
        let mut req = self.client.get(url);
        for (k, v) in headers {
            req = req.header(k, v);
        }
        for (k, v) in query {
            req = req.query(&[(k.as_str(), v.as_str())]);
        }
        let resp = req.send().await.map_err(map_http)?;
        let status = resp.status();
        let text = resp.text().await.map_err(map_http)?;
        if status.as_u16() == 429 {
            return Err(
                AppError::new("bilibili_rate_limit", "HTTP 429 from Bilibili")
                    .with_site("bilibili")
                    .retryable(),
            );
        }
        if !status.is_success() {
            return Err(
                AppError::new("bilibili_http_error", format!("HTTP {status}"))
                    .with_site("bilibili"),
            );
        }
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            if let Some(code) = v.get("code").and_then(|c| c.as_i64()) {
                if code != 0 {
                    let msg = v
                        .get("message")
                        .or_else(|| v.get("msg"))
                        .and_then(|m| m.as_str())
                        .unwrap_or("unknown");
                    return Err(AppError::new(
                        "bilibili_api_error",
                        format!("code={code} message={msg}"),
                    )
                    .with_site("bilibili"));
                }
            }
        }
        Ok(text)
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

    /// Bilibili's signed-in home payload is a single, non-paginated page.
    /// Callers only reach this helper when a saved Cookie is present.
    async fn get_account_recommend_rooms(&self, page: u32) -> AppResult<RoomListPage> {
        if page.max(1) > 1 {
            return Ok(RoomListPage {
                has_more: false,
                items: Vec::new(),
            });
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
    AppError::new("bilibili_http_error", e.to_string())
        .with_site("bilibili")
        .retryable()
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
        parse_search_rooms(&text)
    }

    async fn get_room_live_status(&self, room_id: &str) -> AppResult<LiveRoomStatus> {
        let text = self
            .get_public_json(
                "https://api.live.bilibili.com/room/v1/Room/get_info",
                &[("room_id", room_id.to_string())],
            )
            .await?;
        Ok(LiveRoomStatus {
            status: parse_live_status(&text)?,
            // This small endpoint is intentionally used only as a status
            // probe.  Keep duration metadata out of its request/parse path.
            live_started_at: None,
        })
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

        // Danmaku info is best-effort (upstream: failure must not block room entry).
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
    fn legacy_danmaku_info_normalizes_its_server_list() {
        let data = danmaku_data_with_token(
            r#"{"code":0,"data":{"token":" legacy-token ","host_server_list":[{"host":" legacy-1.example ","wss_port":443},{"host":"legacy-2.example","wss_port":443}]}}"#,
        )
        .expect("legacy token and hosts");

        assert_eq!(data["token"], "legacy-token");
        assert_eq!(data["host_list"][0]["host"], "legacy-1.example");
        assert_eq!(data["host_list"][1]["host"], "legacy-2.example");
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

    /// Full path: recommend → live room → play URL list (web player consumes these).
    #[tokio::test]
    #[ignore = "live network smoke — run with --ignored"]
    async fn live_play_url_smoke() {
        let site = BilibiliSite::new(reqwest::Client::new(), String::new());
        let page = site.get_recommend_rooms(1).await.expect("recommend");
        assert!(!page.items.is_empty());

        let mut detail = None;
        for item in page.items.iter().take(10) {
            if let Ok(d) = site.get_room_detail(&item.room_id).await {
                if d.status {
                    detail = Some(d);
                    break;
                }
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
