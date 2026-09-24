//! 实验性抖音公开作品；不经过直播 LiveSite trait。
use super::DouyinSite;
use super::api::{DEFAULT_USER_AGENT, cookie_pairs, generate_ms_token, normalize_cookie};
use crate::error::{AppError, AppResult};
use crate::models::douyin_video::{DouyinVideoFeedPage, DouyinVideoItem};
use reqwest::{Client, Url};
use serde_json::Value;

pub const VIDEO_REFERER: &str = "https://www.douyin.com/";
const DETAIL_URL: &str = "https://www.douyin.com/aweme/v1/web/aweme/detail/";
const FEED_URL: &str = "https://www.douyin.com/aweme/v1/web/tab/feed/";
const FEED_COUNT: usize = 10;

/// ttwid/msToken 只代表匿名设备会话，不能当作用户登录同意的凭据。
/// 存在登录字段也不代表它仍有效；上游拒绝时不降级为匿名流。
pub fn require_feed_cookie(cookie: &str) -> AppResult<()> {
    let pairs = cookie_pairs(&normalize_cookie(cookie));
    if pairs.iter().any(|(key, value)| {
        (key.eq_ignore_ascii_case("sessionid") || key.eq_ignore_ascii_case("sessionid_ss"))
            && !value.trim().is_empty()
    }) {
        Ok(())
    } else {
        Err(AppError::new(
            "douyin_login_required",
            "抖音推荐流需要登录 Cookie，请前往设置 → 账号扫码登录或保存完整 Cookie",
        )
        .with_site("douyin"))
    }
}

fn invalid(message: &str) -> AppError {
    AppError::new("douyin_video_invalid", message).with_site("douyin")
}

#[derive(Debug, PartialEq)]
enum VideoInput {
    Id(String),
    Short(Url),
}

fn valid_id(id: &str) -> bool {
    (10..=24).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit())
}

/// 每一次跳转都校验，不能用字符串前缀判断主机，也不发送 Cookie。
fn parse_video_url(url: Url) -> AppResult<VideoInput> {
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Err(invalid(
            "仅支持无账号信息、使用默认端口的 HTTPS 抖音作品链接",
        ));
    }
    let path = url.path().trim_matches('/');
    let id = match url.host_str().unwrap_or_default() {
        "www.douyin.com" | "douyin.com" => {
            path.strip_prefix("video/").map(str::to_string).or_else(|| {
                if path.is_empty() {
                    url.query_pairs()
                        .find(|(k, _)| k == "modal_id")
                        .map(|(_, v)| v.into_owned())
                } else {
                    None
                }
            })
        }
        "www.iesdouyin.com" | "iesdouyin.com" => {
            path.strip_prefix("share/video/").map(str::to_string)
        }
        "v.douyin.com"
            if !path.is_empty()
                && path.len() <= 64
                && path.bytes().all(|b| b.is_ascii_alphanumeric()) =>
        {
            return Ok(VideoInput::Short(url));
        }
        _ => None,
    };
    match id.filter(|id| valid_id(id)) {
        Some(id) => Ok(VideoInput::Id(id)),
        None => Err(invalid(
            "链接不是受支持的抖音视频作品；不支持直播、图集或作者主页",
        )),
    }
}

fn parse_input(input: &str) -> AppResult<VideoInput> {
    let input = input.trim();
    if input.len() > 4096 {
        return Err(invalid("分享内容过长，请只粘贴作品链接"));
    }
    if valid_id(input) {
        return Ok(VideoInput::Id(input.into()));
    }
    let start = input
        .find("https://")
        .ok_or_else(|| invalid("请粘贴 HTTPS 抖音作品链接、分享文字或作品 ID"))?;
    let raw = input[start..]
        .split(|c: char| c.is_whitespace() || "\"'<>，。；！）】》".contains(c))
        .next()
        .unwrap_or_default();
    let url = Url::parse(raw).map_err(|_| invalid("作品链接格式无效"))?;
    parse_video_url(url)
}

