//! AcFun 视频与文章浏览、取流。
//!
//! AcFun 没有为 PC 站提供一套统一的 VOD 客户端协议：列表和搜索是公开 JSON，
//! 详情与播放清单则嵌在服务端渲染页面中。本模块把这些差异留在 Rust 边界内，
//! 命令层只面向稳定的 IPC 模型。

use std::collections::{HashMap, HashSet};

use reqwest::{Client, StatusCode};
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::models::acfun::{
    AcfunArticleBlock, AcfunArticleChannel, AcfunArticleDetail, AcfunArticleInline,
    AcfunArticleItem, AcfunArticleListPage, AcfunCommentPage, AcfunCommentReplyPage,
    AcfunCommentSort, AcfunVideoComment, AcfunVideoDetail, AcfunVideoItem, AcfunVideoListPage,
    AcfunVideoPart, AcfunVideoQuality, AcfunVideoSection,
};
use crate::sites::json::{json_i64, json_i64_opt, json_str};

pub(crate) const CONTENT_REFERER: &str = "https://www.acfun.cn/";
pub(crate) const CONTENT_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const ORIGIN: &str = "https://www.acfun.cn";
const VIDEO_PAGE_SIZE: usize = 30;
const ARTICLE_PAGE_SIZE: usize = 10;

const VIDEO_SECTIONS: &[(&str, &str)] = &[
    ("1", "动画"),
    ("60", "娱乐"),
    ("201", "生活"),
    ("58", "音乐"),
    ("123", "舞蹈与偶像"),
    ("59", "游戏"),
    ("70", "科技"),
    ("68", "影视"),
    ("69", "体育"),
    ("125", "鱼塘"),
];

#[derive(Debug, Clone)]
pub(crate) struct AcfunPlaySource {
    pub url: String,
    pub quality: String,
    pub quality_label: String,
    pub qualities: Vec<AcfunVideoQuality>,
}

pub(crate) struct AcfunContentClient {
    client: Client,
}

impl AcfunContentClient {
    pub(crate) fn new(client: Client) -> Self {
        Self { client }
    }

    fn error(code: &str, message: impl Into<String>) -> AppError {
        AppError::new(code, message).with_site("acfun")
    }

    fn network_error(what: &str, error: reqwest::Error) -> AppError {
        Self::error(
            "acfun_content_network_error",
            format!(
                "{what}请求失败：{}",
                crate::http_client::describe_request_error(&error)
            ),
        )
        .retryable()
    }

    fn check_status(status: StatusCode, what: &str) -> AppResult<()> {
        if status == StatusCode::TOO_MANY_REQUESTS {
            return Err(Self::error(
                "acfun_content_rate_limited",
                format!("{what}请求过于频繁，请稍后再试"),
            )
            .retryable());
        }
        if status.is_server_error() {
            return Err(Self::error(
                "acfun_content_network_error",
                format!("{what}返回 HTTP {}", status.as_u16()),
            )
            .retryable());
        }
        if status == StatusCode::NOT_FOUND {
            return Err(Self::error(
                "acfun_content_not_found",
                format!("{what}不存在或已下架"),
            ));
        }
        if !status.is_success() {
            return Err(Self::error(
                "acfun_content_api_error",
                format!("{what}返回 HTTP {}", status.as_u16()),
            ));
        }
        Ok(())
    }

    async fn get_json(&self, url: reqwest::Url, what: &str) -> AppResult<Value> {
        let response = self
            .client
            .get(url)
            .header("user-agent", CONTENT_USER_AGENT)
            .header("referer", CONTENT_REFERER)
            .send()
            .await
            .map_err(|error| Self::network_error(what, error))?;
        Self::check_status(response.status(), what)?;
        response.json().await.map_err(|_| {
            Self::error(
                "acfun_content_api_error",
                format!("{what}返回无法识别的数据"),
            )
        })
    }

    async fn post_form(&self, path: &str, form: &[(&str, String)], what: &str) -> AppResult<Value> {
        let response = self
            .client
            .post(format!("{ORIGIN}{path}"))
            .header("user-agent", CONTENT_USER_AGENT)
            .header("referer", CONTENT_REFERER)
            .form(form)
            .send()
            .await
            .map_err(|error| Self::network_error(what, error))?;
        Self::check_status(response.status(), what)?;
        response.json().await.map_err(|_| {
            Self::error(
                "acfun_content_api_error",
                format!("{what}返回无法识别的数据"),
            )
        })
    }

    async fn get_text(&self, url: reqwest::Url, what: &str) -> AppResult<String> {
        let response = self
            .client
            .get(url)
            .header("user-agent", CONTENT_USER_AGENT)
            .header("referer", CONTENT_REFERER)
            .send()
            .await
            .map_err(|error| Self::network_error(what, error))?;
        Self::check_status(response.status(), what)?;
        response
            .text()
            .await
            .map_err(|error| Self::network_error(what, error))
    }

    pub(crate) async fn video_recommend(
        &self,
        page: u32,
        page_size: Option<u32>,
    ) -> AppResult<AcfunVideoListPage> {
        let value = self
            .post_form(
                "/rest/pc-direct/rank/channel",
                &[
                    ("rankPeriod", "DAY".to_string()),
                    ("rankLimit", "100".to_string()),
                ],
                "全站热门视频",
            )
            .await?;
        api_result(&value, "全站热门视频")?;
        let all = parse_required_items(
            required_array(&value, "rankList", "AcFun 全站热门视频")?,
            "AcFun 全站热门视频",
            video_item_from_feed,
        )?;
        let page = page.max(1);
        let page_size = page_size.unwrap_or(20).clamp(1, 50) as usize;
        let start = (page.saturating_sub(1) as usize)
            .saturating_mul(page_size)
            .min(all.len());
        let end = start.saturating_add(page_size).min(all.len());
        let items = all[start..end].to_vec();
        let has_more = end < all.len();
        Ok(AcfunVideoListPage {
            items,
            has_more,
            next_page: has_more.then_some(page.saturating_add(1)),
        })
    }

    pub(crate) async fn video_section(
        &self,
        section_id: &str,
        page: u32,
    ) -> AppResult<AcfunVideoListPage> {
        let section_id = section_id.trim();
        if section_id.is_empty() || !section_id.bytes().all(|b| b.is_ascii_digit()) {
            return Err(Self::error(
                "acfun_video_section_invalid",
                "AcFun 视频分区无效",
            ));
        }
        let page = page.max(1);
        let value = self
            .post_form(
                "/rest/pc-direct/channel/resource/query/match",
                &[
                    ("sortField", "createTime".to_string()),
                    ("channelId", section_id.to_string()),
                    ("page", page.to_string()),
                ],
                "视频列表",
            )
            .await?;
        api_result(&value, "视频列表")?;
        let feed = required_array(&value, "feed", "AcFun 视频列表")?;
        let total = required_total(&value, "total", "AcFun 视频列表")?;
        let items = parse_required_items(feed, "AcFun 视频列表", video_item_from_feed)?;
        let has_more = total_has_more(page, VIDEO_PAGE_SIZE, total, items.len());
        Ok(AcfunVideoListPage {
            items,
            has_more,
            next_page: has_more.then_some(page.saturating_add(1)),
        })
    }

    pub(crate) async fn video_search(
        &self,
        keyword: &str,
        page: u32,
    ) -> AppResult<AcfunVideoListPage> {
        let keyword = keyword.trim();
        if keyword.is_empty() {
            return Ok(empty_video_page(page));
        }
        let page = page.max(1);
        let cursor = page.to_string();
        let url = reqwest::Url::parse_with_params(
            &format!("{ORIGIN}/rest/pc-direct/search/video"),
            [("keyword", keyword), ("pCursor", cursor.as_str())],
        )
        .map_err(|_| Self::error("acfun_search_invalid", "AcFun 搜索参数无效"))?;
        let value = self.get_json(url, "视频搜索").await?;
        api_result(&value, "视频搜索")?;
        let items = parse_required_items(
            required_array(&value, "videoList", "AcFun 视频搜索")?,
            "AcFun 视频搜索",
            video_item_from_search,
        )?;
        required_total(&value, "totalNum", "AcFun 视频搜索")?;
        let page_count = required_total(&value, "pageNum", "AcFun 视频搜索")?;
        let has_more = indexed_page_has_more(page, page_count, items.len());
        Ok(AcfunVideoListPage {
            items,
            has_more,
            next_page: has_more.then_some(page.saturating_add(1)),
        })
    }

    async fn video_page(&self, video_id: &str, part_index: Option<u32>) -> AppResult<Value> {
        let video_id = normalize_content_id(video_id, "ac")?;
        let suffix = part_index
            .filter(|index| *index > 1)
            .map(|index| format!("_{index}"))
            .unwrap_or_default();
        let url = reqwest::Url::parse(&format!("{ORIGIN}/v/ac{video_id}{suffix}"))
            .map_err(|_| Self::error("acfun_video_id_invalid", "AcFun 视频标识无效"))?;
        let html = self.get_text(url, "视频详情").await?;
        extract_js_object(&html, "window.videoInfo =")
            .ok_or_else(|| Self::error("acfun_content_parse_error", "AcFun 视频详情缺少播放器数据"))
    }

    pub(crate) async fn video_detail(&self, video_id: &str) -> AppResult<AcfunVideoDetail> {
        let value = self.video_page(video_id, None).await?;
        let item = video_item_from_detail(&value).ok_or_else(|| {
            Self::error("acfun_content_parse_error", "AcFun 视频详情缺少稿件信息")
        })?;
        let parts = required_array(&value, "videoList", "AcFun 视频详情")?
            .iter()
            .enumerate()
            .map(|(offset, part)| {
                let id = part
                    .get("id")
                    .map(json_str)
                    .filter(|id| !id.trim().is_empty())
                    .ok_or_else(|| parse_error("AcFun 视频详情缺少分 P 标识"))?;
                Ok(AcfunVideoPart {
                    id,
                    index: u32::try_from(offset + 1)
                        .map_err(|_| parse_error("AcFun 视频分 P 序号超出范围"))?,
                    title: clean_title(
                        part.get("fileName")
                            .map(json_str)
                            .filter(|title| !title.trim().is_empty())
                            .unwrap_or_else(|| part.get("title").map(json_str).unwrap_or_default())
                            .as_str(),
                    ),
                    duration_sec: duration_millis_to_seconds(json_i64(
                        part.get("durationMillis").unwrap_or(&Value::Null),
                    )),
                    cover: (!item.cover.is_empty()).then(|| item.cover.clone()),
                })
            })
            .collect::<AppResult<Vec<_>>>()?;
        Ok(AcfunVideoDetail {
            item,
            description: value
                .get("description")
                .map(json_str)
                .map(|text| strip_html_text(&text))
                .unwrap_or_default(),
            // AcFun 视频详情页没有稳定公开的标签列表；不从简介猜测。
            tags: Vec::new(),
            parts,
        })
    }

