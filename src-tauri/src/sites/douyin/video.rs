//! 实验性抖音公开作品；不经过直播 LiveSite trait。
use super::{DEFAULT_USER_AGENT, DouyinSite, generate_ms_token};
use crate::error::{AppError, AppResult};
use crate::models::douyin_video::DouyinVideoItem;
use reqwest::{Client, Url};
use serde_json::Value;

pub const VIDEO_REFERER: &str = "https://www.douyin.com/";
const DETAIL_URL: &str = "https://www.douyin.com/aweme/v1/web/aweme/detail/";

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
    let detail = &value["aweme_detail"];
    let returned_id = detail["aweme_id"]
        .as_str()
        .map(str::to_string)
        .or_else(|| detail["aweme_id"].as_u64().map(|v| v.to_string()));
    if returned_id.as_deref() != Some(id) {
        return Err(invalid("作品不存在、不可见或返回了不同的作品"));
    }
    if detail["images"]
        .as_array()
        .is_some_and(|images| !images.is_empty())
        || detail["aweme_type"].as_i64() == Some(101)
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

impl DouyinSite {
    pub async fn video_detail(&self, id: &str) -> AppResult<(DouyinVideoItem, String)> {
        if !valid_id(id) {
            return Err(invalid("作品 ID 无效"));
        }
        self.ensure_web_session().await?;
        let params: Vec<(String, String)> = [
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
            ("aweme_id", id),
        ]
        .into_iter()
        .map(|(k, v)| (k.into(), v.into()))
        .chain([("msToken".into(), generate_ms_token())])
        .collect();
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