pub async fn resolve_video_id(input: &str, no_redirect: &Client) -> AppResult<String> {
    let mut target = parse_input(input)?;
    for _ in 0..5 {
        let VideoInput::Short(url) = target else {
            if let VideoInput::Id(id) = target {
                return Ok(id);
            }
            unreachable!();
        };
        let response = no_redirect
            .get(url.clone())
            .header("user-agent", DEFAULT_USER_AGENT)
            .send()
            .await
            .map_err(|_| invalid("抖音短链请求失败，请稍后重试"))?;
        if !response.status().is_redirection() {
            return Err(invalid(
                "抖音短链未返回作品跳转，可能需要访问验证；可改用完整作品链接",
            ));
        }
        let location = response
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| invalid("抖音短链缺少跳转地址"))?;
        let next = url
            .join(location)
            .map_err(|_| invalid("抖音短链跳转地址无效"))?;
        target = parse_video_url(next)?;
    }
    if let VideoInput::Id(id) = target {
        Ok(id)
    } else {
        Err(invalid("抖音短链跳转次数过多"))
    }
}

fn media_url(address: &Value) -> Option<String> {
    address
        .get("url_list")?
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .find_map(|raw| {
            let url = Url::parse(raw).ok()?;
            let host = url.host_str()?;
            let trusted = ["douyinvod.com", "bytecdn.cn", "bytecdn.com"]
                .iter()
                .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")));
            (trusted
                && url.scheme() == "https"
                && url.username().is_empty()
                && url.password().is_none()
                && url.port().is_none())
            .then(|| url.to_string())
        })
}

pub fn parse_video_detail(value: &Value, id: &str) -> AppResult<(DouyinVideoItem, String)> {
    if value.get("status_code").and_then(Value::as_i64) != Some(0) {
        return Err(invalid("抖音未返回成功的作品响应"));
    }
    parse_video_item(&value["aweme_detail"], Some(id))
}

fn parse_video_item(
    detail: &Value,
    expected_id: Option<&str>,
) -> AppResult<(DouyinVideoItem, String)> {
    let returned_id = detail["aweme_id"]
        .as_str()
        .map(str::to_string)
        .or_else(|| detail["aweme_id"].as_u64().map(|v| v.to_string()));
    let id = returned_id
        .as_deref()
        .filter(|id| valid_id(id))
        .ok_or_else(|| invalid("作品 ID 无效"))?;
    if expected_id.is_some_and(|expected| expected != id) {
        return Err(invalid("作品不存在、不可见或返回了不同的作品"));
    }
    if detail["is_ads"].as_bool() == Some(true)
        || detail["is_ads"].as_i64() == Some(1)
        || detail.get("raw_ad_data").is_some_and(|ad| !ad.is_null())
        || detail["images"]
            .as_array()
            .is_some_and(|images| !images.is_empty())
        || matches!(detail["aweme_type"].as_i64(), Some(68 | 101))
    {
        return Err(invalid("实验入口暂不支持图集或直播作品"));
    }
    let video = &detail["video"];
    let mut url = media_url(&video["play_addr_h264"]);
    if url.is_none() {
        url = video["bit_rate"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|track| {
                track["is_h265"].as_i64() == Some(0) && track["is_bytevc1"].as_i64() != Some(1)
            })
            .filter_map(|track| {
                media_url(&track["play_addr"])
                    .map(|url| (track["bit_rate"].as_u64().unwrap_or(0), url))
            })
            .max_by_key(|(rate, _)| *rate)
            .map(|(_, url)| url);
    }
    if url.is_none()
        && (video["is_h265"].as_i64() == Some(0) || video["is_bytevc1"].as_i64() == Some(0))
        && video["is_h265"].as_i64() != Some(1)
        && video["is_bytevc1"].as_i64() != Some(1)
    {
        url = media_url(&video["play_addr"]);
    }
    let url =
        url.ok_or_else(|| invalid("作品未提供受支持的 H.264 视频地址，可能不可见或需要访问验证"))?;
    let item = DouyinVideoItem {
        id: id.into(),
        title: detail["desc"].as_str().unwrap_or_default().into(),
        author: detail["author"]["nickname"]
            .as_str()
            .unwrap_or_default()
            .into(),
        cover: String::new(), // 首版原生媒体不额外加载第三方封面。
        width: video["width"].as_u64().unwrap_or(0),
        height: video["height"].as_u64().unwrap_or(0),
        duration: video["duration"].as_u64().unwrap_or(0) as f64 / 1000.0,
        share_url: format!("https://www.douyin.com/video/{id}"),
    };
    Ok((item, url))
}

