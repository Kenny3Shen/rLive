//! Innertube 请求、搜索分页和静态直播分类。

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use reqwest::Client;
use serde_json::{Value, json};

use crate::error::AppResult;
use crate::models::live::{LiveCategory, LiveRoomItem, LiveSubCategory, RoomListPage};

use super::YoutubeSite;
use super::parse::{parse_channel_avatar, parse_continuation, parse_room_items};

pub const DEFAULT_USER_AGENT: &str =
    "com.google.android.youtube/20.10.38 (Linux; U; Android 15) gzip";
const WEB_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const INNERTUBE_API: &str = "https://www.youtube.com/youtubei/v1/";
const LIVE_SEARCH_PARAMS: &str = "EgJAAQ%3D%3D";
const SEARCH_CACHE_TTL: Duration = Duration::from_secs(3 * 60);
const SEARCH_CACHE_LIMIT: usize = 24;
const MAX_SEARCH_PAGES: usize = 20;

struct SearchCache {
    pages: Vec<RoomListPage>,
    continuation: Option<String>,
    updated_at: Instant,
}

enum SearchPosition {
    Page(RoomListPage),
    Fetch {
        expected_page: usize,
        continuation: Option<String>,
    },
    Exhausted,
}

static SEARCH_CACHE: OnceLock<Mutex<HashMap<String, SearchCache>>> = OnceLock::new();

fn search_cache() -> &'static Mutex<HashMap<String, SearchCache>> {
    SEARCH_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn search_cache_key(route: &crate::proxy::ProxyRoute, keyword: &str) -> String {
    // 游标和结果绑定出口；换代理后不得复用旧出口的页面。仅保存进程内摘要，
    // 避免在额外缓存键里长期保留代理凭据。
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    format!("{route:?}").hash(&mut hasher);
    format!("{:x}:{keyword}", hasher.finish())
}

fn cached_search_position(keyword: &str, page: usize) -> SearchPosition {
    let mut cache = search_cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let Some(cached) = cache.get(keyword) else {
        return SearchPosition::Fetch {
            expected_page: 1,
            continuation: None,
        };
    };
    if cached.updated_at.elapsed() >= SEARCH_CACHE_TTL {
        cache.remove(keyword);
        return SearchPosition::Fetch {
            expected_page: 1,
            continuation: None,
        };
    }
    if let Some(result) = cached.pages.get(page.saturating_sub(1)) {
        return SearchPosition::Page(result.clone());
    }
    match &cached.continuation {
        Some(token) => SearchPosition::Fetch {
            expected_page: cached.pages.len() + 1,
            continuation: Some(token.clone()),
        },
        None => SearchPosition::Exhausted,
    }
}

fn store_search_page(
    keyword: &str,
    expected_page: usize,
    result: RoomListPage,
    continuation: Option<String>,
) {
    let mut cache = search_cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if expected_page == 1 {
        if cache.len() >= SEARCH_CACHE_LIMIT {
            cache.retain(|_, item| item.updated_at.elapsed() < SEARCH_CACHE_TTL);
            if cache.len() >= SEARCH_CACHE_LIMIT {
                cache.clear();
            }
        }
        cache.insert(
            keyword.to_owned(),
            SearchCache {
                pages: vec![result],
                continuation,
                updated_at: Instant::now(),
            },
        );
        return;
    }
    let Some(item) = cache.get_mut(keyword) else {
        return;
    };
    if expected_page == item.pages.len() + 1 {
        item.pages.push(result);
        item.continuation = continuation;
    }
}

pub(super) fn categories() -> Vec<LiveCategory> {
    let children = [
        ("hot", "热门直播", "直播"),
        ("news", "新闻", "直播 新闻"),
        ("gaming", "游戏", "直播 游戏"),
        ("music", "音乐", "直播 音乐"),
        ("sports", "体育", "直播 体育"),
        ("technology", "科技", "直播 科技"),
        ("learning", "知识", "直播 学习"),
        ("entertainment", "娱乐", "直播 娱乐"),
        ("life", "生活", "直播 生活"),
    ]
    .into_iter()
    .map(|(id, name, _)| LiveSubCategory {
        id: id.to_owned(),
        name: name.to_owned(),
        parent_id: "youtube".to_owned(),
        pic: None,
    })
    .collect();
    vec![LiveCategory {
        id: "youtube".to_owned(),
        name: "YouTube 直播".to_owned(),
        children,
    }]
}

pub(super) fn category_query(id: &str) -> Option<&'static str> {
    match id {
        "hot" => Some("直播"),
        "news" => Some("直播 新闻"),
        "gaming" => Some("直播 游戏"),
        "music" => Some("直播 音乐"),
        "sports" => Some("直播 体育"),
        "technology" => Some("直播 科技"),
        "learning" => Some("直播 学习"),
        "entertainment" => Some("直播 娱乐"),
        "life" => Some("直播 生活"),
        _ => None,
    }
}

fn web_context() -> Value {
    json!({
        "client": {
            "clientName": "WEB",
            "clientVersion": "2.20241125.00.00",
            "hl": "zh-CN",
            "gl": "US",
            "userAgent": WEB_USER_AGENT,
        }
    })
}

pub(super) fn android_context() -> Value {
    json!({
        "client": {
            "clientName": "ANDROID",
            "clientVersion": "20.10.38",
            "androidSdkVersion": 35,
            "hl": "zh-CN",
            "gl": "US",
            "userAgent": DEFAULT_USER_AGENT,
        }
    })
}

