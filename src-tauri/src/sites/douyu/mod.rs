//! 斗鱼直播站点客户端。

mod sign;

use std::collections::HashMap;

use reqwest::{Client, Url};
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::http_client;
use crate::models::live::{
    LiveCategory, LivePlayQuality, LiveRoomDetail, LiveRoomItem, LiveRoomStatus, LiveSubCategory,
    PlayUrl, RoomListPage, SiteId, parse_live_started_at,
};
use crate::sites::traits::LiveSite;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 Edg/114.0.1823.43";
const RECOMMEND_PAGE_SIZE: usize = 40;
const DIRECTORY_PAGE_SIZE: usize = 20;

pub struct DouyuSite {
    client: Client,
    /// 用户提供的账号 Cookie。它会传给每个适用的斗鱼请求，
    /// 但本站点客户端绝不记录或持久化它。
    cookie: String,
}

impl Default for DouyuSite {
    fn default() -> Self {
        Self {
            client: http_client::default_client(),
            cookie: String::new(),
        }
    }
}

impl DouyuSite {
    pub fn new_with_cookie(client: Client, cookie: String) -> Self {
        Self {
            client,
            cookie: normalize_cookie(&cookie),
        }
    }

    fn err(msg: impl Into<String>) -> AppError {
        AppError::new("douyu_api_error", msg)
            .with_site("douyu")
            .retryable()
    }

    async fn get_json(&self, url: &str, referer: &str) -> AppResult<Value> {
        let mut request = self
            .client
            .get(url)
            .header("user-agent", UA)
            .header("referer", referer);
        if !self.cookie.is_empty() && is_douyu_cookie_url(url) {
            request = request.header("cookie", &self.cookie);
        }
        let text = request
            .send()
            .await
            .map_err(|e| Self::err(format!("http: {e}")))?
            .text()
            .await
            .map_err(|e| Self::err(format!("body: {e}")))?;
        serde_json::from_str(&text).map_err(|e| Self::err(format!("json: {e}")))
    }

    async fn room_info(&self, room_id: &str) -> AppResult<Value> {
        // betard API 返回房间字典
        let url = format!("https://www.douyu.com/betard/{room_id}");
        let v = self
            .get_json(&url, &format!("https://www.douyu.com/{room_id}"))
            .await?;
        // 有时被包了一层
        if v.get("room").is_some() || v.get("data").is_some() {
            Ok(v)
        } else {
            Ok(serde_json::json!({ "room": v }))
        }
    }

    /// 搜索需要斗鱼的匿名设备标识符。保留任何已保存的账号取值，
    /// 只在缺失时补充稳定的兜底值。
    fn search_cookie(&self) -> String {
        let did = "10000000000000000000000000001501";
        merge_cookie_values(&format!("dy_did={did}; acf_did={did}"), &self.cookie)
    }

    /// 请求一次 H5 播放数据（`getH5PlayV1`）。
    ///
    /// 每次调用都用缓存的加密描述符重新签名（见 [`sign::get_sign`]），
    /// 因此不会因详情页停留过久而用到陈旧时间戳。服务器拒绝签名
    /// （HTTP 403 或 `error = -9` 时间戳错误）时，强制刷新描述符重试一次。
    async fn request_play_data(&self, room_id: &str, rate: i64, cdn: &str) -> AppResult<Value> {
        match self
            .request_play_data_once(room_id, rate, cdn, false)
            .await
        {
            Ok(value) => Ok(value),
            Err(error) if error.code == sign::SIGN_REJECTED_CODE => {
                self.request_play_data_once(room_id, rate, cdn, true)
                    .await
            }
            Err(error) => Err(error),
        }
    }