/// 只产出元数据，不把短时媒体 URL 放进前端推荐缓存，也不为整批创建播放代理。
fn parse_video_feed(value: &Value) -> AppResult<DouyinVideoFeedPage> {
    if value["status_code"].as_i64() != Some(0) {
        return Err(invalid("抖音未返回成功的推荐响应"));
    }
    if value
        .get("not_login_module")
        .is_some_and(|module| !module.is_null())
    {
        return Err(AppError::new(
            "douyin_login_required",
            "抖音未接受当前登录态，请更新 Cookie 后重试",
        )
        .with_site("douyin"));
    }
    let entries = value["aweme_list"]
        .as_array()
        .ok_or_else(|| invalid("抖音推荐响应缺少作品列表，接口可能已变化"))?;
    let mut seen = std::collections::HashSet::new();
    let items: Vec<_> = entries
        .iter()
        .filter_map(|entry| parse_video_item(entry, None).ok().map(|(item, _)| item))
        .filter(|item| seen.insert(item.id.clone()))
        .take(FEED_COUNT)
        .collect();
    let has_more = !items.is_empty()
        && (value["has_more"].as_i64() == Some(1) || value["has_more"].as_bool() == Some(true));
    Ok(DouyinVideoFeedPage { items, has_more })
}

fn video_params() -> Vec<(String, String)> {
    [
        ("device_platform", "webapp"),
        ("aid", "6383"),
        ("channel", "channel_pc_web"),
        ("pc_client_type", "1"),
        ("version_code", "170400"),
        ("version_name", "17.4.0"),
        ("cookie_enabled", "true"),
        ("screen_width", "1920"),
        ("screen_height", "1080"),
        ("browser_language", "zh-CN"),
        ("browser_platform", "Win32"),
        ("browser_name", "Chrome"),
        ("browser_version", "125.0.0.0"),
        ("browser_online", "true"),
        ("engine_name", "Blink"),
        ("engine_version", "125.0.0.0"),
        ("os_name", "Windows"),
        ("os_version", "10"),
        ("platform", "PC"),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v.into()))
    .chain([("msToken".into(), generate_ms_token())])
    .collect()
}

impl DouyinSite {
    pub async fn video_feed(&self) -> AppResult<DouyinVideoFeedPage> {
        // 必须在匿名会话补齐之前检查用户保存的登录字段。
        require_feed_cookie(&self.cookie()?)?;
        self.ensure_web_session().await?;
        let mut params = video_params();
        params.push(("count".into(), FEED_COUNT.to_string()));
        let value = self
            .get_signed_json(FEED_URL, &params, VIDEO_REFERER)
            .await?;
        parse_video_feed(&value)
    }