    pub(crate) async fn video_play_source(
        &self,
        video_id: &str,
        part_id: Option<&str>,
        quality: Option<&str>,
    ) -> AppResult<AcfunPlaySource> {
        let mut value = self.video_page(video_id, None).await?;
        let requested_part = part_id.map(str::trim).filter(|part| !part.is_empty());
        let current_id = value
            .get("currentVideoId")
            .map(json_str)
            .unwrap_or_default();
        if let Some(part_id) = requested_part.filter(|part| *part != current_id) {
            let index = value
                .get("videoList")
                .and_then(Value::as_array)
                .and_then(|parts| {
                    parts
                        .iter()
                        .position(|part| part.get("id").map(json_str).as_deref() == Some(part_id))
                })
                .and_then(|index| u32::try_from(index + 1).ok())
                .ok_or_else(|| {
                    Self::error("acfun_video_part_invalid", "AcFun 视频分 P 不属于当前稿件")
                })?;
            value = self.video_page(video_id, Some(index)).await?;
        }

        let play_json = value
            .get("currentVideoInfo")
            .and_then(|info| info.get("ksPlayJson"))
            .map(json_str)
            .ok_or_else(|| {
                Self::error("acfun_content_parse_error", "AcFun 视频详情缺少播放清单")
            })?;
        parse_play_source(&play_json, quality)
    }

    pub(crate) async fn video_comments(
        &self,
        video_id: &str,
        page: u32,
        sort: AcfunCommentSort,
    ) -> AppResult<AcfunCommentPage> {
        let video_id = normalize_content_id(video_id, "ac")?;
        let page = page.max(1);
        let page_text = page.to_string();
        let query = [
            ("sourceId", video_id.as_str()),
            ("sourceType", "3"),
            ("page", page_text.as_str()),
            ("pivotCommentId", "0"),
            ("newPivotCommentId", ""),
            ("responseFallbackEnabled", "true"),
        ];
        let url = reqwest::Url::parse_with_params(
            &format!("{ORIGIN}/rest/pc-direct/comment/list"),
            query,
        )
        .map_err(|_| Self::error("acfun_comment_invalid", "AcFun 评论参数无效"))?;
        let value = self.get_json(url, "视频评论").await?;
        api_result(&value, "视频评论")?;
        parse_video_comment_page(&value, sort)
    }

    pub(crate) async fn video_comment_replies(
        &self,
        video_id: &str,
        comment_id: &str,
        cursor: Option<&str>,
    ) -> AppResult<AcfunCommentReplyPage> {
        let video_id = normalize_content_id(video_id, "ac")?;
        let comment_id = comment_id.trim();
        if comment_id.is_empty() || !comment_id.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(Self::error(
                "acfun_comment_id_invalid",
                "AcFun 评论标识无效",
            ));
        }
        // 回复展开后由详情视图独立展示完整列表，因此首次 cursor 为空时读取
        // 上游第一页；后续 cursor 仍是 1-based 上游页码。
        let page = cursor
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| {
                value
                    .parse::<u32>()
                    .map_err(|_| Self::error("acfun_comment_cursor_invalid", "AcFun 回复页码无效"))
            })
            .transpose()?
            .unwrap_or(1)
            .max(1);
        let page_text = page.to_string();
        let query = [
            ("sourceId", video_id.as_str()),
            ("sourceType", "3"),
            ("rootCommentId", comment_id),
            ("page", page_text.as_str()),
        ];
        let url = reqwest::Url::parse_with_params(
            &format!("{ORIGIN}/rest/pc-direct/comment/sublist"),
            query,
        )
        .map_err(|_| Self::error("acfun_comment_invalid", "AcFun 回复参数无效"))?;
        let value = self.get_json(url, "评论回复").await?;
        api_result(&value, "评论回复")?;
        parse_comment_reply_page(&value, comment_id)
    }

    pub(crate) async fn article_channels(&self) -> AppResult<Vec<AcfunArticleChannel>> {
        let url = reqwest::Url::parse(&format!("{ORIGIN}/rest/pc-direct/realm/query/navigation"))
            .map_err(|_| Self::error("acfun_content_api_error", "AcFun 文章分区地址无效"))?;
        let value = self.get_json(url, "文章分区").await?;
        api_result(&value, "文章分区")?;
        article_channels_from_navigation(&value)
    }

    pub(crate) async fn article_feed(
        &self,
        channel_id: Option<&str>,
        cursor: Option<&str>,
    ) -> AppResult<AcfunArticleListPage> {
        let cursor = cursor
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("first_page");
        let mut form = vec![
            ("cursor", cursor.to_string()),
            ("onlyOriginal", "false".to_string()),
            ("limit", ARTICLE_PAGE_SIZE.to_string()),
            ("sortType", "createTime".to_string()),
            ("timeRange", "all".to_string()),
        ];
        if let Some(channel_id) = channel_id.map(str::trim).filter(|value| !value.is_empty()) {
            if !channel_id.bytes().all(|b| b.is_ascii_digit()) {
                return Err(Self::error(
                    "acfun_article_channel_invalid",
                    "AcFun 文章分区无效",
                ));
            }
            form.push(("realmId", channel_id.to_string()));
        }
        let value = self
            .post_form("/rest/pc-direct/article/feed", &form, "文章列表")
            .await?;
        api_result(&value, "文章列表")?;
        let items = parse_required_items(
            required_array(&value, "data", "AcFun 文章列表")?,
            "AcFun 文章列表",
            article_item_from_feed,
        )?;
        let next_cursor = article_next_cursor(&value, cursor, "AcFun 文章列表")?;
        Ok(AcfunArticleListPage {
            has_more: next_cursor.is_some(),
            items,
            next_cursor,
        })
    }

    pub(crate) async fn article_search(
        &self,
        keyword: &str,
        page: u32,
    ) -> AppResult<AcfunArticleListPage> {
        let keyword = keyword.trim();
        if keyword.is_empty() {
            return Ok(AcfunArticleListPage {
                items: Vec::new(),
                has_more: false,
                next_cursor: None,
            });
        }
        let page = page.max(1);
        let cursor = page.to_string();
        let url = reqwest::Url::parse_with_params(
            &format!("{ORIGIN}/rest/pc-direct/search/article"),
            [("keyword", keyword), ("pCursor", cursor.as_str())],
        )
        .map_err(|_| Self::error("acfun_search_invalid", "AcFun 搜索参数无效"))?;
        let value = self.get_json(url, "文章搜索").await?;
        api_result(&value, "文章搜索")?;
        let items = parse_required_items(
            required_array(&value, "articleList", "AcFun 文章搜索")?,
            "AcFun 文章搜索",
            article_item_from_search,
        )?;
        required_total(&value, "totalNum", "AcFun 文章搜索")?;
        let page_count = required_total(&value, "pageNum", "AcFun 文章搜索")?;
        let has_more = indexed_page_has_more(page, page_count, items.len());
        Ok(AcfunArticleListPage {
            items,
            has_more,
            // 搜索 API 的分页不是 feed 的稳定游标；下一页仍按输入页号计算。
            next_cursor: has_more.then(|| (page + 1).to_string()),
        })
    }

    pub(crate) async fn article_detail(&self, article_id: &str) -> AppResult<AcfunArticleDetail> {
        let article_id = normalize_content_id(article_id, "ac")?;
        let url = reqwest::Url::parse(&format!("{ORIGIN}/a/ac{article_id}"))
            .map_err(|_| Self::error("acfun_article_id_invalid", "AcFun 文章标识无效"))?;
        let html = self.get_text(url, "文章详情").await?;
        let value = extract_js_object(&html, "window.articleInfo =").ok_or_else(|| {
            Self::error("acfun_content_parse_error", "AcFun 文章详情缺少正文数据")
        })?;
        let item = article_item_from_detail(&value).ok_or_else(|| {
            Self::error("acfun_content_parse_error", "AcFun 文章详情缺少文章信息")
        })?;
        let mut blocks = Vec::new();
        for part in required_array(&value, "parts", "AcFun 文章详情")? {
            let content = part
                .get("content")
                .map(json_str)
                .ok_or_else(|| parse_error("AcFun 文章详情缺少正文内容"))?;
            blocks.extend(parse_article_blocks(&content));
        }
        Ok(AcfunArticleDetail {
            item,
            tags: article_tags(&value),
            blocks,
        })
    }
}

pub(crate) fn video_sections_static() -> Vec<AcfunVideoSection> {
    VIDEO_SECTIONS
        .iter()
        .map(|(id, name)| AcfunVideoSection {
            id: (*id).to_string(),
            name: (*name).to_string(),
        })
        .collect()
}

fn api_result(value: &Value, what: &str) -> AppResult<()> {
    let Some(result) = value.get("result").and_then(json_i64_opt) else {
        return Err(parse_error(format!("{what}缺少 result")));
    };
    if result == 0 {
        Ok(())
    } else {
        let message = value
            .get("error_msg")
            .or_else(|| value.get("message"))
            .map(json_str)
            .filter(|message| !message.is_empty())
            .unwrap_or_else(|| format!("{what}请求失败"));
        Err(AcfunContentClient::error(
            "acfun_content_api_error",
            message,
        ))
    }
}

fn required_array<'a>(value: &'a Value, field: &str, what: &str) -> AppResult<&'a [Value]> {
    value
        .get(field)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| parse_error(format!("{what}缺少 {field} 数组")))
}

fn article_channels_from_navigation(value: &Value) -> AppResult<Vec<AcfunArticleChannel>> {
    let groups = required_array(value, "data", "AcFun 文章分区")?;
    let mut channels = Vec::new();
    let mut seen = HashSet::new();
    for group in groups {
        let realms = required_array(group, "realms", "AcFun 文章分区")?;
        for realm in realms {
            let id = realm
                .get("realmId")
                .map(json_str)
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| parse_error("AcFun 文章分区缺少分区标识"))?;
            let name = realm
                .get("realmName")
                .map(json_str)
                .filter(|name| !name.trim().is_empty())
                .ok_or_else(|| parse_error("AcFun 文章分区缺少分区名称"))?;
            if seen.insert(id.clone()) {
                channels.push(AcfunArticleChannel {
                    id,
                    name: clean_title(&name),
                });
            }
        }
    }
    Ok(channels)
}