    async fn request_play_data_once(
        &self,
        room_id: &str,
        rate: i64,
        cdn: &str,
        force_refresh: bool,
    ) -> AppResult<Value> {
        let body = sign::get_sign(&self.client, room_id, rate, cdn, force_refresh).await?;
        let url = format!("https://www.douyu.com/lapi/live/getH5PlayV1/{room_id}");
        let referer = format!("https://www.douyu.com/{room_id}");
        let response = self
            .client
            .post(&url)
            .header("user-agent", UA)
            .header("referer", &referer)
            .header("origin", "https://www.douyu.com")
            .header("content-type", "application/x-www-form-urlencoded")
            .header(
                "cookie",
                format!("dy_did={}; acf_did={}", sign::SIGN_DEVICE_ID, sign::SIGN_DEVICE_ID),
            )
            .body(body)
            .send()
            .await
            .map_err(|e| Self::err(format!("http post: {e}")))?;
        let status = response.status();
        if status.as_u16() == 403 || status.as_u16() == 401 {
            // 服务器拒绝签名凭据：刷新描述符重签后重试。
            return Err(AppError::new(sign::SIGN_REJECTED_CODE, "斗鱼播放签名被拒绝")
                .with_site("douyu")
                .retryable());
        }
        if !status.is_success() {
            return Err(Self::err(format!("getH5PlayV1 http {}", status.as_u16())));
        }
        let text = response
            .text()
            .await
            .map_err(|e| Self::err(format!("body: {e}")))?;
        let v: Value =
            serde_json::from_str(&text).map_err(|e| Self::err(format!("json: {e}")))?;
        let error = json_i64(v.get("error").or_else(|| v.get("code")).unwrap_or(&Value::Null));
        if error == -9 {
            // 时间戳错误：签名已过期，重签重试。
            return Err(AppError::new(sign::SIGN_REJECTED_CODE, "斗鱼播放签名已过期")
                .with_site("douyu")
                .retryable());
        }
        if error != 0 {
            let msg = json_str(v.get("msg").unwrap_or(&Value::Null));
            let reason = if msg.is_empty() {
                format!("getH5PlayV1 error {error}")
            } else {
                format!("getH5PlayV1: {msg}")
            };
            return Err(Self::err(reason));
        }
        Ok(v)
    }
}

fn normalize_cookie(value: &str) -> String {
    merge_cookie_values(
        "",
        value.trim().strip_prefix("Cookie:").unwrap_or(value).trim(),
    )
}

/// 账号 Cookie 的作用域限定在斗鱼的 HTTPS Web 主机。保持显式声明，
/// 可避免未来的调用点仅因为复用了 JSON 辅助函数，
/// 就把保存的 Cookie 重放到任意 URL。
fn is_douyu_cookie_url(value: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|host| host == "douyu.com" || host.ends_with(".douyu.com"))
}