    pub async fn video_detail(&self, id: &str) -> AppResult<(DouyinVideoItem, String)> {
        if !valid_id(id) {
            return Err(invalid("作品 ID 无效"));
        }
        self.ensure_web_session().await?;
        let mut params = video_params();
        params.push(("aweme_id".into(), id.into()));
        let value = self
            .get_signed_json(DETAIL_URL, &params, VIDEO_REFERER)
            .await?;
        parse_video_detail(&value, id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const ID: &str = "7520000000000000001";
    #[test]
    fn validates_inputs_without_losing_large_ids() {
        for input in [
            ID.to_string(),
            format!("https://www.douyin.com/video/{ID}?x=1"),
            format!("https://www.iesdouyin.com/share/video/{ID}/"),
            format!("分享：https://www.douyin.com/video/{ID} 复制打开"),
        ] {
            assert_eq!(parse_input(&input).unwrap(), VideoInput::Id(ID.into()));
        }
        assert!(matches!(
            parse_input("复制 https://v.douyin.com/AbC123/ 打开"),
            Ok(VideoInput::Short(_))
        ));
        for raw in [
            "https://127.0.0.1/video/7520000000000000001",
            "https://www.douyin.com.evil.test/video/7520000000000000001",
            "https://user@www.douyin.com/video/7520000000000000001",
            "https://www.douyin.com:8443/video/7520000000000000001",
            "http://www.douyin.com/video/7520000000000000001",
            "https://live.douyin.com/7520000000000000001",
            "https://www.douyin.com/note/7520000000000000001",
            "https://v.douyin.com/private/other",
        ] {
            assert!(parse_input(raw).is_err(), "{raw}");
        }
    }
    #[test]
    fn accepts_only_matching_video_and_trusted_h264() {
        let mut value = json!({"status_code":0,"aweme_detail":{"aweme_id":ID,"desc":"视频","video":{"duration":1234,"bit_rate":[
            {"is_h265":1,"bit_rate":9000,"play_addr":{"url_list":["https://v1.douyinvod.com/hevc.mp4"]}},
            {"is_h265":0,"bit_rate":1000,"play_addr":{"url_list":["https://v1.douyinvod.com/avc.mp4"]}}
        ]}}});
        let (item, url) = parse_video_detail(&value, ID).unwrap();
        assert_eq!(item.id, ID);
        assert_eq!(item.duration, 1.234);
        assert!(url.ends_with("avc.mp4"));
        assert!(parse_video_detail(&value, "7520000000000000002").is_err());
        value["aweme_detail"]["images"] = json!([{}]);
        assert!(parse_video_detail(&value, ID).is_err());
        assert!(parse_video_detail(&json!({}), ID).is_err());
        for raw in [
            "https://127.0.0.1/x",
            "https://v1.douyinvod.com.evil.test/x",
            "http://v1.douyinvod.com/x",
            "https://u:p@v1.douyinvod.com/x",
        ] {
            assert!(media_url(&json!({"url_list":[raw]})).is_none());
        }
    }
    #[test]
    fn feed_requires_saved_login_not_anonymous_device_cookies() {
        for cookie in [
            "",
            "ttwid=device; msToken=temporary",
            "sessionid=; sessionid_ss=",
            "fake_sessionid=x",
        ] {
            assert_eq!(
                require_feed_cookie(cookie).unwrap_err().code,
                "douyin_login_required"
            );
        }
        for cookie in ["sessionid=test", "Cookie: sessionid_ss=test; ttwid=device"] {
            assert!(require_feed_cookie(cookie).is_ok());
        }
    }

    fn feed_item(id: &str) -> Value {
        json!({"aweme_id":id,"desc":"推荐作品","author":{"nickname":"作者"},
            "video":{"width":1080,"height":1920,"duration":1500,
                "play_addr_h264":{"url_list":["https://v1.douyinvod.com/avc.mp4"]}}})
    }

    #[test]
    fn feed_filters_deduplicates_and_keeps_large_ids_and_mixed_aspects() {
        let good = feed_item(ID);
        let mut horizontal = feed_item("7520000000000000002");
        horizontal["video"]["width"] = json!(1920);
        horizontal["video"]["height"] = json!(1080);
        let mut image = feed_item("7520000000000000003");
        image["images"] = json!([{}]);
        let mut live = feed_item("7520000000000000004");
        live["aweme_type"] = json!(101);
        let mut ad = feed_item("7520000000000000005");
        ad["is_ads"] = json!(true);
        let mut untrusted = feed_item("7520000000000000006");
        untrusted["video"]["play_addr_h264"]["url_list"] = json!(["https://127.0.0.1/private"]);
        let page = parse_video_feed(&json!({"status_code":0,"has_more":1,
            "aweme_list":[good.clone(),good,horizontal,image,live,ad,untrusted,{}]}))
        .unwrap();
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.items[0].id, ID);
        assert_eq!(page.items[1].width, 1920);
        assert!(page.has_more);
        let serialized = serde_json::to_string(&page).unwrap();
        assert!(!serialized.contains("douyinvod"));
        assert!(!serialized.contains("play_url"));
    }

    #[test]
    fn feed_empty_exhausted_malformed_and_login_responses_are_distinct() {
        for has_more in [json!(0), json!(false), Value::Null] {
            let page = parse_video_feed(
                &json!({"status_code":0,"has_more":has_more,"aweme_list":[feed_item(ID)]}),
            )
            .unwrap();
            assert!(!page.has_more);
        }
        let page =
            parse_video_feed(&json!({"status_code":0,"has_more":1,"aweme_list":[]})).unwrap();
        assert!(!page.has_more);
        for value in [
            json!({}),
            json!({"status_code":0}),
            json!({"status_code":2483,"aweme_list":[]}),
        ] {
            assert!(parse_video_feed(&value).is_err());
        }
        let error =
            parse_video_feed(&json!({"status_code":0,"not_login_module":{},"aweme_list":[]}))
                .unwrap_err();
        assert_eq!(error.code, "douyin_login_required");
    }

    #[test]
    fn feed_caps_each_response() {
        let items: Vec<_> = (0..30)
            .map(|i| feed_item(&format!("75200000000000000{i:02}")))
            .collect();
        let page =
            parse_video_feed(&json!({"status_code":0,"has_more":true,"aweme_list":items})).unwrap();
        assert_eq!(page.items.len(), FEED_COUNT);
        assert!(page.has_more);
    }

    #[tokio::test]
    #[ignore = "需要用户显式提供 RLIVE_DOUYIN_TEST_COOKIE；不输出 Cookie 或媒体 URL"]
    async fn cookie_video_feed_smoke() {
        let cookie = std::env::var("RLIVE_DOUYIN_TEST_COOKIE").expect("请显式提供测试账号 Cookie");
        let site = DouyinSite::new(crate::http_client::default_client(), cookie);
        let page = site.video_feed().await.unwrap();
        assert!(
            !page.items.is_empty(),
            "本批无受支持的作品，不能证明推荐可用"
        );
        let (item, url) = site.video_detail(&page.items[0].id).await.unwrap();
        assert_eq!(item.id, page.items[0].id);
        let response = crate::http_client::default_client()
            .get(url)
            .header("referer", VIDEO_REFERER)
            .header("user-agent", DEFAULT_USER_AGENT)
            .header("range", "bytes=0-1023")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::PARTIAL_CONTENT);
    }