fn parse_required_items<T>(
    values: &[Value],
    what: &str,
    parse: impl Fn(&Value) -> Option<T>,
) -> AppResult<Vec<T>> {
    values
        .iter()
        .map(|value| parse(value).ok_or_else(|| parse_error(format!("{what}包含无法识别的条目"))))
        .collect()
}

fn required_total(value: &Value, field: &str, what: &str) -> AppResult<u64> {
    value
        .get(field)
        .and_then(json_i64_opt)
        .filter(|total| *total >= 0)
        .and_then(|total| u64::try_from(total).ok())
        .ok_or_else(|| parse_error(format!("{what}缺少 {field} 总数")))
}

fn required_page(value: &Value, field: &str, minimum: u32, what: &str) -> AppResult<u32> {
    value
        .get(field)
        .and_then(json_i64_opt)
        .and_then(|page| u32::try_from(page).ok())
        .filter(|page| *page >= minimum)
        .ok_or_else(|| {
            parse_error(format!(
                "{what}缺少有效的 {field} 分页字段（最小值为 {minimum}）"
            ))
        })
}

fn article_next_cursor(
    value: &Value,
    requested_cursor: &str,
    what: &str,
) -> AppResult<Option<String>> {
    let cursor = value
        .get("cursor")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|cursor| !cursor.is_empty())
        .ok_or_else(|| parse_error(format!("{what}缺少 cursor")))?;
    if cursor == "no_more" || cursor == requested_cursor {
        return Ok(None);
    }
    Ok(Some(cursor.to_string()))
}

fn total_has_more(page: u32, page_size: usize, total: u64, item_count: usize) -> bool {
    item_count > 0 && u64::from(page).saturating_mul(page_size as u64) < total
}

fn indexed_page_has_more(page: u32, page_count: u64, item_count: usize) -> bool {
    item_count > 0 && u64::from(page) < page_count
}

fn parse_error(message: impl Into<String>) -> AppError {
    AcfunContentClient::error("acfun_content_parse_error", message)
}

fn empty_video_page(_page: u32) -> AcfunVideoListPage {
    AcfunVideoListPage {
        items: Vec::new(),
        has_more: false,
        next_page: None,
    }
}

fn normalize_content_id(raw: &str, prefix: &str) -> AppResult<String> {
    let id = raw
        .trim()
        .strip_prefix(prefix)
        .unwrap_or_else(|| raw.trim());
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
        return Err(AcfunContentClient::error(
            "acfun_content_id_invalid",
            "AcFun 内容标识无效",
        ));
    }
    Ok(id.to_string())
}

fn clean_title(raw: &str) -> String {
    strip_html_text(raw).trim().to_string()
}

fn millis_to_seconds(value: i64) -> u64 {
    if value <= 0 {
        0
    } else if value >= 10_000_000_000 {
        (value / 1_000) as u64
    } else {
        value as u64
    }
}

fn duration_millis_to_seconds(value: i64) -> u64 {
    if value <= 0 {
        0
    } else {
        (value / 1_000) as u64
    }
}

fn nonnegative(value: i64) -> u64 {
    value.max(0) as u64
}

fn safe_media_url(raw: &str) -> Option<String> {
    let raw = decode_html_entities(raw.trim());
    let raw = if raw.starts_with("//") {
        format!("https:{raw}")
    } else if raw.starts_with('/') {
        format!("{ORIGIN}{raw}")
    } else {
        raw
    };
    let mut url = reqwest::Url::parse(&raw).ok()?;
    match url.scheme() {
        "http" => {
            url.set_scheme("https").ok()?;
        }
        "https" => {}
        _ => return None,
    }
    url.set_username("").ok()?;
    url.set_password(None).ok()?;
    Some(url.to_string())
}

fn parse_video_comment_page(value: &Value, sort: AcfunCommentSort) -> AppResult<AcfunCommentPage> {
    let total = required_total(value, "commentCount", "AcFun 视频评论")?;
    let current_page = required_page(value, "curPage", 1, "AcFun 视频评论")?;
    let total_page = required_page(value, "totalPage", 0, "AcFun 视频评论")?;
    required_page(value, "pageSize", 1, "AcFun 视频评论")?;
    let roots = required_array(value, "rootComments", "AcFun 视频评论")?;
    let hot = required_array(value, "hotComments", "AcFun 视频评论")?;
    let sub_comments = value
        .get("subCommentsMap")
        .and_then(Value::as_object)
        .ok_or_else(|| parse_error("AcFun 视频评论缺少 subCommentsMap 对象"))?;
    if total_page == 0 && (!roots.is_empty() || !hot.is_empty()) {
        return Err(parse_error("AcFun 视频评论分页元数据与列表不一致"));
    }

    let sources: Vec<&Value> = if sort == AcfunCommentSort::Hot && current_page == 1 {
        hot.iter().chain(roots.iter()).collect()
    } else {
        roots.iter().collect()
    };

    let mut seen = HashSet::new();
    let mut items = Vec::new();
    for source in sources {
        let Some(id) = source
            .get("commentId")
            .map(json_str)
            .filter(|id| !id.is_empty())
        else {
            return Err(parse_error("AcFun 视频评论缺少 commentId"));
        };
        if !seen.insert(id.clone()) {
            continue;
        }
        let previews = sub_comments
            .get(&id)
            .map(|entry| {
                entry
                    .get("subComments")
                    .and_then(Value::as_array)
                    .map(Vec::as_slice)
                    .ok_or_else(|| parse_error("AcFun 评论回复预览缺少 subComments 数组"))
            })
            .transpose()?;
        let replies = previews
            .map(|values| {
                values
                    .iter()
                    .take(3)
                    .map(|reply| parse_video_comment(reply, Some(&id), Vec::new()))
                    .collect::<AppResult<Vec<_>>>()
            })
            .transpose()?
            .unwrap_or_default();
        items.push(parse_video_comment(source, None, replies)?);
    }

    let has_more = current_page < total_page;
    Ok(AcfunCommentPage {
        items,
        has_more,
        next_page: has_more.then_some(current_page.saturating_add(1)),
        total,
    })
}

fn parse_comment_reply_page(
    value: &Value,
    root_comment_id: &str,
) -> AppResult<AcfunCommentReplyPage> {
    let items = required_array(value, "subComments", "AcFun 评论回复")?
        .iter()
        .map(|comment| parse_video_comment(comment, Some(root_comment_id), Vec::new()))
        .collect::<AppResult<Vec<_>>>()?;
    let total = required_total(value, "subCommentCount", "AcFun 评论回复")?;
    let current_page = required_page(value, "curPage", 1, "AcFun 评论回复")?;
    let total_page = required_page(value, "totalPage", 0, "AcFun 评论回复")?;
    required_page(value, "pageSize", 1, "AcFun 评论回复")?;
    if total == 0 && !items.is_empty() {
        return Err(parse_error("AcFun 评论回复数量与列表不一致"));
    }
    let has_more = current_page < total_page;
    Ok(AcfunCommentReplyPage {
        items,
        has_more,
        next_cursor: has_more.then(|| current_page.saturating_add(1).to_string()),
        total,
    })
}

fn parse_video_comment(
    value: &Value,
    parent_id: Option<&str>,
    replies: Vec<AcfunVideoComment>,
) -> AppResult<AcfunVideoComment> {
    let id = value
        .get("commentId")
        .map(json_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| parse_error("AcFun 评论缺少 commentId"))?;
    let raw_content = value.get("content").map(json_str).unwrap_or_default();
    let pictures = comment_picture_urls(&raw_content, value);
    let content = clean_comment_content(&raw_content);
    let avatar = ["avatarImage", "thumbnailImageCdnUrl"]
        .iter()
        .find_map(|field| {
            value
                .get(*field)
                .map(json_str)
                .and_then(|url| safe_media_url(&url))
        })
        .or_else(|| {
            value
                .get("headUrl")
                .and_then(Value::as_array)
                .and_then(|urls| urls.first())
                .and_then(|head| head.get("url"))
                .map(json_str)
                .and_then(|url| safe_media_url(&url))
        });
    Ok(AcfunVideoComment {
        id,
        parent_id: parent_id.map(str::to_string),
        author: value
            .get("userName")
            .map(json_str)
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "匿名用户".to_string()),
        author_id: value
            .get("userId")
            .map(json_str)
            .filter(|id| !id.is_empty() && id != "0"),
        avatar,
        content,
        created_at: millis_to_seconds(
            value
                .get("timestamp")
                .and_then(json_i64_opt)
                .unwrap_or_default(),
        ),
        like_count: value
            .get("likeCount")
            .and_then(json_i64_opt)
            .map(nonnegative)
            .unwrap_or_default(),
        is_uploader: value.get("isUp").and_then(Value::as_bool).unwrap_or(false),
        pictures,
        reply_to_name: value
            .get("replyToUserName")
            .map(json_str)
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty()),
        replies,
        reply_count: value
            .get("subCommentCount")
            .and_then(json_i64_opt)
            .map(nonnegative)
            .unwrap_or_default(),
    })
}