fn cookie_pairs(value: &str) -> Vec<(String, String)> {
    value
        .split(';')
        .filter_map(|part| {
            let (key, value) = part.trim().split_once('=')?;
            let key = key.trim();
            (!key.is_empty()).then(|| (key.to_string(), value.trim().to_string()))
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

fn has_more_page(
    page: u32,
    upstream_page_count: i64,
    item_count: usize,
    expected_page_size: usize,
) -> bool {
    if upstream_page_count > 0 {
        i64::from(page) < upstream_page_count
    } else {
        item_count >= expected_page_size
    }
}

fn json_i64(v: &Value) -> i64 {
    v.as_i64()
        .or_else(|| v.as_u64().map(|u| u as i64))
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(0)
}

fn json_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => String::new(),
        _ => v.to_string(),
    }
}

fn html_unescape(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
}

fn parse_mix_list(v: &Value) -> AppResult<RoomListPage> {
    let data = v.get("data").cloned().unwrap_or(Value::Null);
    let mut items = Vec::new();
    if let Some(arr) = data.get("rl").and_then(|x| x.as_array()) {
        for item in arr {
            if json_i64(item.get("type").unwrap_or(&Value::Null)) != 1 {
                continue;
            }
            items.push(LiveRoomItem {
                site_id: SiteId::Douyu,
                room_id: json_str(item.get("rid").unwrap_or(&Value::Null)),
                title: json_str(item.get("rn").unwrap_or(&Value::Null)),
                cover: json_str(item.get("rs16").unwrap_or(&Value::Null)),
                user_name: json_str(item.get("nn").unwrap_or(&Value::Null)),
                online: json_i64(item.get("ol").unwrap_or(&Value::Null)),
            });
        }
    }
    Ok(RoomListPage {
        // 接口专属的调用方自行提供可靠的分页策略。
        has_more: false,
        items,
    })
}

/// 解析移动端推荐接口（`hgapi/live/cate/newRecList`)的列表。它使用扁平的字段名
/// （`roomName`/`nickname`/`roomSrc`），并为分页提供权威的 `total`；
/// `hn` 是本地化的人气标签（如 `101.8万`），不是原始数字。
fn parse_mobile_recommend_list(v: &Value, page: u32, page_size: usize) -> AppResult<RoomListPage> {
    if json_i64(v.get("error").unwrap_or(&Value::Null)) != 0 {
        return Err(AppError::new("douyu_api_error", "mobile list error")
            .with_site("douyu")
            .retryable());
    }
    let data = v.get("data").cloned().unwrap_or(Value::Null);
    let mut items = Vec::new();
    if let Some(arr) = data.get("list").and_then(|x| x.as_array()) {
        for item in arr {
            let room_id = json_str(item.get("rid").unwrap_or(&Value::Null));
            if room_id.is_empty() {
                continue;
            }
            items.push(LiveRoomItem {
                site_id: SiteId::Douyu,
                room_id,
                title: json_str(
                    item.get("roomName")
                        .or_else(|| item.get("rn"))
                        .unwrap_or(&Value::Null),
                ),
                cover: json_str(
                    item.get("roomSrc")
                        .or_else(|| item.get("rs16"))
                        .unwrap_or(&Value::Null),
                ),
                user_name: json_str(
                    item.get("nickname")
                        .or_else(|| item.get("nn"))
                        .unwrap_or(&Value::Null),
                ),
                online: parse_online_label(json_str(
                    item.get("hn")
                        .or_else(|| item.get("ol"))
                        .unwrap_or(&Value::Null),
                )),
            });
        }
    }
    let total = json_i64(data.get("total").unwrap_or(&Value::Null)) as usize;
    let has_more = if total > 0 {
        (page as usize).saturating_mul(page_size) < total
    } else {
        items.len() >= page_size
    };
    Ok(RoomListPage { has_more, items })
}

/// 从本地化标签（`101.8万`、`5.6k`）还原近似人气值，
/// 移动端 API 用它代替原始数字。
fn parse_online_label(value: String) -> i64 {
    let value = value.trim();
    if let Some(num) = value.strip_suffix('万') {
        return (num.trim().parse::<f64>().unwrap_or(0.0) * 10_000.0) as i64;
    }
    if let Some(num) = value.strip_suffix('k').or_else(|| value.strip_suffix('K')) {
        return (num.trim().parse::<f64>().unwrap_or(0.0) * 1_000.0) as i64;
    }
    value.parse().unwrap_or(0)
}

/// 选取斗鱼轻量 `betard` 接口返回的房间对象，
/// 只提取关注列表刷新有用的字段。
fn live_status_from_room_info(root: &Value) -> LiveRoomStatus {
    let room = root
        .get("room")
        .or_else(|| root.get("data"))
        .unwrap_or(root);
    let status = json_i64(room.get("show_status").unwrap_or(&Value::Null)) == 1
        && json_i64(
            room.get("videoLoop")
                .or_else(|| room.get("video_loop"))
                .unwrap_or(&Value::Null),
        ) != 1;

    LiveRoomStatus {
        status,
        live_started_at: status
            .then(|| {
                parse_live_started_at(
                    room.get("show_time")
                        .or_else(|| room.get("live_start_time"))
                        .or_else(|| room.get("start_time")),
                )
            })
            .flatten(),
    }
}

#[async_trait::async_trait]
impl LiveSite for DouyuSite {
    async fn get_categories(&self) -> AppResult<Vec<LiveCategory>> {
        let v = self
            .get_json("https://m.douyu.com/api/cate/list", "https://m.douyu.com/")
            .await?;
        let data = v.get("data").cloned().unwrap_or(Value::Null);
        let cate1 = data
            .get("cate1Info")
            .and_then(|x| x.as_array())
            .cloned()
            .unwrap_or_default();
        let cate2 = data
            .get("cate2Info")
            .and_then(|x| x.as_array())
            .cloned()
            .unwrap_or_default();
        let mut categories = Vec::new();
        for c1 in cate1 {
            let id = json_str(c1.get("cate1Id").unwrap_or(&Value::Null));
            let name = json_str(c1.get("cate1Name").unwrap_or(&Value::Null));
            let mut children = Vec::new();
            for c2 in &cate2 {
                if json_str(c2.get("cate1Id").unwrap_or(&Value::Null)) != id {
                    continue;
                }
                children.push(LiveSubCategory {
                    id: json_str(c2.get("cate2Id").unwrap_or(&Value::Null)),
                    name: json_str(c2.get("cate2Name").unwrap_or(&Value::Null)),
                    parent_id: id.clone(),
                    pic: c2.get("icon").map(json_str).filter(|s| !s.is_empty()),
                });
            }
            categories.push(LiveCategory { id, name, children });
        }
        categories.sort_by(|a, b| {
            a.id.parse::<i64>()
                .unwrap_or(0)
                .cmp(&b.id.parse::<i64>().unwrap_or(0))
        });
        Ok(categories)
    }

    async fn get_recommend_rooms(&self, page: u32) -> AppResult<RoomListPage> {
        let page = page.max(1);
        let url = format!("https://www.douyu.com/japi/weblist/apinc/allpage/6/{page}");
        let v = self.get_json(&url, "https://www.douyu.com/").await?;
        let mut page_data = parse_mix_list(&v)?;
        let pgcnt = json_i64(v.pointer("/data/pgcnt").unwrap_or(&Value::Null));
        // 该公开接口即使返回完整的 40 条分页，目前也上报 `pgcnt: 0`。
        // 回退到其文档记载的分页大小；
        // 若后续页面没有新增房间，前端也会停止翻页。
        page_data.has_more = has_more_page(page, pgcnt, page_data.items.len(), RECOMMEND_PAGE_SIZE);
        Ok(page_data)
    }

    async fn get_category_rooms(
        &self,
        category: &LiveSubCategory,
        page: u32,
    ) -> AppResult<RoomListPage> {
        let page = page.max(1);
        // 移动端 API 是第一方 App 来源：它返回明确的 `total`，只需 iPhone UA，
        // 且通常比桌面 Web 目录的限制更少。地区受限网络会以 `error: 1` 拒绝它，
        // 此时回退到 Web 端的 `mixList` 接口。
        let offset = (page - 1) * DIRECTORY_PAGE_SIZE as u32;
        let mobile_url = format!(
            "https://m.douyu.com/hgapi/live/cate/newRecList?offset={offset}&cate2={}&limit={DIRECTORY_PAGE_SIZE}",
            category.id
        );
        if let Ok(v) = self.get_json(&mobile_url, "https://m.douyu.com/").await {
            if let Ok(page_data) = parse_mobile_recommend_list(&v, page, DIRECTORY_PAGE_SIZE) {
                return Ok(page_data);
            }
            tracing::debug!("douyu mobile category list rejected; falling back to web API");
        }

        let url = format!(
            "https://www.douyu.com/gapi/rkc/directory/mixList/2_{}/{page}",
            category.id
        );
        let v = self.get_json(&url, "https://www.douyu.com/").await?;
        let mut page_data = parse_mix_list(&v)?;
        let pgcnt = json_i64(v.pointer("/data/pgcnt").unwrap_or(&Value::Null));
        page_data.has_more = has_more_page(page, pgcnt, page_data.items.len(), DIRECTORY_PAGE_SIZE);
        Ok(page_data)
    }

    async fn search_rooms(&self, keyword: &str, page: u32) -> AppResult<RoomListPage> {
        let page = page.max(1);
        let url = format!(
            "https://www.douyu.com/japi/search/api/searchShow?kw={}&page={page}&pageSize=20",
            urlencoding_encode(keyword)
        );
        let mut request = self
            .client
            .get(&url)
            .header("user-agent", UA)
            .header("referer", "https://www.douyu.com/search/");
        let cookie = self.search_cookie();
        if !cookie.is_empty() {
            request = request.header("cookie", cookie);
        }
        let text = request
            .send()
            .await
            .map_err(|e| Self::err(format!("http: {e}")))?
            .text()
            .await
            .map_err(|e| Self::err(format!("body: {e}")))?;
        let v: Value = serde_json::from_str(&text).map_err(|e| Self::err(format!("json: {e}")))?;
        let mut items = Vec::new();
        if let Some(arr) = v
            .pointer("/data/relateShow")
            .or_else(|| v.pointer("/data/list"))
            .and_then(|x| x.as_array())
        {
            for item in arr {
                let room_id = json_str(
                    item.get("rid")
                        .or_else(|| item.get("roomId"))
                        .unwrap_or(&Value::Null),
                );
                if room_id.is_empty() {
                    continue;
                }
                items.push(LiveRoomItem {
                    site_id: SiteId::Douyu,
                    room_id,
                    title: json_str(
                        item.get("roomName")
                            .or_else(|| item.get("rn"))
                            .unwrap_or(&Value::Null),
                    ),
                    cover: json_str(
                        item.get("roomSrc")
                            .or_else(|| item.get("rs16"))
                            .unwrap_or(&Value::Null),
                    ),
                    user_name: json_str(
                        item.get("nickName")
                            .or_else(|| item.get("nn"))
                            .unwrap_or(&Value::Null),
                    ),
                    online: json_i64(
                        item.get("hot")
                            .or_else(|| item.get("ol"))
                            .unwrap_or(&Value::Null),
                    ),
                });
            }
        }
        Ok(RoomListPage {
            has_more: items.len() >= 20,
            items,
        })
    }

    async fn get_room_live_status(&self, room_id: &str) -> AppResult<LiveRoomStatus> {
        // `betard` 在第一个响应中就带有开播状态。
        // 不要在这里调用 h5room/homeH5Enc/getH5Play：
        // 那些接口只为进入房间后的播放元数据而存在。
        let room = self.room_info(room_id).await?;
        Ok(live_status_from_room_info(&room))
    }

    async fn get_room_detail(&self, room_id: &str) -> AppResult<LiveRoomDetail> {
        let root = self.room_info(room_id).await?;
        let room = root.get("room").cloned().unwrap_or_else(|| root.clone());

        // `betard` 足以提供播放元数据，但不可靠地保留直播开始时间。
        // 轻量的 H5 房间接口暴露 `data.show_time`；
        // 把它视为可选，使一次辅助接口的瞬时失败绝不会阻止进入房间。
        let live_started_at = self
            .get_json(
                &format!("https://www.douyu.com/swf_api/h5room/{room_id}"),
                &format!("https://www.douyu.com/{room_id}"),
            )
            .await
            .ok()
            .as_ref()
            .and_then(|response| {
                parse_live_started_at(
                    response
                        .pointer("/data/show_time")
                        .or_else(|| response.pointer("/data/live_start_time")),
                )
            })
            .or_else(|| {
                parse_live_started_at(
                    room.get("show_time")
                        .or_else(|| room.get("live_start_time"))
                        .or_else(|| room.get("start_time")),
                )
            });

        let show_status = json_i64(room.get("show_status").unwrap_or(&Value::Null));
        let video_loop = json_i64(room.get("videoLoop").unwrap_or(&Value::Null));
        let hot = room
            .pointer("/room_biz_all/hot")
            .map(json_i64)
            .unwrap_or_else(|| json_i64(room.get("hn").unwrap_or(&Value::Null)));

        Ok(LiveRoomDetail {
            site_id: SiteId::Douyu,
            room_id: json_str(
                room.get("room_id")
                    .unwrap_or(&Value::String(room_id.into())),
            ),
            title: json_str(room.get("room_name").unwrap_or(&Value::Null)),
            cover: json_str(room.get("room_pic").unwrap_or(&Value::Null)),
            user_name: json_str(room.get("owner_name").unwrap_or(&Value::Null)),
            user_avatar: json_str(room.get("owner_avatar").unwrap_or(&Value::Null)),
            online: hot,
            status: show_status == 1 && video_loop != 1,
            live_started_at,
            notice: json_str(room.get("show_details").unwrap_or(&Value::Null)),
            url: format!("https://www.douyu.com/{room_id}"),
            raw: serde_json::json!({
                "room_id": room_id,
            }),
        })
    }

    async fn get_play_qualities(&self, detail: &LiveRoomDetail) -> AppResult<Vec<LivePlayQuality>> {
        let v = self
            .request_play_data(&detail.room_id, -1, "")
            .await?;
        let data_obj = v.get("data").cloned().unwrap_or(Value::Null);
        let mut cdns: Vec<String> = data_obj
            .get("cdnsWithName")
            .and_then(|x| x.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|i| json_str(i.get("cdn").unwrap_or(&Value::Null)))
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        cdns.sort_by(|a, b| {
            let as_ = a.starts_with("scdn");
            let bs = b.starts_with("scdn");
            as_.cmp(&bs)
        });

        let mut qualities = Vec::new();
        if let Some(arr) = data_obj.get("multirates").and_then(|x| x.as_array()) {
            for item in arr {
                let rate = json_i64(item.get("rate").unwrap_or(&Value::Null));
                let name = json_str(item.get("name").unwrap_or(&Value::Null));
                qualities.push(LivePlayQuality {
                    quality: if name.is_empty() {
                        format!("rate{rate}")
                    } else {
                        name
                    },
                    data: serde_json::json!({
                        "rate": rate,
                        "cdns": cdns,
                    }),
                });
            }
        }
        if qualities.is_empty() {
            qualities.push(LivePlayQuality {
                quality: "原画".into(),
                data: serde_json::json!({
                    "rate": 0,
                    "cdns": cdns,
                }),
            });
        }
        Ok(qualities)
    }

    async fn get_play_urls(
        &self,
        detail: &LiveRoomDetail,
        quality: &LivePlayQuality,
    ) -> AppResult<Vec<PlayUrl>> {
        let rate = json_i64(quality.data.get("rate").unwrap_or(&Value::Null));
        let cdns = quality
            .data
            .get("cdns")
            .and_then(|x| x.as_array())
            .cloned()
            .unwrap_or_default();
        let room_id = detail.room_id.clone();
        let mut headers = HashMap::new();
        headers.insert("user-agent".into(), UA.into());
        headers.insert("referer".into(), format!("https://www.douyu.com/{room_id}"));

        let mut urls = Vec::new();
        for (index, cdn_v) in cdns.into_iter().enumerate() {
            let cdn = json_str(&cdn_v);
            let v = self.request_play_data(&room_id, rate, &cdn).await?;
            let data = v.get("data").cloned().unwrap_or(Value::Null);
            let rtmp_url = json_str(data.get("rtmp_url").unwrap_or(&Value::Null));
            let rtmp_live = html_unescape(&json_str(data.get("rtmp_live").unwrap_or(&Value::Null)));
            if rtmp_url.is_empty() || rtmp_live.is_empty() {
                continue;
            }
            let url = format!("{rtmp_url}/{rtmp_live}");
            urls.push(PlayUrl::inferred(
                format!("douyu:{cdn}"),
                format!("线路{}", index + 1),
                index as u32,
                url,
                headers.clone(),
            ));
        }
        if urls.is_empty() {
            return Err(Self::err("no douyu play urls"));
        }
        Ok(urls)
    }
}

fn urlencoding_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    use super::*;

    #[test]
    fn recommendation_pagination_uses_full_page_fallback_when_pgcnt_is_zero() {
        assert!(has_more_page(
            1,
            0,
            RECOMMEND_PAGE_SIZE,
            RECOMMEND_PAGE_SIZE
        ));
        assert!(!has_more_page(
            1,
            0,
            RECOMMEND_PAGE_SIZE - 1,
            RECOMMEND_PAGE_SIZE
        ));
        assert!(has_more_page(1, 2, 1, RECOMMEND_PAGE_SIZE));
        assert!(!has_more_page(
            2,
            2,
            RECOMMEND_PAGE_SIZE,
            RECOMMEND_PAGE_SIZE
        ));
    }

    #[test]
    fn search_cookie_preserves_saved_device_values() {
        let site = DouyuSite::new_with_cookie(
            reqwest::Client::builder().no_proxy().build().unwrap(),
            "Cookie: auth=fixture; dy_did=custom-did".into(),
        );

        let cookie = site.search_cookie();
        assert!(cookie.contains("auth=fixture"));
        assert!(cookie.contains("dy_did=custom-did"));
        assert!(cookie.contains("acf_did=10000000000000000000000000001501"));
    }

    #[test]
    fn scopes_saved_cookies_to_douyu_https_hosts() {
        assert!(is_douyu_cookie_url("https://www.douyu.com/japi/weblist"));
        assert!(is_douyu_cookie_url("https://m.douyu.com/api/cate/list"));
        assert!(!is_douyu_cookie_url("http://www.douyu.com/japi/weblist"));
        assert!(!is_douyu_cookie_url("https://douyu.com.example.test/api"));
        assert!(!is_douyu_cookie_url("https://webcast.amemv.com/api"));
    }

    #[test]
    fn room_info_status_probe_uses_only_opening_fields() {
        let live = serde_json::json!({
            "room": {
                "show_status": "1",
                "videoLoop": 0,
                "show_time": 1_704_067_200
            }
        });
        assert_eq!(
            live_status_from_room_info(&live),
            LiveRoomStatus {
                status: true,
                live_started_at: Some(1_704_067_200_000),
            }
        );

        let replay = serde_json::json!({
            "room": { "show_status": 1, "videoLoop": 1 }
        });
        assert!(!live_status_from_room_info(&replay).status);
    }

    #[test]
    fn online_label_is_parsed_to_an_approximate_count() {
        assert_eq!(parse_online_label("101.8万".into()), 1_018_000);
        assert_eq!(parse_online_label("5.6k".into()), 5_600);
        assert_eq!(parse_online_label("1.2K".into()), 1_200);
        assert_eq!(parse_online_label("12345".into()), 12_345);
        assert_eq!(parse_online_label("".into()), 0);
        assert_eq!(parse_online_label("abc".into()), 0);
    }

    #[tokio::test]
    async fn saved_cookie_is_not_attached_to_non_douyu_requests() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 2048];
            let length = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..length]).to_ascii_lowercase();
            assert!(!request.contains("cookie: sessionid=fixture-session"));
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                )
                .unwrap();
        });

        let site = DouyuSite::new_with_cookie(
            reqwest::Client::builder().no_proxy().build().unwrap(),
            "sessionid=fixture-session".into(),
        );
        let response = site
            .get_json(&format!("http://{address}/api"), "https://www.douyu.com/")
            .await
            .unwrap();

        assert!(response.is_object());
        server.join().unwrap();
    }

    /// 完整链路：推荐 → 直播间 → 清晰度 → 播放地址。
    /// 覆盖纯 Rust 签名（`getEncryption` 描述符 + MD5 链 + `getH5PlayV1`）
    /// 的真实服务器行为。
    #[tokio::test]
    #[ignore = "live network smoke — run with --ignored"]
    async fn live_play_url_smoke() {
        let site = DouyuSite::default();
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