    #[tokio::test]
    #[ignore = "需要网络；RLIVE_DOUYIN_TEST_ID 可指定公开作品，否则只取一批公开 feed 样本"]
    async fn public_video_smoke() {
        let site = DouyinSite::default();
        let id = if let Ok(id) = std::env::var("RLIVE_DOUYIN_TEST_ID") {
            id
        } else {
            site.ensure_web_session().await.unwrap();
            let params = vec![
                ("device_platform".into(), "webapp".into()),
                ("aid".into(), "6383".into()),
                ("channel".into(), "channel_pc_web".into()),
                ("count".into(), "3".into()),
                ("msToken".into(), generate_ms_token()),
            ];
            let feed = site
                .get_signed_json(
                    "https://www.douyin.com/aweme/v1/web/tab/feed/",
                    &params,
                    VIDEO_REFERER,
                )
                .await
                .unwrap();
            feed["aweme_list"]
                .as_array()
                .and_then(|items| items.iter().find_map(|item| item["aweme_id"].as_str()))
                .expect("公开 feed 没有视频样本")
                .to_string()
        };
        let (item, url) = site.video_detail(&id).await.unwrap();
        let response = crate::http_client::default_client()
            .get(url)
            .header("referer", VIDEO_REFERER)
            .header("user-agent", DEFAULT_USER_AGENT)
            .header("range", "bytes=0-1023")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::PARTIAL_CONTENT);
        assert!(
            response
                .headers()
                .get("content-type")
                .unwrap()
                .to_str()
                .unwrap()
                .contains("video")
        );
        println!("公开作品 {}：H264 元数据与 CDN Range 验证通过", item.id);
    }
}