fn comment_picture_urls(raw_content: &str, value: &Value) -> Vec<String> {
    let ubb_image =
        regex::Regex::new(r"(?is)\[img(?:=[^\]]*)?\](.*?)\[/img\]").expect("valid AcFun UBB image");
    let html_image = regex::Regex::new(r#"(?is)<img[^>]+src\s*=\s*["']([^"']+)["'][^>]*>"#)
        .expect("valid AcFun HTML image");
    let mut seen = HashSet::new();
    ubb_image
        .captures_iter(raw_content)
        .chain(html_image.captures_iter(raw_content))
        .filter_map(|capture| capture.get(1).map(|capture| capture.as_str()))
        .map(decode_html_entities)
        .filter_map(|url| safe_media_url(&url))
        .chain(
            value
                .get("imageUrl")
                .map(json_str)
                .filter(|url| !url.trim().is_empty())
                .and_then(|url| safe_media_url(&url)),
        )
        .filter(|url| seen.insert(url.clone()))
        .collect()
}

fn clean_comment_content(raw: &str) -> String {
    let without_images = regex::Regex::new(r"(?is)\[img(?:=[^\]]*)?\].*?\[/img\]")
        .expect("valid AcFun UBB image")
        .replace_all(raw, "");
    let emotes = regex::Regex::new(r"(?i)\[emot=[^\]]+\]")
        .expect("valid AcFun emote")
        .replace_all(&without_images, "[表情]");
    let breaks = regex::Regex::new(r"(?i)\[br\s*/?\]")
        .expect("valid AcFun line break")
        .replace_all(&emotes, "\n");
    let formatting = regex::Regex::new(
        r"(?i)\[/?(?:b|i|u|s|center|left|right|quote|code|color(?:=[^\]]*)?|size(?:=[^\]]*)?|font(?:=[^\]]*)?|url(?:=[^\]]*)?)\]",
    )
    .expect("valid AcFun UBB formatting")
    .replace_all(&breaks, "");
    comment_html_to_text(&formatting)
}

fn comment_html_to_text(raw: &str) -> String {
    let hidden = regex::Regex::new(r"(?is)<(?:script|style)[^>]*>.*?</(?:script|style)\s*>")
        .expect("valid hidden HTML element")
        .replace_all(raw, "");
    let block_breaks = regex::Regex::new(r"(?is)<(?:br|/p|/div|/li|/blockquote|/pre)\s*/?>")
        .expect("valid HTML line break")
        .replace_all(&hidden, "\n");
    let tags = regex::Regex::new(r"(?is)<[^>]+>")
        .expect("valid HTML tag")
        .replace_all(&block_breaks, "");
    normalize_flow_text(&decode_html_entities(&tags))
}

fn cover_url(value: &Value) -> Option<String> {
    value
        .get("coverUrl")
        .map(json_str)
        .and_then(|url| safe_media_url(&url))
        .or_else(|| {
            value
                .get("coverImgInfo")
                .and_then(|image| {
                    image
                        .get("thumbnailImage")
                        .or_else(|| image.get("smallSharedImage"))
                })
                .and_then(|image| image.get("cdnUrls"))
                .and_then(Value::as_array)
                .and_then(|urls| urls.first())
                .and_then(|url| url.get("url"))
                .map(json_str)
                .and_then(|url| safe_media_url(&url))
        })
}

fn user_fields(user: Option<&Value>) -> (String, Option<String>, Option<String>) {
    let Some(user) = user else {
        return (String::new(), None, None);
    };
    let name = user
        .get("name")
        .or_else(|| user.get("userName"))
        .map(json_str)
        .unwrap_or_default();
    let id = user
        .get("id")
        .or_else(|| user.get("href"))
        .or_else(|| user.get("userId"))
        .map(json_str)
        .filter(|value| !value.is_empty() && value != "0");
    let avatar = user
        .get("headUrl")
        .or_else(|| user.get("avatarImage"))
        .or_else(|| user.get("userImg"))
        .map(json_str)
        .and_then(|url| safe_media_url(&url));
    (name, id, avatar)
}

fn video_item_from_feed(value: &Value) -> Option<AcfunVideoItem> {
    let id = value
        .get("dougaId")
        .or_else(|| value.get("videoId"))
        .map(json_str)?
        .trim()
        .to_string();
    if id.is_empty() {
        return None;
    }
    let (author, author_id, author_avatar) = user_fields(value.get("user"));
    let channel = value.get("channel");
    Some(AcfunVideoItem {
        id,
        title: clean_title(&value.get("title").map(json_str).unwrap_or_default()),
        cover: cover_url(value).unwrap_or_default(),
        author,
        author_id,
        author_avatar,
        duration_sec: duration_millis_to_seconds(
            value.get("durationMillis").map(json_i64).unwrap_or(0),
        ),
        play_count: nonnegative(value.get("viewCount").map(json_i64).unwrap_or(0)),
        danmaku_count: nonnegative(value.get("danmakuCount").map(json_i64).unwrap_or(0)),
        comment_count: value.get("commentCount").map(json_i64).map(nonnegative),
        published_at: millis_to_seconds(value.get("createTimeMillis").map(json_i64).unwrap_or(0)),
        channel_id: channel
            .map(|channel| channel.get("id").map(json_str))
            .flatten(),
        channel_name: channel
            .map(|channel| channel.get("name").map(json_str))
            .flatten(),
    })
}

fn video_item_from_search(value: &Value) -> Option<AcfunVideoItem> {
    let id = value
        .get("contentId")
        .or_else(|| value.get("id"))
        // 旧响应没有内容 ID 时才回退到内部分 P ID；`videoId` 不是
        // `/v/ac{id}`、详情或评论接口的 `sourceId`。
        .or_else(|| value.get("videoId"))
        .map(json_str)?
        .trim()
        .to_string();
    if id.is_empty() {
        return None;
    }
    let channel_id = value
        .get("channelId")
        .map(json_str)
        .filter(|value| !value.is_empty() && value != "0");
    Some(AcfunVideoItem {
        id,
        title: clean_title(
            value
                .get("title")
                .or_else(|| value.get("emTitle"))
                .map(json_str)
                .as_deref()
                .unwrap_or_default(),
        ),
        cover: value
            .get("coverUrl")
            .map(json_str)
            .and_then(|url| safe_media_url(&url))
            .unwrap_or_default(),
        author: value.get("userName").map(json_str).unwrap_or_default(),
        author_id: value
            .get("userId")
            .map(json_str)
            .filter(|value| !value.is_empty() && value != "0"),
        author_avatar: value
            .get("userImg")
            .map(json_str)
            .and_then(|url| safe_media_url(&url)),
        duration_sec: parse_duration(
            value
                .get("playDuration")
                .map(json_str)
                .as_deref()
                .unwrap_or_default(),
        ),
        play_count: nonnegative(value.get("viewCount").map(json_i64).unwrap_or(0)),
        danmaku_count: nonnegative(value.get("danmuCount").map(json_i64).unwrap_or(0)),
        comment_count: value.get("commentCount").map(json_i64).map(nonnegative),
        published_at: millis_to_seconds(value.get("ctime").map(json_i64).unwrap_or(0)),
        channel_id,
        channel_name: None,
    })
}

fn video_item_from_detail(value: &Value) -> Option<AcfunVideoItem> {
    let id = value
        .get("dougaId")
        .or_else(|| value.get("contentId"))
        .map(json_str)?
        .trim()
        .to_string();
    if id.is_empty() {
        return None;
    }
    let (author, author_id, author_avatar) = user_fields(value.get("user"));
    let channel = value.get("channel");
    Some(AcfunVideoItem {
        id,
        title: clean_title(&value.get("title").map(json_str).unwrap_or_default()),
        cover: cover_url(value).unwrap_or_default(),
        author,
        author_id,
        author_avatar,
        duration_sec: duration_millis_to_seconds(
            value.get("durationMillis").map(json_i64).unwrap_or(0),
        ),
        play_count: nonnegative(value.get("viewCount").map(json_i64).unwrap_or(0)),
        danmaku_count: nonnegative(value.get("danmakuCount").map(json_i64).unwrap_or(0)),
        comment_count: value.get("commentCount").map(json_i64).map(nonnegative),
        published_at: millis_to_seconds(value.get("createTimeMillis").map(json_i64).unwrap_or(0)),
        channel_id: channel
            .map(|channel| channel.get("id").map(json_str))
            .flatten(),
        channel_name: channel
            .map(|channel| channel.get("name").map(json_str))
            .flatten(),
    })
}

fn article_item_from_feed(value: &Value) -> Option<AcfunArticleItem> {
    let id = value.get("articleId").map(json_str)?.trim().to_string();
    if id.is_empty() {
        return None;
    }
    Some(AcfunArticleItem {
        id,
        title: clean_title(&value.get("title").map(json_str).unwrap_or_default()),
        summary: clean_title(&value.get("description").map(json_str).unwrap_or_default()),
        cover: cover_url(value),
        author: value.get("userName").map(json_str).unwrap_or_default(),
        author_id: value
            .get("userId")
            .map(json_str)
            .filter(|value| !value.is_empty() && value != "0"),
        view_count: nonnegative(value.get("viewCount").map(json_i64).unwrap_or(0)),
        comment_count: nonnegative(value.get("commentCount").map(json_i64).unwrap_or(0)),
        published_at: millis_to_seconds(value.get("createTime").map(json_i64).unwrap_or(0)),
        channel_id: value
            .get("realmId")
            .map(json_str)
            .filter(|value| !value.is_empty() && value != "0"),
        channel_name: value
            .get("realmName")
            .map(json_str)
            .filter(|value| !value.is_empty()),
    })
}

fn article_item_from_search(value: &Value) -> Option<AcfunArticleItem> {
    let id = value
        .get("contentId")
        .or_else(|| value.get("id"))
        .map(json_str)?
        .trim()
        .to_string();
    if id.is_empty() {
        return None;
    }
    Some(AcfunArticleItem {
        id,
        title: clean_title(
            value
                .get("title")
                .or_else(|| value.get("emTitle"))
                .map(json_str)
                .as_deref()
                .unwrap_or_default(),
        ),
        summary: clean_title(&value.get("decr").map(json_str).unwrap_or_default()),
        cover: None,
        author: value.get("userName").map(json_str).unwrap_or_default(),
        author_id: value
            .get("userId")
            .map(json_str)
            .filter(|value| !value.is_empty() && value != "0"),
        view_count: nonnegative(value.get("viewCount").map(json_i64).unwrap_or(0)),
        comment_count: nonnegative(value.get("commentCount").map(json_i64).unwrap_or(0)),
        published_at: millis_to_seconds(value.get("ctime").map(json_i64).unwrap_or(0)),
        channel_id: None,
        channel_name: value
            .get("channelName")
            .map(json_str)
            .filter(|value| !value.is_empty()),
    })
}

fn article_item_from_detail(value: &Value) -> Option<AcfunArticleItem> {
    let id = value.get("articleId").map(json_str)?.trim().to_string();
    if id.is_empty() {
        return None;
    }
    let (author, author_id, _) = user_fields(value.get("user"));
    let channel = value.get("realm").or_else(|| value.get("channel"));
    Some(AcfunArticleItem {
        id,
        title: clean_title(&value.get("title").map(json_str).unwrap_or_default()),
        summary: clean_title(&value.get("description").map(json_str).unwrap_or_default()),
        cover: cover_url(value),
        author,
        author_id,
        view_count: nonnegative(value.get("viewCount").map(json_i64).unwrap_or(0)),
        comment_count: nonnegative(value.get("commentCount").map(json_i64).unwrap_or(0)),
        published_at: millis_to_seconds(value.get("createTimeMillis").map(json_i64).unwrap_or(0)),
        channel_id: channel
            .and_then(|channel| channel.get("realmId").or_else(|| channel.get("id")))
            .map(json_str)
            .filter(|value| !value.is_empty() && value != "0"),
        channel_name: channel
            .and_then(|channel| channel.get("realmName").or_else(|| channel.get("name")))
            .map(json_str)
            .filter(|value| !value.is_empty()),
    })
}

fn article_tags(value: &Value) -> Vec<String> {
    value
        .get("tagList")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|tag| {
            tag.get("name")
                .map(json_str)
                .or_else(|| tag.as_str().map(str::to_string))
        })
        .map(|tag| clean_title(&tag))
        .filter(|tag| !tag.is_empty())
        .collect()
}

