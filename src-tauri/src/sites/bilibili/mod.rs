//! Bilibili live site client — ported from simple_live_core bilibili_site.dart.

mod api;

pub use api::{
    parse_categories, parse_category_rooms, parse_live_status, parse_play_qualities, parse_play_urls,
    parse_recommend_rooms, parse_room_detail, parse_search_rooms, DEFAULT_REFERER,
    DEFAULT_USER_AGENT,
};

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use reqwest::Client;
use serde_json::Value;
use tokio::sync::Mutex as AsyncMutex;

use crate::error::{AppError, AppResult};
use crate::models::live::{
    LiveCategory, LivePlayQuality, LiveRoomDetail, LiveSubCategory, PlayUrl, RoomListPage, SiteId,
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

impl BilibiliSite {
    pub fn new(client: Client, cookie: String) -> Self {
        Self {
            client,
            cookie,
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

        if let Some((b3, b4)) = buvid_from_cookie(&self.cookie) {
            let mut s = self.session.lock().map_err(|_| {
                AppError::new("bilibili_lock", "session mutex poisoned").with_site("bilibili")
            })?;
            s.buvid3 = b3.clone();
            s.buvid4 = b4.clone();
            return Ok((b3, b4));
        }

        let (b3, b4) = match self.fetch_buvid().await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "bilibili get_buvid failed; continuing empty");
                (String::new(), String::new())
            }
        };
        let mut s = self.session.lock().map_err(|_| {
            AppError::new("bilibili_lock", "session mutex poisoned").with_site("bilibili")
        })?;
        s.buvid3 = b3.clone();
        s.buvid4 = b4.clone();
        Ok((b3, b4))
    }

    async fn fetch_buvid(&self) -> AppResult<(String, String)> {
        let resp = self
            .client
            .get("https://api.bilibili.com/x/frontend/finger/spi")
            .header("user-agent", DEFAULT_USER_AGENT)
            .header("referer", DEFAULT_REFERER)
            .header("cookie", &self.cookie)
            .send()
            .await
            .map_err(|e| map_http(e))?;
        let text = resp.text().await.map_err(|e| map_http(e))?;
        parse_buvid(&text)
    }

    async fn headers(&self) -> AppResult<Vec<(&'static str, String)>> {
        let (b3, b4) = self.ensure_buvid().await?;
        let cookie = if self.cookie.is_empty() {
            format!("buvid3={b3};buvid4={b4};")
        } else if self.cookie.contains("buvid3") {
            self.cookie.clone()
        } else {
            format!("{};buvid3={b3};buvid4={b4};", self.cookie)
        };
        Ok(vec![
            ("user-agent", DEFAULT_USER_AGENT.to_string()),
            ("referer", DEFAULT_REFERER.to_string()),
            ("cookie", cookie),
        ])
    }

    async fn get_json(
        &self,
        url: &str,
        query: &[(&str, String)],
    ) -> AppResult<String> {
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
            return Err(AppError::new("bilibili_rate_limit", "HTTP 429 from Bilibili")
                .with_site("bilibili")
                .retryable());
        }
        if !status.is_success() {
            return Err(AppError::new(
                "bilibili_http_error",
                format!("HTTP {status}: {}", text.chars().take(200).collect::<String>()),
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
    async fn get_json_raw(
        &self,
        url: &str,
        query: &[(&str, String)],
    ) -> AppResult<String> {
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
            return Err(AppError::new(
                "bilibili_http_error",
                format!("HTTP {status}"),
            )
            .with_site("bilibili"));
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
            return Err(AppError::new("bilibili_rate_limit", "HTTP 429 from Bilibili")
                .with_site("bilibili")
                .retryable());
        }
        if !status.is_success() {
            return Err(AppError::new(
                "bilibili_http_error",
                format!("HTTP {status}"),
            )
            .with_site("bilibili"));
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

    async fn get_room_play_info(
        &self,
        query: BTreeMap<String, String>,
    ) -> AppResult<String> {
        const RETRY_DELAYS_MS: &[u64] = &[800, 1600];
        let url =
            "https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo";
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
            AppError::new("bilibili_play_info", "B站播放信息接口重试失败")
                .with_site("bilibili")
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
            return Err(AppError::new("bilibili_rate_limit", "HTTP 429 from Bilibili")
                .with_site("bilibili")
                .retryable());
        }
        if !status.is_success() {
            return Err(AppError::new(
                "bilibili_http_error",
                format!("HTTP {status}"),
            )
            .with_site("bilibili"));
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
}

fn map_http(e: reqwest::Error) -> AppError {
    AppError::new("bilibili_http_error", e.to_string())
        .with_site("bilibili")
        .retryable()
}

#[async_trait::async_trait]
impl LiveSite for BilibiliSite {
    fn id(&self) -> SiteId {
        SiteId::Bilibili
    }

    fn name(&self) -> &'static str {
        "Bilibili"
    }

    async fn get_categories(&self) -> AppResult<Vec<LiveCategory>> {
        let text = self
            .get_json(
                "https://api.live.bilibili.com/room/v1/Area/getList",
                &[
                    ("need_entrance", "1".into()),
                    ("parent_id", "0".into()),
                ],
            )
            .await?;
        parse_categories(&text)
    }

    async fn get_recommend_rooms(&self, page: u32) -> AppResult<RoomListPage> {
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
        let data = info_root
            .get("data")
            .cloned()
            .ok_or_else(|| {
                AppError::new("bilibili_parse_error", "room info missing data")
                    .with_site("bilibili")
            })?;
        let real_room_id = data
            .pointer("/room_info/room_id")
            .map(|v| match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            })
            .unwrap_or_else(|| room_id.to_string());

        // Danmaku info is best-effort (upstream: failure must not block room entry).
        let mut danmaku: Option<Value> = None;
        {
            let mut dparams = BTreeMap::new();
            dparams.insert("id".into(), real_room_id.clone());
            match self
                .get_json_signed(
                    "https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo",
                    dparams,
                )
                .await
            {
                Ok(text) => {
                    if let Ok(v) = serde_json::from_str::<Value>(&text) {
                        danmaku = v.get("data").cloned();
                    }
                }
                Err(e) => {
                    tracing::warn!(error = %e, room_id = %real_room_id, "danmaku info failed");
                }
            }
        }

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

    async fn get_live_status(&self, room_id: &str) -> AppResult<bool> {
        let text = self
            .get_json(
                "https://api.live.bilibili.com/room/v1/Room/get_info",
                &[("room_id", room_id.into())],
            )
            .await?;
        parse_live_status(&text)
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;

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
}