async fn post_innertube(
    client: &Client,
    route: &str,
    body: Value,
    user_agent: &str,
) -> AppResult<Value> {
    let response = client
        .post(format!("{INNERTUBE_API}{route}?prettyPrint=false"))
        .header("user-agent", user_agent)
        .header("origin", "https://www.youtube.com")
        .header("referer", "https://www.youtube.com/")
        .header("accept", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|error| {
            YoutubeSite::upstream_err(format!(
                "YouTube 请求失败: {}",
                crate::http_client::describe_request_error(&error)
            ))
        })?;
    let status = response.status();
    if !status.is_success() {
        return Err(YoutubeSite::upstream_err(format!(
            "YouTube 返回 HTTP {}",
            status.as_u16()
        )));
    }
    response
        .json::<Value>()
        .await
        .map_err(|_| YoutubeSite::parse_err("YouTube 返回了无法识别的数据，接口格式可能已变化"))
}

async fn search_once(
    client: &Client,
    query: Option<&str>,
    continuation: Option<&str>,
) -> AppResult<Value> {
    let mut body = json!({ "context": web_context() });
    if let Some(token) = continuation {
        body["continuation"] = Value::String(token.to_owned());
    } else {
        body["query"] = Value::String(query.unwrap_or_default().to_owned());
        body["params"] = Value::String(LIVE_SEARCH_PARAMS.to_owned());
    }
    post_innertube(client, "search", body, WEB_USER_AGENT).await
}

impl YoutubeSite {
    pub(super) async fn search_live(
        &self,
        keyword: &str,
        requested_page: u32,
    ) -> AppResult<RoomListPage> {
        let keyword = keyword.trim();
        if keyword.is_empty() {
            return Ok(RoomListPage::empty());
        }
        let target_page = requested_page.max(1) as usize;
        if target_page > MAX_SEARCH_PAGES {
            return Ok(RoomListPage::empty());
        }
        let cache_key = search_cache_key(&self.route, keyword);
        // 缓存被并发请求淘汰时允许重建，但不能无界重拉第一页。
        for _ in 0..MAX_SEARCH_PAGES * 2 {
            let (expected_page, continuation) =
                match cached_search_position(&cache_key, target_page) {
                    SearchPosition::Page(result) => return Ok(result),
                    SearchPosition::Exhausted => return Ok(RoomListPage::empty()),
                    SearchPosition::Fetch {
                        expected_page,
                        continuation,
                    } => (expected_page, continuation),
                };
            let response = search_once(
                &self.client,
                (expected_page == 1).then_some(keyword),
                continuation.as_deref(),
            )
            .await?;
            let items = parse_room_items(&response, &self.site_id)
                .into_iter()
                .filter(|item: &LiveRoomItem| item.live_status == Some(true))
                .collect();
            let next = parse_continuation(&response);
            let page = RoomListPage {
                items,
                has_more: next.is_some() && expected_page < MAX_SEARCH_PAGES,
            };
            store_search_page(&cache_key, expected_page, page.clone(), next);
            if expected_page == target_page {
                return Ok(page);
            }
        }
        Err(YoutubeSite::upstream_err(
            "YouTube 搜索状态已变化，请重新搜索",
        ))
    }

    pub(super) async fn player(&self, video_id: &str) -> AppResult<Value> {
        let body = json!({
            "context": android_context(),
            "videoId": video_id,
            "contentCheckOk": true,
            "racyCheckOk": true,
        });
        post_innertube(&self.client, "player", body, DEFAULT_USER_AGENT).await
    }

    /// 详情页专用的频道头像查询。`player` 只返回视频元数据，频道头像位于
    /// Web 的 `next` 数据中。轻量开播状态刷新不会调用这里。
    pub(super) async fn channel_avatar(&self, video_id: &str) -> AppResult<String> {
        let body = json!({
            "context": web_context(),
            "videoId": video_id,
        });
        let value = post_innertube(&self.client, "next", body, WEB_USER_AGENT).await?;
        Ok(parse_channel_avatar(&value))
    }

    pub(super) async fn get_text(&self, url: &str) -> AppResult<String> {
        let response = self
            .client
            .get(url)
            .header("user-agent", WEB_USER_AGENT)
            .header("accept-language", "zh-CN,zh;q=0.9,en;q=0.7")
            .header("accept", "text/html,application/xhtml+xml")
            .send()
            .await
            .map_err(|error| {
                YoutubeSite::upstream_err(format!(
                    "YouTube 网页请求失败: {}",
                    crate::http_client::describe_request_error(&error)
                ))
            })?;
        if !response.status().is_success() {
            return Err(YoutubeSite::upstream_err(format!(
                "YouTube 网页返回 HTTP {}",
                response.status().as_u16()
            )));
        }
        response
            .text()
            .await
            .map_err(|_| YoutubeSite::upstream_err("读取 YouTube 网页响应失败"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn categories_resolve_to_live_keywords() {
        let all = categories();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].children.len(), 9);
        assert_eq!(category_query("hot"), Some("直播"));
        assert!(category_query("unknown").is_none());
    }

    #[test]
    fn changing_route_does_not_reuse_previous_search_cursor() {
        let keyword = "route-isolation-test";
        let direct = search_cache_key(&crate::proxy::ProxyRoute::Direct, keyword);
        let proxy = search_cache_key(
            &crate::proxy::ProxyRoute::Custom("http://127.0.0.1:7788".into()),
            keyword,
        );
        store_search_page(
            &direct,
            1,
            RoomListPage::empty(),
            Some("direct-cursor".into()),
        );
        assert!(matches!(
            cached_search_position(&proxy, 2),
            SearchPosition::Fetch {
                expected_page: 1,
                continuation: None
            }
        ));
        assert!(matches!(
            cached_search_position(&direct, 2),
            SearchPosition::Fetch {
                expected_page: 2,
                continuation: Some(_)
            }
        ));
        search_cache().lock().unwrap().remove(&direct);
    }
}