fn parse_duration(raw: &str) -> u64 {
    raw.split(':')
        .try_fold(0_u64, |total, part| {
            let value = part.trim().parse::<u64>().ok()?;
            total.checked_mul(60)?.checked_add(value)
        })
        .unwrap_or(0)
}

impl Default for AcfunContentClient {
    fn default() -> Self {
        Self::new(crate::http_client::default_client())
    }
}

fn parse_play_source(raw: &str, requested_quality: Option<&str>) -> AppResult<AcfunPlaySource> {
    let value: Value = serde_json::from_str(raw).map_err(|_| {
        AcfunContentClient::error("acfun_content_parse_error", "AcFun 播放清单无法识别")
    })?;
    let representations = value
        .get("adaptationSet")
        .and_then(Value::as_array)
        .and_then(|sets| sets.first())
        .and_then(|set| set.get("representation"))
        .and_then(Value::as_array)
        .ok_or_else(|| {
            AcfunContentClient::error("acfun_content_parse_error", "AcFun 播放清单没有视频流")
        })?;

    let mut qualities = Vec::new();
    let mut seen = HashSet::new();
    for representation in representations {
        let id = representation
            .get("qualityType")
            .map(json_str)
            .unwrap_or_default();
        if id.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        let label = representation
            .get("qualityLabel")
            .map(json_str)
            .filter(|label| !label.is_empty())
            .unwrap_or_else(|| id.clone());
        let available = representation
            .get("url")
            .and_then(Value::as_str)
            .is_some_and(|url| !url.trim().is_empty());
        qualities.push(AcfunVideoQuality {
            id,
            label,
            available,
        });
    }
    if qualities.is_empty() {
        return Err(AcfunContentClient::error(
            "acfun_stream_unavailable",
            "AcFun 没有返回可用画质",
        ));
    }

    let wanted = requested_quality
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let selected = wanted
        .and_then(|wanted| {
            representations.iter().find(|representation| {
                representation.get("qualityType").map(json_str).as_deref() == Some(wanted)
                    && representation
                        .get("url")
                        .and_then(Value::as_str)
                        .is_some_and(|url| !url.trim().is_empty())
            })
        })
        .or_else(|| {
            representations.iter().find(|representation| {
                representation
                    .get("url")
                    .and_then(Value::as_str)
                    .is_some_and(|url| !url.trim().is_empty())
            })
        })
        .ok_or_else(|| {
            AcfunContentClient::error("acfun_stream_unavailable", "AcFun 当前没有可用播放地址")
        })?;
    let url = selected
        .get("url")
        .map(json_str)
        .and_then(|url| safe_media_url(&url))
        .ok_or_else(|| {
            AcfunContentClient::error("acfun_stream_unavailable", "AcFun 播放地址格式无效")
        })?;
    let quality = selected
        .get("qualityType")
        .map(json_str)
        .unwrap_or_default();
    let quality_label = selected
        .get("qualityLabel")
        .map(json_str)
        .filter(|label| !label.is_empty())
        .unwrap_or_else(|| quality.clone());
    Ok(AcfunPlaySource {
        url,
        quality,
        quality_label,
        qualities,
    })
}

/// 从 SSR 页面里提取指定 JS 对象。只扫描对象本身，不执行任何页面脚本。
fn extract_js_object(source: &str, marker: &str) -> Option<Value> {
    let marker_at = source.find(marker)?;
    let start = source[marker_at + marker.len()..]
        .find('{')
        .map(|offset| marker_at + marker.len() + offset)?;
    let mut depth = 0_u32;
    let mut in_string = false;
    let mut escaped = false;
    for (offset, ch) in source[start..].char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return serde_json::from_str(&source[start..start + offset + ch.len_utf8()])
                        .ok();
                }
            }
            _ => {}
        }
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Capture {
    Paragraph,
    Heading(u8),
    Quote,
    Code,
    ListItem(bool),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RawInlineRun {
    text: String,
    url: Option<String>,
    bold: bool,
    italic: bool,
}

fn parse_article_blocks(raw: &str) -> Vec<AcfunArticleBlock> {
    let mut parser = ArticleHtmlParser::default();
    parser.feed(raw);
    parser.finish()
}

#[derive(Default)]
struct ArticleHtmlParser {
    blocks: Vec<AcfunArticleBlock>,
    text: String,
    inline_runs: Vec<RawInlineRun>,
    capture: Option<Capture>,
    link_url: Option<String>,
    bold_depth: u32,
    italic_depth: u32,
    list_ordered: Vec<bool>,
    skip_depth: u32,
}

impl ArticleHtmlParser {
    fn feed(&mut self, source: &str) {
        let mut position = 0;
        while position < source.len() {
            let rest = &source[position..];
            if let Some(tag_offset) = rest.find('<') {
                self.push_text(&rest[..tag_offset]);
                let tag_start = position + tag_offset;
                let Some(close_offset) = source[tag_start..].find('>') else {
                    self.push_text(&source[tag_start..]);
                    break;
                };
                let tag_end = tag_start + close_offset + 1;
                let tag = &source[tag_start..tag_end];
                self.handle_tag(tag);
                position = tag_end;
            } else {
                self.push_text(rest);
                break;
            }
        }
    }

    fn finish(mut self) -> Vec<AcfunArticleBlock> {
        self.flush();
        self.blocks
    }

    fn push_text(&mut self, text: &str) {
        if self.skip_depth > 0 || text.is_empty() {
            return;
        }
        let decoded = decode_html_entities(text);
        if self.capture.is_none() {
            if decoded.trim().is_empty() {
                return;
            }
            self.capture = Some(Capture::Paragraph);
        }
        if self.capture == Some(Capture::Paragraph) {
            self.push_inline_text(&decoded);
        } else {
            self.text.push_str(&decoded);
        }
    }

    fn push_inline_text(&mut self, text: &str) {
        let text = normalize_inline_source_text(text);
        if text.is_empty() {
            return;
        }
        self.inline_runs.push(RawInlineRun {
            text,
            url: self.link_url.clone(),
            bold: self.bold_depth > 0,
            italic: self.italic_depth > 0,
        });
    }

    fn push_line_break(&mut self) {
        if self.capture.is_none() {
            self.capture = Some(Capture::Paragraph);
        }
        if self.capture == Some(Capture::Paragraph) {
            self.inline_runs.push(RawInlineRun {
                text: "\n".to_string(),
                url: self.link_url.clone(),
                bold: self.bold_depth > 0,
                italic: self.italic_depth > 0,
            });
        } else {
            self.text.push('\n');
        }
    }

    fn handle_tag(&mut self, raw: &str) {
        let trimmed = raw.trim_start_matches('<').trim_end_matches('>').trim();
        if let Some(name) = trimmed.strip_prefix("!--") {
            let _ = name;
            return;
        }
        let closing = trimmed.starts_with('/');
        let content = trimmed.trim_start_matches('/').trim_start();
        let name_end = content
            .find(|ch: char| ch.is_whitespace() || ch == '/')
            .unwrap_or(content.len());
        let name = content[..name_end].to_ascii_lowercase();
        if name.is_empty() {
            return;
        }
        if matches!(name.as_str(), "script" | "style" | "noscript" | "template") {
            if closing {
                self.skip_depth = self.skip_depth.saturating_sub(1);
            } else if !trimmed.ends_with('/') {
                self.skip_depth += 1;
            }
            return;
        }
        if self.skip_depth > 0 {
            return;
        }
        let attributes = parse_attributes(content);
        if closing {
            match name.as_str() {
                "a" => self.link_url = None,
                "strong" | "b" => self.bold_depth = self.bold_depth.saturating_sub(1),
                "em" | "i" => self.italic_depth = self.italic_depth.saturating_sub(1),
                "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                    if matches!(self.capture, Some(Capture::Heading(_))) {
                        self.flush();
                    }
                }
                "blockquote" => {
                    if self.capture == Some(Capture::Quote) {
                        self.flush();
                    }
                }
                "pre" => {
                    if self.capture == Some(Capture::Code) {
                        self.flush();
                    }
                }
                "li" => {
                    if matches!(self.capture, Some(Capture::ListItem(_))) {
                        self.flush();
                    }
                }
                "ul" | "ol" => {
                    if self.capture == Some(Capture::Paragraph) {
                        self.flush();
                    }
                    self.list_ordered.pop();
                }
                "p" | "div" | "section" | "article" | "header" | "footer" | "main" => {
                    if self.capture == Some(Capture::Paragraph) {
                        self.flush();
                    }
                }
                _ => {}
            }
            return;
        }

        match name.as_str() {
            "img" => {
                self.flush();
                let src = attributes
                    .get("data-original")
                    .or_else(|| attributes.get("data-src"))
                    .or_else(|| attributes.get("src"))
                    .and_then(|url| safe_media_url(url));
                if let Some(url) = src {
                    self.blocks.push(AcfunArticleBlock::Image {
                        url,
                        alt: attributes
                            .get("alt")
                            .map(|alt| normalize_text(&decode_html_entities(alt)))
                            .filter(|alt| !alt.is_empty()),
                    });
                }
            }
            "br" => self.push_line_break(),
            "hr" => {
                self.flush();
                self.blocks.push(AcfunArticleBlock::Divider);
            }
            "p" | "div" | "section" | "article" | "header" | "footer" | "main" => {
                if self.capture.is_none() {
                    self.flush();
                    self.capture = Some(Capture::Paragraph);
                } else if self.capture == Some(Capture::Paragraph)
                    && self
                        .inline_runs
                        .iter()
                        .any(|run| run.text.contains('\n') || !run.text.trim().is_empty())
                {
                    self.flush();
                    self.capture = Some(Capture::Paragraph);
                }
            }
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                self.flush();
                self.capture = Some(Capture::Heading(
                    name.as_bytes().get(1).copied().unwrap_or(b'1') - b'0',
                ));
            }
            "blockquote" => {
                self.flush();
                self.capture = Some(Capture::Quote);
            }
            "pre" => {
                self.flush();
                self.capture = Some(Capture::Code);
            }
            "ul" | "ol" => {
                self.flush();
                self.list_ordered.push(name == "ol");
                self.capture = Some(Capture::Paragraph);
            }
            "li" => {
                self.flush();
                self.capture = Some(Capture::ListItem(
                    self.list_ordered.last().copied().unwrap_or(false),
                ));
            }
            "a" => {
                if self.capture.is_none() {
                    self.capture = Some(Capture::Paragraph);
                }
                self.link_url = attributes.get("href").and_then(|url| safe_media_url(url));
            }
            "strong" | "b" => {
                if self.capture.is_none() {
                    self.capture = Some(Capture::Paragraph);
                }
                self.bold_depth = self.bold_depth.saturating_add(1);
            }
            "em" | "i" => {
                if self.capture.is_none() {
                    self.capture = Some(Capture::Paragraph);
                }
                self.italic_depth = self.italic_depth.saturating_add(1);
            }
            _ => {}
        }
    }

    fn flush(&mut self) {
        let capture = self.capture.take().unwrap_or(Capture::Paragraph);
        if capture == Capture::Paragraph {
            let inlines = finalize_inline_runs(std::mem::take(&mut self.inline_runs));
            if inlines.is_empty() {
                self.text.clear();
                return;
            }
            let text = inlines
                .iter()
                .map(|inline| match inline {
                    AcfunArticleInline::Text { text, .. }
                    | AcfunArticleInline::Link { text, .. } => text.as_str(),
                })
                .collect();
            self.text.clear();
            self.blocks
                .push(AcfunArticleBlock::Paragraph { text, inlines });
            return;
        }
        let code = capture == Capture::Code;
        let text = if code {
            self.text.trim().to_string()
        } else {
            normalize_flow_text(&self.text)
        };
        self.text.clear();
        self.inline_runs.clear();
        if text.is_empty() {
            return;
        }
        match capture {
            Capture::Paragraph => unreachable!(),
            Capture::Heading(level) => self.blocks.push(AcfunArticleBlock::Heading { level, text }),
            Capture::Quote => self.blocks.push(AcfunArticleBlock::Quote { text }),
            Capture::Code => self.blocks.push(AcfunArticleBlock::Code {
                text,
                language: None,
            }),
            Capture::ListItem(ordered) => {
                if let Some(AcfunArticleBlock::List {
                    ordered: existing,
                    items,
                }) = self.blocks.last_mut()
                {
                    if *existing == ordered {
                        items.push(text);
                        return;
                    }
                }
                self.blocks.push(AcfunArticleBlock::List {
                    ordered,
                    items: vec![text],
                });
            }
        }
    }
}

fn normalize_inline_source_text(raw: &str) -> String {
    let leading_space = raw.chars().next().is_some_and(char::is_whitespace);
    let trailing_space = raw.chars().last().is_some_and(char::is_whitespace);
    let core = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if core.is_empty() {
        return if leading_space || trailing_space {
            " ".to_string()
        } else {
            String::new()
        };
    }
    let mut text = String::with_capacity(core.len() + usize::from(leading_space) + 1);
    if leading_space {
        text.push(' ');
    }
    text.push_str(&core);
    if trailing_space {
        text.push(' ');
    }
    text
}

fn finalize_inline_runs(runs: Vec<RawInlineRun>) -> Vec<AcfunArticleInline> {
    let mut inlines = Vec::new();
    let mut active_text = String::new();
    let mut active_url: Option<String> = None;
    let mut active_bold = false;
    let mut active_italic = false;
    let mut active_style = false;
    let mut pending_space = false;

    for run in runs {
        let style_changed = !active_style
            || active_url != run.url
            || active_bold != run.bold
            || active_italic != run.italic;
        if style_changed {
            flush_inline_run(
                &mut inlines,
                &mut active_text,
                &active_url,
                active_bold,
                active_italic,
            );
            if pending_space {
                append_inline_space(&mut inlines);
                pending_space = false;
            }
            active_url = run.url;
            active_bold = run.bold;
            active_italic = run.italic;
            active_style = true;
        }

        for ch in run.text.chars() {
            if ch == '\n' {
                pending_space = false;
                active_text.push(ch);
            } else if ch.is_whitespace() {
                if !active_text.ends_with('\n') {
                    pending_space = true;
                }
            } else {
                if pending_space && (!active_text.is_empty() || !inlines.is_empty()) {
                    active_text.push(' ');
                }
                pending_space = false;
                active_text.push(ch);
            }
        }
    }

    while active_text.ends_with('\n') {
        active_text.pop();
    }
    flush_inline_run(
        &mut inlines,
        &mut active_text,
        &active_url,
        active_bold,
        active_italic,
    );
    trim_inline_boundaries(&mut inlines);
    inlines
}

fn flush_inline_run(
    inlines: &mut Vec<AcfunArticleInline>,
    text: &mut String,
    url: &Option<String>,
    bold: bool,
    italic: bool,
) {
    if text.is_empty() {
        return;
    }
    let value = std::mem::take(text);
    match (inlines.last_mut(), url) {
        (
            Some(AcfunArticleInline::Text {
                text,
                bold: existing_bold,
                italic: existing_italic,
            }),
            None,
        ) if *existing_bold == bold && *existing_italic == italic => {
            text.push_str(&value);
        }
        (
            Some(AcfunArticleInline::Link {
                text,
                url: existing_url,
                bold: existing_bold,
                italic: existing_italic,
            }),
            Some(url),
        ) if existing_url == url && *existing_bold == bold && *existing_italic == italic => {
            text.push_str(&value);
        }
        (_, Some(url)) => inlines.push(AcfunArticleInline::Link {
            text: value,
            url: url.clone(),
            bold,
            italic,
        }),
        (_, None) => inlines.push(AcfunArticleInline::Text {
            text: value,
            bold,
            italic,
        }),
    }
}

fn append_inline_space(inlines: &mut [AcfunArticleInline]) {
    let Some(last) = inlines.last_mut() else {
        return;
    };
    let text = match last {
        AcfunArticleInline::Text { text, .. } | AcfunArticleInline::Link { text, .. } => text,
    };
    if !text.ends_with(char::is_whitespace) {
        text.push(' ');
    }
}

fn trim_inline_boundaries(inlines: &mut Vec<AcfunArticleInline>) {
    while let Some(first) = inlines.first_mut() {
        let text = match first {
            AcfunArticleInline::Text { text, .. } | AcfunArticleInline::Link { text, .. } => text,
        };
        let trimmed = text.trim_start();
        if trimmed.len() == text.len() {
            break;
        }
        *text = trimmed.to_string();
        if !text.is_empty() {
            break;
        }
        inlines.remove(0);
    }
    while let Some(last) = inlines.last_mut() {
        let text = match last {
            AcfunArticleInline::Text { text, .. } | AcfunArticleInline::Link { text, .. } => text,
        };
        let trimmed = text.trim_end();
        if trimmed.len() == text.len() {
            break;
        }
        *text = trimmed.to_string();
        if !text.is_empty() {
            break;
        }
        inlines.pop();
    }
}

fn parse_attributes(fragment: &str) -> HashMap<String, String> {
    let mut values = HashMap::new();
    let mut rest = fragment
        .find(char::is_whitespace)
        .map(|index| &fragment[index..])
        .unwrap_or("");
    while !rest.is_empty() {
        rest = rest.trim_start();
        if rest.is_empty() || rest.starts_with('/') {
            break;
        }
        let name_end = rest
            .find(|ch: char| ch.is_whitespace() || ch == '=')
            .unwrap_or(rest.len());
        let name = rest[..name_end].to_ascii_lowercase();
        rest = rest[name_end..].trim_start();
        if !rest.starts_with('=') {
            continue;
        }
        rest = rest[1..].trim_start();
        let (value, after) =
            if let Some(quote) = rest.chars().next().filter(|c| *c == '"' || *c == '\'') {
                let body = &rest[quote.len_utf8()..];
                let end = body.find(quote).unwrap_or(body.len());
                (&body[..end], &body[end.saturating_add(1).min(body.len())..])
            } else {
                let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
                (&rest[..end], &rest[end..])
            };
        if !name.is_empty() {
            values.insert(name, decode_html_entities(value));
        }
        rest = after;
    }
    values
}

fn normalize_text(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn normalize_flow_text(raw: &str) -> String {
    raw.split('\n')
        .map(normalize_text)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn strip_html_text(raw: &str) -> String {
    let mut parser = ArticleHtmlParser::default();
    parser.feed(raw);
    let blocks = parser.finish();
    normalize_text(
        &blocks
            .into_iter()
            .filter_map(|block| match block {
                AcfunArticleBlock::Paragraph { text, .. }
                | AcfunArticleBlock::Heading { text, .. }
                | AcfunArticleBlock::Quote { text } => Some(text),
                AcfunArticleBlock::Link { text, .. } => Some(text),
                AcfunArticleBlock::List { items, .. } => Some(items.join(" ")),
                AcfunArticleBlock::Code { text, .. } => Some(text),
                AcfunArticleBlock::Image { .. } | AcfunArticleBlock::Divider => None,
            })
            .collect::<Vec<_>>()
            .join(" "),
    )
}

fn decode_html_entities(raw: &str) -> String {
    let mut output = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(start) = rest.find('&') {
        output.push_str(&rest[..start]);
        let tail = &rest[start..];
        let Some(end) = tail.find(';').filter(|end| *end <= 12) else {
            output.push('&');
            rest = &tail[1..];
            continue;
        };
        let entity = &tail[1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            _ if entity.starts_with("#x") || entity.starts_with("#X") => {
                u32::from_str_radix(&entity[2..], 16)
                    .ok()
                    .and_then(char::from_u32)
            }
            _ if entity.starts_with('#') => {
                entity[1..].parse::<u32>().ok().and_then(char::from_u32)
            }
            _ => None,
        };
        if let Some(decoded) = decoded {
            output.push(decoded);
        } else {
            output.push_str(&tail[..=end]);
        }
        rest = &tail[end + 1..];
    }
    output.push_str(rest);
    output
}

#[cfg(test)]
mod tests {
    use super::{
        AcfunArticleBlock, AcfunArticleInline, AcfunCommentSort, VIDEO_PAGE_SIZE, api_result,
        article_channels_from_navigation, article_item_from_feed, article_next_cursor,
        decode_html_entities, extract_js_object, indexed_page_has_more, parse_article_blocks,
        parse_comment_reply_page, parse_duration, parse_play_source, parse_required_items,
        parse_video_comment_page, required_array, required_total, safe_media_url, total_has_more,
        video_item_from_feed, video_item_from_search,
    };

    #[test]
    fn extracts_embedded_json_without_executing_page_scripts() {
        let page = r#"<script>window.videoInfo = {"title":"a } b","nested":{"ok":true}};</script>"#;
        let value = extract_js_object(page, "window.videoInfo =").expect("embedded JSON");
        assert_eq!(value["title"], "a } b");
        assert_eq!(value["nested"]["ok"], true);
    }

    #[test]
    fn parses_article_html_into_safe_semantic_blocks() {
        let html = r#"<div>第一段 <a href="https://example.com/a?q=1&amp;x=2">链接</a></div>
            <h2>标题</h2><img src="//imgs.aixifan.com/a.png" alt="配图">
            <ul><li>条目一</li><li>条目二</li></ul>
            <script>alert(1)</script><p>末段</p>"#;
        let blocks = parse_article_blocks(html);
        assert_eq!(
            blocks[0],
            AcfunArticleBlock::Paragraph {
                text: "第一段 链接".to_string(),
                inlines: vec![
                    AcfunArticleInline::Text {
                        text: "第一段 ".to_string(),
                        bold: false,
                        italic: false,
                    },
                    AcfunArticleInline::Link {
                        text: "链接".to_string(),
                        url: "https://example.com/a?q=1&x=2".to_string(),
                        bold: false,
                        italic: false,
                    },
                ],
            }
        );
        assert!(
            !blocks
                .iter()
                .any(|block| matches!(block, AcfunArticleBlock::Link { .. }))
        );
        assert!(blocks.contains(&AcfunArticleBlock::Heading {
            level: 2,
            text: "标题".to_string(),
        }));
        assert!(blocks.iter().any(|block| matches!(
            block,
            AcfunArticleBlock::Image { url, alt }
                if url == "https://imgs.aixifan.com/a.png" && alt.as_deref() == Some("配图")
        )));
        assert!(blocks.contains(&AcfunArticleBlock::List {
            ordered: false,
            items: vec!["条目一".to_string(), "条目二".to_string()],
        }));
        assert!(!serde_json::to_string(&blocks).unwrap().contains("alert(1)"));
    }

    #[test]
    fn preserves_inline_formatting_links_and_soft_breaks_in_one_paragraph() {
        let html = r#"<p><strong>粗体 <em>斜体</em></strong><br />普通
            <a href="https://example.com/a?q=1&amp;x=2"><strong>链接</strong></a>收尾。</p>"#;
        assert_eq!(
            parse_article_blocks(html),
            vec![AcfunArticleBlock::Paragraph {
                text: "粗体 斜体\n普通 链接收尾。".to_string(),
                inlines: vec![
                    AcfunArticleInline::Text {
                        text: "粗体 ".to_string(),
                        bold: true,
                        italic: false,
                    },
                    AcfunArticleInline::Text {
                        text: "斜体".to_string(),
                        bold: true,
                        italic: true,
                    },
                    AcfunArticleInline::Text {
                        text: "\n普通 ".to_string(),
                        bold: false,
                        italic: false,
                    },
                    AcfunArticleInline::Link {
                        text: "链接".to_string(),
                        url: "https://example.com/a?q=1&x=2".to_string(),
                        bold: true,
                        italic: false,
                    },
                    AcfunArticleInline::Text {
                        text: "收尾。".to_string(),
                        bold: false,
                        italic: false,
                    },
                ],
            }]
        );
    }

    #[test]
    fn keeps_sibling_paragraph_boundaries_inside_container_elements() {
        let paragraph = |text: &str| AcfunArticleBlock::Paragraph {
            text: text.to_string(),
            inlines: vec![AcfunArticleInline::Text {
                text: text.to_string(),
                bold: false,
                italic: false,
            }],
        };
        let expected = vec![paragraph("A"), paragraph("B")];
        assert_eq!(parse_article_blocks("<p>A</p><p>B</p>"), expected);
        assert_eq!(
            parse_article_blocks("<div><p>A</p><p>B</p></div>"),
            expected
        );
    }

    #[test]
    fn flushes_paragraph_content_before_nested_block_container() {
        assert_eq!(
            parse_article_blocks("<div>前文<p>中段</p>末段</div>"),
            vec![
                AcfunArticleBlock::Paragraph {
                    text: "前文".to_string(),
                    inlines: vec![AcfunArticleInline::Text {
                        text: "前文".to_string(),
                        bold: false,
                        italic: false,
                    }],
                },
                AcfunArticleBlock::Paragraph {
                    text: "中段".to_string(),
                    inlines: vec![AcfunArticleInline::Text {
                        text: "中段".to_string(),
                        bold: false,
                        italic: false,
                    }],
                },
                AcfunArticleBlock::Paragraph {
                    text: "末段".to_string(),
                    inlines: vec![AcfunArticleInline::Text {
                        text: "末段".to_string(),
                        bold: false,
                        italic: false,
                    }],
                },
            ]
        );
    }

    #[test]
    fn preserves_nested_emphasis() {
        assert_eq!(
            parse_article_blocks("<p><strong>粗<em>斜<strong>深</strong>斜</em>粗</strong></p>"),
            vec![AcfunArticleBlock::Paragraph {
                text: "粗斜深斜粗".to_string(),
                inlines: vec![
                    AcfunArticleInline::Text {
                        text: "粗".to_string(),
                        bold: true,
                        italic: false,
                    },
                    AcfunArticleInline::Text {
                        text: "斜深斜".to_string(),
                        bold: true,
                        italic: true,
                    },
                    AcfunArticleInline::Text {
                        text: "粗".to_string(),
                        bold: true,
                        italic: false,
                    },
                ],
            }]
        );
    }

    #[test]
    fn skips_active_content_flattens_unsafe_links_and_keeps_repeated_breaks() {
        assert_eq!(
            parse_article_blocks(
                r#"<p>前<a href="javascript:alert(1)">危险</a><script>bad()</script><style>p{color:red}</style>后<br><br>尾</p>"#
            ),
            vec![AcfunArticleBlock::Paragraph {
                text: "前危险后\n\n尾".to_string(),
                inlines: vec![AcfunArticleInline::Text {
                    text: "前危险后\n\n尾".to_string(),
                    bold: false,
                    italic: false,
                }],
            }]
        );
    }

    #[test]
    fn paragraph_inlines_deserialize_from_legacy_text_and_skip_empty_on_serialize() {
        let legacy: AcfunArticleBlock = serde_json::from_value(serde_json::json!({
            "type": "paragraph",
            "text": "旧缓存"
        }))
        .unwrap();
        assert_eq!(
            legacy,
            AcfunArticleBlock::Paragraph {
                text: "旧缓存".to_string(),
                inlines: Vec::new(),
            }
        );

        let value = serde_json::to_value(AcfunArticleBlock::Paragraph {
            text: "无行内数据".to_string(),
            inlines: Vec::new(),
        })
        .unwrap();
        assert!(value.get("inlines").is_none());
    }

    #[test]
    fn preserves_ordered_list_semantics() {
        let blocks = parse_article_blocks("<ol><li>第一步</li><li>第二步</li></ol>");
        assert_eq!(
            blocks,
            vec![AcfunArticleBlock::List {
                ordered: true,
                items: vec!["第一步".to_string(), "第二步".to_string()],
            }]
        );
    }

    #[test]
    fn maps_video_and_article_feed_fields() {
        let video = serde_json::json!({
            "dougaId": "48980472",
            "title": "测试视频",
            "coverUrl": "http://tx-free-imgs.acfun.cn/a.jpg",
            "durationMillis": 7667,
            "viewCount": 12,
            "danmakuCount": 3,
            "commentCount": 2,
            "createTimeMillis": 1794312790990_i64,
            "user": {"id": "3540234", "name": "作者", "headUrl": "https://imgs.aixifan.com/avatar.jpg"},
            "channel": {"id": 218, "name": "颜值"}
        });
        let item = video_item_from_feed(&video).unwrap();
        assert_eq!(item.id, "48980472");
        assert_eq!(item.duration_sec, 7);
        assert_eq!(item.published_at, 1_794_312_790);
        assert_eq!(item.cover, "https://tx-free-imgs.acfun.cn/a.jpg");

        let article = serde_json::json!({
            "articleId": 48987145_u64,
            "title": "测试文章",
            "description": "摘要",
            "viewCount": 1382,
            "commentCount": 6,
            "createTime": 1794552604311_i64,
            "userId": 77060603_u64,
            "userName": "作者",
            "realmId": 34,
            "realmName": "日常分享"
        });
        let item = article_item_from_feed(&article).unwrap();
        assert_eq!(item.id, "48987145");
        assert_eq!(item.published_at, 1_794_552_604);
        assert_eq!(item.channel_id.as_deref(), Some("34"));
    }

    #[test]
    fn video_search_uses_content_id_instead_of_internal_part_id() {
        let value = serde_json::json!({
            "contentId": 16171259_u64,
            "id": 16171259_u64,
            "videoId": "13265203",
            "title": "入站歌",
            "commentCount": 2142_u64,
            "viewCount": 161896_u64,
            "danmuCount": 678_u64
        });
        let item = video_item_from_search(&value).unwrap();
        assert_eq!(item.id, "16171259");
        assert_eq!(item.comment_count, Some(2142));
    }

    #[test]
    fn article_channels_keep_real_realm_ids_without_synthetic_all_channel() {
        let navigation = serde_json::json!({
            "data": [
                {
                    "typeId": 110,
                    "typeName": "资讯",
                    "realms": [
                        {"realmId": 22, "realmName": "娱乐体育"},
                        {"realmId": 28, "realmName": "新闻资讯"},
                        {"realmId": 28, "realmName": "重复分区"}
                    ]
                },
                {
                    "typeId": 73,
                    "typeName": "生活",
                    "realms": [
                        {"realmId": 34, "realmName": "日常分享"}
                    ]
                }
            ]
        });
        let channels = article_channels_from_navigation(&navigation).unwrap();
        assert_eq!(
            channels
                .iter()
                .map(|channel| (channel.id.as_str(), channel.name.as_str()))
                .collect::<Vec<_>>(),
            vec![("22", "娱乐体育"), ("28", "新闻资讯"), ("34", "日常分享")]
        );
        assert!(channels.iter().all(|channel| !channel.id.is_empty()));
    }

    #[test]
    fn rejects_missing_required_collections_and_totals() {
        let malformed = serde_json::json!({"result": 0});
        for field in ["feed", "rankList", "data", "articleList"] {
            let error = required_array(&malformed, field, "内容列表").unwrap_err();
            assert_eq!(error.code, "acfun_content_parse_error");
        }
        for field in ["total", "totalNum"] {
            let error = required_total(&malformed, field, "内容列表").unwrap_err();
            assert_eq!(error.code, "acfun_content_parse_error");
        }
        let result_error = api_result(&serde_json::json!({}), "视频列表").unwrap_err();
        assert_eq!(result_error.code, "acfun_content_parse_error");

        for navigation in [
            serde_json::json!({
                "data": [{"realms": [{"realmId": "", "realmName": "综合"}]}]
            }),
            serde_json::json!({
                "data": [{"realms": [{"realmId": 28}]}]
            }),
        ] {
            assert_eq!(
                article_channels_from_navigation(&navigation)
                    .unwrap_err()
                    .code,
                "acfun_content_parse_error"
            );
        }

        let explicit_empty = serde_json::json!({"feed": [], "total": 0});
        assert!(
            required_array(&explicit_empty, "feed", "视频列表")
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            required_total(&explicit_empty, "total", "视频列表").unwrap(),
            0
        );
        assert!(
            parse_required_items::<serde_json::Value>(
                required_array(&explicit_empty, "feed", "视频列表").unwrap(),
                "视频列表",
                |_| None,
            )
            .unwrap()
            .is_empty()
        );

        let malformed_item = serde_json::json!([{}]);
        assert_eq!(
            parse_required_items(malformed_item.as_array().unwrap(), "视频列表", |value| {
                value
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::len)
            })
            .unwrap_err()
            .code,
            "acfun_content_parse_error"
        );
    }

    #[test]
    fn stops_article_pagination_when_cursor_does_not_advance() {
        let repeated = serde_json::json!({"cursor": "same-cursor"});
        assert_eq!(
            article_next_cursor(&repeated, "same-cursor", "文章列表").unwrap(),
            None
        );
        let exhausted = serde_json::json!({"cursor": "no_more"});
        assert_eq!(
            article_next_cursor(&exhausted, "previous", "文章列表").unwrap(),
            None
        );
        let advanced = serde_json::json!({"cursor": "next-cursor"});
        assert_eq!(
            article_next_cursor(&advanced, "previous", "文章列表")
                .unwrap()
                .as_deref(),
            Some("next-cursor")
        );
        assert_eq!(
            article_next_cursor(&serde_json::json!({}), "previous", "文章列表")
                .unwrap_err()
                .code,
            "acfun_content_parse_error"
        );
    }

    #[test]
    fn uses_real_upstream_page_ranges_for_more_pages() {
        assert_eq!(VIDEO_PAGE_SIZE, 30);
        assert!(total_has_more(2, VIDEO_PAGE_SIZE, 10_000, 30));
        assert!(indexed_page_has_more(1, 2, 30));
        assert!(!indexed_page_has_more(2, 2, 30));
        assert!(!indexed_page_has_more(2, 2, 0));
    }

    #[test]
    fn selects_default_or_requested_representation() {
        let json = r#"{"adaptationSet":[{"representation":[
            {"qualityType":"1080p","qualityLabel":"1080P","url":"https://tx-safety-video.acfun.cn/hi.m3u8"},
            {"qualityType":"720p","qualityLabel":"720P","url":"https://tx-safety-video.acfun.cn/lo.m3u8"}
        ]}]}"#;
        let default = parse_play_source(json, None).unwrap();
        assert_eq!(default.quality, "1080p");
        let selected = parse_play_source(json, Some("720p")).unwrap();
        assert_eq!(selected.quality, "720p");
        assert_eq!(selected.qualities.len(), 2);
    }

    #[test]
    fn keeps_only_http_media_urls_and_normalizes_relative_urls() {
        assert_eq!(
            safe_media_url("//imgs.aixifan.com/a.png").as_deref(),
            Some("https://imgs.aixifan.com/a.png")
        );
        assert_eq!(
            safe_media_url("/newUpload/a.jpg").as_deref(),
            Some("https://www.acfun.cn/newUpload/a.jpg")
        );
        assert!(safe_media_url("javascript:alert(1)").is_none());
    }

    #[test]
    fn parses_codes_and_durations() {
        assert_eq!(
            decode_html_entities("A&amp;B &#x4E2D;"),
            "A&B 中".to_string()
        );
        assert_eq!(parse_duration("01:02:03"), 3723);
    }

    #[test]
    fn parses_comment_pages_with_previews_and_safe_display_content() {
        let value = serde_json::json!({
            "result": 0,
            "commentCount": 4,
            "curPage": 1,
            "totalPage": 2,
            "pageSize": 50,
            "hotComments": [{
                "commentId": 12,
                "userName": "热门",
                "userId": 2,
                "content": "热门内容",
                "timestamp": 1_700_000_000_000_i64,
                "likeCount": 4,
                "isUp": false,
                "subCommentCount": 0
            }],
            "rootComments": [{
                "commentId": 11,
                "userName": "楼主",
                "userId": 1,
                "avatarImage": "//imgs.aixifan.com/avatar.png?imageslim",
                "content": "[b]正文[/b][emot=acfun,1/][br][img=640,360]//imgs.aixifan.com/a.png[/img]",
                "timestamp": 1_700_000_000_000_i64,
                "likeCount": 2,
                "isUp": true,
                "subCommentCount": 4
            }, {
                "commentId": 12,
                "userName": "热门",
                "content": "热门内容",
                "timestamp": 1_700_000_000_000_i64,
                "likeCount": 4,
                "subCommentCount": 0
            }],
            "subCommentsMap": {
                "11": {"subComments": [{
                    "commentId": 21,
                    "userName": "回复者",
                    "replyToUserName": "楼主",
                    "content": "预览回复",
                    "timestamp": 1_700_000_001_000_i64,
                    "likeCount": 0
                }]}
            }
        });
        let hot = parse_video_comment_page(&value, AcfunCommentSort::Hot).unwrap();
        assert_eq!(hot.total, 4);
        assert!(hot.has_more);
        assert_eq!(hot.next_page, Some(2));
        assert_eq!(
            hot.items
                .iter()
                .map(|comment| comment.id.as_str())
                .collect::<Vec<_>>(),
            vec!["12", "11"]
        );
        let root = &hot.items[1];
        assert_eq!(root.content, "正文[表情]");
        assert_eq!(
            root.pictures,
            vec!["https://imgs.aixifan.com/a.png".to_string()]
        );
        assert_eq!(
            root.avatar.as_deref(),
            Some("https://imgs.aixifan.com/avatar.png?imageslim")
        );
        assert_eq!(root.replies[0].parent_id.as_deref(), Some("11"));
        assert_eq!(root.replies[0].reply_to_name.as_deref(), Some("楼主"));

        let chronological = parse_video_comment_page(&value, AcfunCommentSort::Time).unwrap();
        assert_eq!(
            chronological
                .items
                .iter()
                .map(|comment| comment.id.as_str())
                .collect::<Vec<_>>(),
            vec!["11", "12"]
        );
    }

    #[test]
    fn parses_reply_page_and_advances_with_page_cursor() {
        let value = serde_json::json!({
            "result": 0,
            "subCommentCount": 14,
            "curPage": 2,
            "totalPage": 2,
            "pageSize": 10,
            "subComments": [{
                "commentId": 31,
                "userName": "回复者",
                "content": "第二页回复",
                "timestamp": 1_700_000_000_000_i64,
                "likeCount": 1
            }]
        });
        let page = parse_comment_reply_page(&value, "11").unwrap();
        assert_eq!(page.total, 14);
        assert_eq!(page.items[0].parent_id.as_deref(), Some("11"));
        assert!(!page.has_more);
        assert_eq!(page.next_cursor, None);

        let mut more = value;
        more["totalPage"] = serde_json::json!(3);
        assert_eq!(
            parse_comment_reply_page(&more, "11")
                .unwrap()
                .next_cursor
                .as_deref(),
            Some("3")
        );
    }

    #[test]
    fn accepts_real_empty_comment_pages_and_rejects_malformed_metadata() {
        let empty = serde_json::json!({
            "result": 0,
            "commentCount": 0,
            "curPage": 1,
            "totalPage": 0,
            "pageSize": 50,
            "rootComments": [],
            "hotComments": [],
            "subCommentsMap": {}
        });
        let page = parse_video_comment_page(&empty, AcfunCommentSort::Time).unwrap();
        assert!(page.items.is_empty());
        assert!(!page.has_more);
        assert_eq!(page.total, 0);

        let mut missing_list = empty.clone();
        missing_list.as_object_mut().unwrap().remove("rootComments");
        assert_eq!(
            parse_video_comment_page(&missing_list, AcfunCommentSort::Time)
                .unwrap_err()
                .code,
            "acfun_content_parse_error"
        );

        let mut wrong_list = empty.clone();
        wrong_list["hotComments"] = serde_json::json!({});
        assert_eq!(
            parse_video_comment_page(&wrong_list, AcfunCommentSort::Hot)
                .unwrap_err()
                .code,
            "acfun_content_parse_error"
        );

        let mut wrong_metadata = empty.clone();
        wrong_metadata["totalPage"] = serde_json::json!("zero");
        assert_eq!(
            parse_video_comment_page(&wrong_metadata, AcfunCommentSort::Time)
                .unwrap_err()
                .code,
            "acfun_content_parse_error"
        );

        let mut bad_map = empty;
        bad_map["subCommentsMap"] = serde_json::json!([]);
        assert_eq!(
            parse_video_comment_page(&bad_map, AcfunCommentSort::Time)
                .unwrap_err()
                .code,
            "acfun_content_parse_error"
        );
    }

    #[test]
    fn rejects_malformed_empty_reply_page_instead_of_hiding_fields() {
        let value = serde_json::json!({
            "result": 0,
            "subCommentCount": 0,
            "curPage": 1,
            "totalPage": 0,
            "pageSize": 10
        });
        assert_eq!(
            parse_comment_reply_page(&value, "11").unwrap_err().code,
            "acfun_content_parse_error"
        );

        let mut wrong_page = value;
        wrong_page["subComments"] = serde_json::json!([]);
        wrong_page["curPage"] = serde_json::json!(0);
        assert_eq!(
            parse_comment_reply_page(&wrong_page, "11")
                .unwrap_err()
                .code,
            "acfun_content_parse_error"
        );
    }

    #[test]
    fn comment_cleaning_preserves_ubb_and_html_line_breaks() {
        assert_eq!(
            super::clean_comment_content(
                "[b]第一行[/b][br]第二行<br/>第三段\n<p>第四段</p><p>第五段</p><script>隐藏</script>"
            ),
            "第一行\n第二行\n第三段\n第四段\n第五段"
        );
    }
}
