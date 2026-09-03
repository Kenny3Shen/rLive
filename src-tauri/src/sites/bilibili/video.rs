//! Bilibili 视频（VOD）能力：列表、DASH 播放信息与分段弹幕。
//!
//! VOD 不属于 [`crate::sites::traits::LiveSite`]：它是 Bilibili 独有的表面，
//! 其他站点没有对应概念。因此这里作为 [`BilibiliSite`] 的 inherent impl 追加，
//! 复用同一份 cookie、buvid 与 WBI 签名，而不去污染跨站点的 trait。

use std::collections::BTreeMap;

use serde_json::Value;

use crate::danmu_rs::{ProtoReader, ProtoValue};
use crate::error::{AppError, AppResult};
use crate::models::video::{
    DanmakuItem, PgcItem, PgcListPage, SeasonEpisode, VideoArchive, VideoComment, VideoCommentPage,
    VideoDanmakuSegment, VideoEmote, VideoItem, VideoListPage, VideoPlayRequest, VideoQuality,
    VideoSeason,
};

use super::BilibiliSite;
use super::api::{DEFAULT_USER_AGENT, as_i64, as_str, avatar_thumb};

/// 移除 HTML 标签（搜索结果的 title 字段包含 `<em class="keyword">` 高亮标记）。
fn strip_html_tags(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        if ch == '<' {
            in_tag = true;
        } else if ch == '>' {
            in_tag = false;
        } else if !in_tag {
            result.push(ch);
        }
    }
    result
}

/// 视频接口与媒体 URL 使用的 Referer。
///
/// 站点默认的 `DEFAULT_REFERER` 指向直播域名。JSON 接口对两者都放行（已实测），
/// 但媒体 CDN 分主机行为不同：`upos-*.bilivideo.com` 与
/// `*.edge.mountaintoys.cn` 在缺少站点 Referer 时直接 403。
/// 因此 sidx 抓取与代理注入一律用这个值。
pub const VIDEO_REFERER: &str = "https://www.bilibili.com";

/// 默认视频编码前缀。
///
/// 同一画质会并列 avc1 / hvc1 / av01 三个变体，选流必须按编码过滤。
/// avc1 在各平台 WebView 上的硬解覆盖最广，作为默认最稳。
const DEFAULT_CODEC: &str = "avc1";

/// 单条弹幕正文的字节上限，防止异常长文本进入渲染层。
const MAX_DANMAKU_CONTENT: usize = 512;

/// VOD 弹幕分段长度：6 分钟。
const DANMAKU_SEGMENT_MILLIS: i64 = 360_000;

fn video_err(msg: impl Into<String>) -> AppError {
    AppError::new("bilibili_video_error", msg).with_site("bilibili")
}

/// 把封面地址补成可直接加载的 https URL。
///
/// 列表接口大量返回 `http://i1.hdslb.com/...`。WebView 以 https 源加载页面时
/// 会按混合内容拦掉这些图片，所以强制升级协议。
fn video_cover(raw: &str) -> String {
    let raw = raw.trim();
    if raw.is_empty() {
        return String::new();
    }
    if let Some(rest) = raw.strip_prefix("//") {
        format!("https://{rest}")
    } else if let Some(rest) = raw.strip_prefix("http://") {
        format!("https://{rest}")
    } else if raw.starts_with("https://") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    }
}

/// 读取上游的推荐理由。
///
/// 热门流给对象（`{content, corner_mark}`），推荐流给 `null` 或字符串，
/// 两种形状都要收下。
fn rcmd_reason(item: &Value) -> Option<String> {
    let raw = item.get("rcmd_reason")?;
    let text = match raw {
        Value::String(text) => text.clone(),
        Value::Object(_) => as_str(raw.get("content")?),
        _ => return None,
    };
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// 解析一条 UGC 稿件。
///
/// 热门与分区榜用 `aid`，推荐流改用 `id` 表示同一个值，两个键都要认。
fn video_item(item: &Value) -> VideoItem {
    let aid = item
        .get("aid")
        .or_else(|| item.get("id"))
        .map(as_str)
        .unwrap_or_default();
    let owner = item.get("owner");
    let author_face = owner
        .and_then(|owner| owner.get("face"))
        .map(as_str)
        .map(|face| avatar_thumb(&face))
        .filter(|face| !face.is_empty());
    let stat = item.get("stat");
    let cid = item.get("cid").map(as_i64).filter(|cid| *cid > 0);
    VideoItem {
        bvid: item.get("bvid").map(as_str).unwrap_or_default(),
        aid,
        cid,
        title: strip_html_tags(&item.get("title").map(as_str).unwrap_or_default()),
        cover: video_cover(&item.get("pic").map(as_str).unwrap_or_default()),
        // 搜索条目是扁平结构：没有 owner/stat，作者在 author、播放量在 play、
        // 弹幕数在 video_review。带 owner 的接口没有这些字段，回退分支不会触发。
        author: owner
            .and_then(|owner| owner.get("name"))
            .map(as_str)
            .filter(|name| !name.is_empty())
            .or_else(|| item.get("author").map(as_str))
            .filter(|author| !author.is_empty())
            .unwrap_or_default(),
        author_face,
        duration: video_duration(item.get("duration")),
        view: stat
            .and_then(|stat| stat.get("view"))
            .map(as_i64)
            .filter(|view| *view > 0)
            .or_else(|| item.get("play").map(as_i64))
            .unwrap_or(0),
        danmaku: stat
            .and_then(|stat| stat.get("danmaku"))
            .map(as_i64)
            .filter(|danmaku| *danmaku > 0)
            .or_else(|| item.get("video_review").map(as_i64))
            .unwrap_or(0),
        pubdate: item.get("pubdate").map(as_i64).unwrap_or_default(),
        rcmd_reason: rcmd_reason(item),
    }
}

/// 条目时长。推荐/热门给秒数（数字），搜索给 `H:MM:SS` / `M:SS` 格式的字符串。
fn video_duration(value: Option<&Value>) -> i64 {
    let Some(value) = value else {
        return 0;
    };
    match value {
        Value::Number(_) => as_i64(value),
        Value::String(s) => {
            let seconds: i64 = s
                .split(':')
                .rev()
                .enumerate()
                .map(|(index, part)| {
                    part.trim()
                        .parse::<i64>()
                        .map(|part| part * 60_i64.pow(index as u32))
                        .unwrap_or(0)
                })
                .sum();
            seconds.max(0)
        }
        _ => 0,
    }
}

/// representation 的候选地址：base_url 优先，backup_url / backupBaseUrl 随后。
///
/// mcdn 等 PCDN 节点会对部分网络环境返回 403 或直接拒连，而同一 representation
/// 的备用地址里通常有可用的 upos 镜像；抓 sidx 时逐个尝试，选第一个能服务的。
fn stream_candidates(rep: &Value) -> Vec<String> {
    let mut candidates: Vec<String> = Vec::new();
    for key in ["base_url", "baseUrl"] {
        if let Some(url) = rep
            .get(key)
            .map(as_str)
            .filter(|url| !url.is_empty())
            && !candidates.contains(&url)
        {
            candidates.push(url);
        }
    }
    for key in ["backup_url", "backupBaseUrl"] {
        if let Some(list) = rep.get(key).and_then(Value::as_array) {
            for url in list.iter().map(as_str).filter(|url| !url.is_empty()) {
                if !candidates.contains(&url) {
                    candidates.push(url);
                }
            }
        }
    }
    candidates
}

/// 解析推荐流 `data.item[]`。
///
/// 该接口会混入直播、番剧等非稿件条目，只有 `goto == "av"` 且带 `owner` 的
/// 才是可播的 UGC 稿件。
pub fn parse_recommend(raw: &str) -> AppResult<VideoListPage> {
    let root: Value =
        serde_json::from_str(raw).map_err(|e| video_err(format!("推荐流 json: {e}")))?;
    let items = root
        .pointer("/data/item")
        .and_then(Value::as_array)
        .ok_or_else(|| video_err("推荐流缺少 data.item"))?
        .iter()
        .filter(|item| item.get("goto").map(as_str).as_deref() == Some("av"))
        .filter(|item| item.get("owner").is_some())
        .map(video_item)
        .filter(|item| !item.bvid.is_empty())
        .collect::<Vec<_>>();
    // 推荐流是无限刷新的，只要这一刷还有内容就认为可以继续。
    Ok(VideoListPage {
        has_more: !items.is_empty(),
        items,
    })
}

/// 解析热门 `data.list[]`。尾页由 `data.no_more` 明确告知。
pub fn parse_popular(raw: &str) -> AppResult<VideoListPage> {
    let root: Value =
        serde_json::from_str(raw).map_err(|e| video_err(format!("热门 json: {e}")))?;
    let items = root
        .pointer("/data/list")
        .and_then(Value::as_array)
        .ok_or_else(|| video_err("热门缺少 data.list"))?
        .iter()
        .map(video_item)
        .collect();
    let no_more = root
        .pointer("/data/no_more")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Ok(VideoListPage {
        has_more: !no_more,
        items,
    })
}

/// 解析分区榜 `data.list[]`（结构与热门一致，但该接口只有一页）。
pub fn parse_zone(raw: &str) -> AppResult<VideoListPage> {
    let root: Value =
        serde_json::from_str(raw).map_err(|e| video_err(format!("分区榜 json: {e}")))?;
    let items = root
        .pointer("/data/list")
        .and_then(Value::as_array)
        .ok_or_else(|| video_err("分区榜缺少 data.list"))?
        .iter()
        .map(video_item)
        .collect();
    // `ranking/v2` 一次返回全部榜单条目，没有翻页参数。
    Ok(VideoListPage {
        has_more: false,
        items,
    })
}

fn pgc_item(item: &Value) -> PgcItem {
    let badge = item
        .get("badge")
        .map(as_str)
        .filter(|badge| !badge.is_empty());
    let index_show = item
        .get("index_show")
        .map(as_str)
        .filter(|show| !show.is_empty());
    // 索引接口在 `first_ep.ep_id` 给出首集；排行榜接口不带该字段，
    // 此时留空，由调用方回退到 season 详情。
    let ep_id = item
        .pointer("/first_ep/ep_id")
        .map(as_str)
        .filter(|id| !id.is_empty() && id != "0");
    PgcItem {
        season_id: item.get("season_id").map(as_str).unwrap_or_default(),
        ep_id,
        title: item.get("title").map(as_str).unwrap_or_default(),
        cover: video_cover(&item.get("cover").map(as_str).unwrap_or_default()),
        badge,
        index_show,
    }
}

/// 解析 PGC 索引 `data.list[]`。翻页由 `data.has_next` 明确告知。
pub fn parse_pgc_index(raw: &str) -> AppResult<PgcListPage> {
    let root: Value =
        serde_json::from_str(raw).map_err(|e| video_err(format!("PGC 索引 json: {e}")))?;
    let items = root
        .pointer("/data/list")
        .and_then(Value::as_array)
        .ok_or_else(|| video_err("PGC 索引缺少 data.list"))?
        .iter()
        .map(pgc_item)
        .filter(|item| !item.season_id.is_empty())
        .collect();
    let has_more = root
        .pointer("/data/has_next")
        .map(|next| match next {
            Value::Bool(flag) => *flag,
            other => as_i64(other) != 0,
        })
        .unwrap_or(false);
    Ok(PgcListPage { has_more, items })
}

/// 解析 PGC 排行榜。
///
/// 番剧走 `pgc/web/rank/list`，结果在 `result.list`；其他 season_type 走
/// `pgc/season/rank/web/list`，结果在 `data.list`。两处结构相同，
/// 因此按存在的那个键取。
pub fn parse_pgc_rank(raw: &str) -> AppResult<PgcListPage> {
    let root: Value =
        serde_json::from_str(raw).map_err(|e| video_err(format!("PGC 榜单 json: {e}")))?;
    let items = root
        .pointer("/result/list")
        .or_else(|| root.pointer("/data/list"))
        .and_then(Value::as_array)
        .ok_or_else(|| video_err("PGC 榜单缺少 list"))?
        .iter()
        .map(pgc_item)
        .filter(|item| !item.season_id.is_empty())
        .collect();
    // 榜单是固定长度的快照，没有下一页。
    Ok(PgcListPage {
        has_more: false,
        items,
    })
}

/// 解析 season 详情 `result`。
pub fn parse_season(raw: &str) -> AppResult<VideoSeason> {
    let root: Value =
        serde_json::from_str(raw).map_err(|e| video_err(format!("season json: {e}")))?;
    let result = root
        .get("result")
        .ok_or_else(|| video_err("season 缺少 result"))?;
    let episodes = result
        .get("episodes")
        .and_then(Value::as_array)
        .map(|episodes| episodes.iter().map(season_episode).collect())
        .unwrap_or_default();
    Ok(VideoSeason {
        season_id: result.get("season_id").map(as_str).unwrap_or_default(),
        title: result.get("title").map(as_str).unwrap_or_default(),
        cover: video_cover(&result.get("cover").map(as_str).unwrap_or_default()),
        evaluate: result.get("evaluate").map(as_str).unwrap_or_default(),
        episodes,
    })
}

fn season_episode(episode: &Value) -> SeasonEpisode {
    // `episodes[].duration` 是毫秒（实测 2938060 对应 49 分钟），
    // 换算成秒以对齐 `VideoItem::duration`。
    let duration = episode.get("duration").map(as_i64).unwrap_or_default() / 1_000;
    let ep_id = episode
        .get("ep_id")
        .or_else(|| episode.get("id"))
        .map(as_str)
        .unwrap_or_default();
    SeasonEpisode {
        ep_id,
        aid: episode.get("aid").map(as_str).unwrap_or_default(),
        cid: episode.get("cid").map(as_i64).unwrap_or_default(),
        bvid: episode.get("bvid").map(as_str).unwrap_or_default(),
        title: episode.get("title").map(as_str).unwrap_or_default(),
        long_title: episode.get("long_title").map(as_str).unwrap_or_default(),
        cover: video_cover(&episode.get("cover").map(as_str).unwrap_or_default()),
        duration,
        badge: episode
            .get("badge")
            .map(as_str)
            .filter(|badge| !badge.is_empty()),
    }
}

/// 解析相关视频 `data[]`。
///
/// 与热门/分区榜同构（复用 [`video_item`]），但根下直接是数组、没有分页。
pub fn parse_related(raw: &str) -> AppResult<VideoListPage> {
    let root: Value =
        serde_json::from_str(raw).map_err(|e| video_err(format!("相关视频 json: {e}")))?;
    let items = root
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| video_err("相关视频缺少 data 数组"))?
        .iter()
        .map(video_item)
        .collect();
    Ok(VideoListPage {
        has_more: false,
        items,
    })
}

/// 解析视频搜索结果 `data.result[]`。
///
/// 搜索接口返回的结构与热门/推荐略有不同（扁平字段、字符串时长、无 cid），
/// 差异由 [`video_item`] 的回退分支吸收。上游会把同一个稿件重复返回，
/// 这里按 bvid 去重，否则前端网格的 key 会冲突。分页由 `numPages` 与当前页码判断。
pub fn parse_search_videos(raw: &str, page: u32) -> AppResult<VideoListPage> {
    let root: Value =
        serde_json::from_str(raw).map_err(|e| video_err(format!("搜索视频 json: {e}")))?;
    let mut items: Vec<VideoItem> = root
        .pointer("/data/result")
        .and_then(Value::as_array)
        .ok_or_else(|| video_err("搜索视频缺少 data.result"))?
        .iter()
        .filter(|item| item.get("type").map(as_str).as_deref() == Some("video"))
        .map(video_item)
        .filter(|item| !item.bvid.is_empty())
        .collect();
    let mut seen = std::collections::HashSet::new();
    items.retain(|item| seen.insert(item.bvid.clone()));
    let num_pages = root
        .pointer("/data/numPages")
        .and_then(Value::as_u64)
        .unwrap_or(1) as u32;
    Ok(VideoListPage {
        has_more: page < num_pages,
        items,
    })
}

/// 解析 UP 主空间视频列表 `data.list.vlist[]`（WBI 签名接口 `x/space/wbi/arc/search`）。
pub fn parse_uploader_videos(raw: &str) -> AppResult<VideoListPage> {
    let root: Value =
        serde_json::from_str(raw).map_err(|e| video_err(format!("UP 主视频列表 json: {e}")))?;
    let page = root.pointer("/data/page");
    let count = page
        .and_then(|p| p.get("count"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let pn = page
        .and_then(|p| p.get("pn"))
        .and_then(Value::as_u64)
        .unwrap_or(1);
    let ps = page
        .and_then(|p| p.get("ps"))
        .and_then(Value::as_u64)
        .unwrap_or(30);
    let items = root
        .pointer("/data/list/vlist")
        .and_then(Value::as_array)
        .ok_or_else(|| video_err("UP 主视频列表缺少 data.list.vlist"))?
        .iter()
        .map(video_item)
        .filter(|item| !item.bvid.is_empty())
        .collect::<Vec<_>>();
    Ok(VideoListPage {
        has_more: (pn * ps) < count,
        items,
    })
}

/// 解析稿件详情 `data`（WBI 签名接口 `x/web-interface/view`）。
pub fn parse_archive(raw: &str) -> AppResult<VideoArchive> {
    let root: Value =
        serde_json::from_str(raw).map_err(|e| video_err(format!("稿件详情 json: {e}")))?;
    let data = root
        .get("data")
        .ok_or_else(|| video_err("稿件详情缺少 data"))?;
    let owner = data.get("owner");
    let stat = data.get("stat");
    let author_face = owner
        .and_then(|owner| owner.get("face"))
        .map(as_str)
        .map(|face| avatar_thumb(&face))
        .filter(|face| !face.is_empty());
    // 首 P 的 cid：根字段缺失时退回 pages[0]（多 P 稿件两者都有，取 P1 语义一致）。
    let cid = data
        .get("cid")
        .and_then(Value::as_i64)
        .filter(|cid| *cid > 0)
        .or_else(|| {
            data.pointer("/pages/0/cid")
                .and_then(Value::as_i64)
                .filter(|cid| *cid > 0)
        })
        .unwrap_or(0);
    Ok(VideoArchive {
        bvid: data.get("bvid").map(as_str).unwrap_or_default(),
        aid: data.get("aid").map(as_str).unwrap_or_default(),
        cid,
        title: data.get("title").map(as_str).unwrap_or_default(),
        desc: data.get("desc").map(as_str).unwrap_or_default(),
        author: owner
            .and_then(|owner| owner.get("name"))
            .map(as_str)
            .unwrap_or_default(),
        author_face,
        author_mid: owner
            .and_then(|owner| owner.get("mid"))
            .map(as_str)
            .unwrap_or_default(),
        view: stat
            .and_then(|stat| stat.get("view"))
            .map(as_i64)
            .unwrap_or_default(),
        danmaku: stat
            .and_then(|stat| stat.get("danmaku"))
            .map(as_i64)
            .unwrap_or_default(),
        reply: stat
            .and_then(|stat| stat.get("reply"))
            .map(as_i64)
            .unwrap_or_default(),
        pubdate: data.get("pubdate").map(as_i64).unwrap_or_default(),
    })
}

fn comment_emotes(content: &Value) -> Vec<VideoEmote> {
    content
        .get("emote")
        .and_then(Value::as_object)
        .map(|emote| {
            emote
                .values()
                .filter_map(|item| {
                    let text = item.get("text").map(as_str)?;
                    let url = item.get("url").map(as_str)?;
                    (!text.is_empty() && !url.is_empty()).then_some(VideoEmote { text, url })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn comment_pictures(content: &Value) -> Vec<String> {
    content
        .get("pictures")
        .and_then(Value::as_array)
        .map(|pictures| {
            pictures
                .iter()
                .filter_map(|pic| {
                    let src = pic.get("img_src").map(as_str)?;
                    (!src.is_empty()).then(|| video_cover(&src))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 评论与二级回复同构，递归解析；上游预览只嵌一层，但多余层级解析出来也无害。
fn video_comment(item: &Value) -> VideoComment {
    let member = item.get("member");
    let content = item.get("content");
    let avatar = member
        .and_then(|member| member.get("avatar"))
        .or_else(|| member.and_then(|member| member.get("face")))
        .map(as_str)
        .map(|face| avatar_thumb(&face))
        .filter(|face| !face.is_empty());
    VideoComment {
        rpid: item.get("rpid").map(as_i64).unwrap_or_default(),
        mid: member
            .and_then(|member| member.get("mid"))
            .map(as_str)
            .unwrap_or_default(),
        uname: member
            .and_then(|member| member.get("uname"))
            .map(as_str)
            .unwrap_or_default(),
        avatar,
        level: member
            .and_then(|member| member.pointer("/level_info/current_level"))
            .map(as_i64)
            .unwrap_or_default(),
        message: content
            .and_then(|content| content.get("message"))
            .map(as_str)
            .unwrap_or_default(),
        emotes: content.map(comment_emotes).unwrap_or_default(),
        pictures: content.map(comment_pictures).unwrap_or_default(),
        like: item.get("like").map(as_i64).unwrap_or_default(),
        ctime: item.get("ctime").map(as_i64).unwrap_or_default(),
        rcount: item.get("rcount").map(as_i64).unwrap_or_default(),
        replies: item
            .get("replies")
            .and_then(Value::as_array)
            .map(|replies| replies.iter().map(video_comment).collect())
            .unwrap_or_default(),
    }
}

/// 解析评论区（游标接口 `x/v2/reply/wbi/main`）。
///
/// 置顶评论有两处：`data.top_replies[]` 与 `data.top.upper`（UP 主置顶对象，
/// 参考 PiliPlus 的解析），与普通列表合并去重后放在最前；
/// `next` 是下一页游标。匿名请求不得携带 buvid（会被截断），
/// 见 `BilibiliSite::video_comments`。
pub fn parse_comments(raw: &str) -> AppResult<VideoCommentPage> {
    let root: Value =
        serde_json::from_str(raw).map_err(|e| video_err(format!("评论 json: {e}")))?;
    let data = root.get("data").ok_or_else(|| video_err("评论缺少 data"))?;
    let cursor = data.get("cursor");
    let mut items: Vec<VideoComment> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let push_comment = |reply: &Value,
                        items: &mut Vec<VideoComment>,
                        seen: &mut std::collections::HashSet<i64>| {
        let comment = video_comment(reply);
        if comment.rpid > 0 && seen.insert(comment.rpid) {
            items.push(comment);
        }
    };
    if let Some(top_replies) = data.get("top_replies").and_then(Value::as_array) {
        for reply in top_replies {
            push_comment(reply, &mut items, &mut seen);
        }
    }
    // UP 主置顶（`top.upper`）是单个对象，与 `top_replies` 可能只给其一。
    if let Some(upper) = data.pointer("/top/upper").filter(|upper| upper.is_object()) {
        push_comment(upper, &mut items, &mut seen);
    }
    if let Some(replies) = data.get("replies").and_then(Value::as_array) {
        for reply in replies {
            push_comment(reply, &mut items, &mut seen);
        }
    }
    Ok(VideoCommentPage {
        all_count: cursor
            .and_then(|cursor| cursor.get("all_count"))
            .map(as_i64)
            .unwrap_or(items.len() as i64),
        next: cursor
            .and_then(|cursor| cursor.get("next"))
            .map(as_i64)
            .unwrap_or_default(),
        has_more: !cursor
            .and_then(|cursor| cursor.get("is_end"))
            .and_then(Value::as_bool)
            .unwrap_or(true)
            && !items.is_empty(),
        items,
    })
}

/// 解析二级回复（`x/v2/reply/reply`，pn 翻页实测可用）。
pub fn parse_comment_replies(raw: &str, page: u32) -> AppResult<VideoCommentPage> {
    let root: Value =
        serde_json::from_str(raw).map_err(|e| video_err(format!("二级回复 json: {e}")))?;
    let data = root
        .get("data")
        .ok_or_else(|| video_err("二级回复缺少 data"))?;
    let items: Vec<VideoComment> = data
        .get("replies")
        .and_then(Value::as_array)
        .map(|replies| replies.iter().map(video_comment).collect())
        .unwrap_or_default();
    let all_count = data
        .pointer("/page/count")
        .and_then(Value::as_i64)
        .or_else(|| data.pointer("/page/acount").and_then(Value::as_i64))
        .unwrap_or(items.len() as i64);
    Ok(VideoCommentPage {
        all_count,
        next: page as i64,
        // 上游不给 is_end：按「本页取满且未到总数」推导。
        has_more: (page as i64) * COMMENT_REPLIES_PAGE_SIZE < all_count,
        items,
    })
}

/// 二级回复每页条数（与前端哨兵约定一致）。
pub const COMMENT_REPLIES_PAGE_SIZE: i64 = 20;

// ---------------------------------------------------------------------------
// sidx 解析与 MPD 合成
// ---------------------------------------------------------------------------

/// sidx 解出的一个媒体分片。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SidxSegment {
    /// 分片在完整资源中的起始字节（含）。
    pub start_byte: u64,
    /// 结束字节（含），可直接用于 `Range` 与 `mediaRange`。
    pub end_byte: u64,
    /// 起始时刻，单位为 sidx 的 timescale。
    pub t_start: u64,
    /// 结束时刻，同上。
    pub t_end: u64,
}

/// 一个 representation 的完整分片表。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sidx {
    pub timescale: u32,
    pub segments: Vec<SidxSegment>,
}

impl Sidx {
    /// 时间轴总时长，秒。
    pub fn duration_secs(&self) -> f64 {
        match (self.segments.last(), self.timescale) {
            (Some(last), timescale) if timescale > 0 => last.t_end as f64 / f64::from(timescale),
            _ => 0.0,
        }
    }
}

fn be_u16(bytes: &[u8], offset: usize) -> AppResult<u16> {
    bytes
        .get(offset..offset + 2)
        .and_then(|slice| slice.try_into().ok())
        .map(u16::from_be_bytes)
        .ok_or_else(|| video_err("sidx 截断：读取 u16 越界"))
}

fn be_u32(bytes: &[u8], offset: usize) -> AppResult<u32> {
    bytes
        .get(offset..offset + 4)
        .and_then(|slice| slice.try_into().ok())
        .map(u32::from_be_bytes)
        .ok_or_else(|| video_err("sidx 截断：读取 u32 越界"))
}

fn be_u64(bytes: &[u8], offset: usize) -> AppResult<u64> {
    bytes
        .get(offset..offset + 8)
        .and_then(|slice| slice.try_into().ok())
        .map(u64::from_be_bytes)
        .ok_or_else(|| video_err("sidx 截断：读取 u64 越界"))
}

/// 解析 `segment_base.index_range` 取回的 ISO BMFF `sidx` box。
///
/// `xgplayer-dash` 的 MPD 解析器不实现 `SegmentBase`（其 `sidx` 解析模块是空的），
/// 所以分片表必须由我们自己解出来，再合成成插件认得的 `SegmentList`。
///
/// `index_range_end` 是 `index_range` 的结束字节（含）。分片起始位置从
/// `index_range_end + 1 + first_offset` 开始，按各分片大小依次累加。
///
/// 入参是网络数据，每次读取都做边界检查，截断或类型不符一律报错而不是猜测。
pub fn parse_sidx(bytes: &[u8], index_range_end: u64) -> AppResult<Sidx> {
    // box 头：size(4) type(4)。这里只校验类型，长度用实际 buffer 边界兜底。
    let box_type = bytes
        .get(4..8)
        .ok_or_else(|| video_err("sidx 截断：缺少 box 头"))?;
    if box_type != b"sidx" {
        return Err(video_err(format!(
            "index_range 不是 sidx box（实际 type={}）",
            String::from_utf8_lossy(box_type)
        )));
    }
    let version = *bytes
        .get(8)
        .ok_or_else(|| video_err("sidx 截断：缺少 version"))?;
    // version(1) + flags(3)
    let mut offset = 12;
    // reference_id(4) 用不到，直接跳过；timescale 决定后面所有时刻的单位。
    let timescale = be_u32(bytes, offset + 4)?;
    offset += 8;
    let first_offset = match version {
        // version 0：earliest_presentation_time(4) + first_offset(4)
        0 => {
            let value = u64::from(be_u32(bytes, offset + 4)?);
            offset += 8;
            value
        }
        // version 1：两个字段各 8 字节。实测 B 站返回的正是 version 1。
        1 => {
            let value = be_u64(bytes, offset + 8)?;
            offset += 16;
            value
        }
        other => return Err(video_err(format!("不支持的 sidx version={other}"))),
    };
    // reserved(2) + reference_count(2)
    let count = be_u16(bytes, offset + 2)?;
    offset += 4;

    let mut base = index_range_end
        .checked_add(1)
        .and_then(|value| value.checked_add(first_offset))
        .ok_or_else(|| video_err("sidx 分片起始字节溢出"))?;
    let mut time = 0_u64;
    let mut segments = Vec::with_capacity(usize::from(count));
    for index in 0..usize::from(count) {
        let entry = offset + index * 12;
        // 首字段高位是 reference_type，低 31 位才是分片字节数。
        let size = u64::from(be_u32(bytes, entry)? & 0x7fff_ffff);
        let duration = u64::from(be_u32(bytes, entry + 4)?);
        if size == 0 {
            return Err(video_err("sidx 分片长度为 0"));
        }
        let end = base
            .checked_add(size)
            .ok_or_else(|| video_err("sidx 分片字节区间溢出"))?;
        segments.push(SidxSegment {
            start_byte: base,
            end_byte: end - 1,
            t_start: time,
            t_end: time + duration,
        });
        base = end;
        time += duration;
    }
    if segments.is_empty() {
        return Err(video_err("sidx 未包含任何分片"));
    }
    Ok(Sidx {
        timescale,
        segments,
    })
}

/// 合成 MPD 所需的单轨信息。
#[derive(Debug, Clone)]
pub struct VideoTrack {
    /// 上游媒体地址（交给 stream_proxy 做上游）。
    pub base_url: String,
    /// init 段字节区间的结束字节（起始恒为 0）。
    pub init_end: u64,
    pub sidx: Sidx,
    pub codecs: String,
    pub bandwidth: i64,
    pub rep_id: String,
    /// 视频轨专有；音频轨为 `None`。
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub frame_rate: Option<String>,
    pub sar: Option<String>,
    pub start_with_sap: i64,
}

/// 一次播放选中的两条轨与画质信息。
#[derive(Debug, Clone)]
pub struct VideoPlaySelection {
    pub video: VideoTrack,
    pub audio: VideoTrack,
    pub quality: i64,
    pub quality_label: String,
    pub accept_quality: Vec<VideoQuality>,
}

/// XML 属性转义。URL 里的 `&` 必须写成 `&amp;`，否则 MPD 不是合法 XML。
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// 为一条轨输出 `<SegmentList>`。
///
/// 两个不可省的细节：
///
/// 1. 必须用 `SegmentList` 而不是 `SegmentBase`。`xgplayer-dash@3.0.26` 只实现了
///    `SegmentTemplate` 与 `SegmentList`，喂 `SegmentBase` 会解析不出任何分片。
/// 2. 每个 `<SegmentURL>` 的 media 必须是**互不相同**的 URL。插件的下载队列
///    (`es/media/task.js`) 只按 URL 去重：命中已有 URL 就直接 return，连 XHR 都不发。
///    Bilibili 是「一条 URL + 不同 Range」的形态，若所有分片共用同一个地址，
///    除首片外会被全部静默丢弃、播放卡死。这里给每片拼上 `seg=<idx>`，
///    上游会忽略该参数，只用来把 URL 撑开成唯一值。
fn segment_list_xml(track: &VideoTrack, proxy_url: &str) -> String {
    let timescale = f64::from(track.sidx.timescale.max(1));
    let first = track.sidx.segments[0];
    let segment_millis = ((first.t_end - first.t_start) as f64 / timescale * 1000.0).round() as i64;
    let joiner = if proxy_url.contains('?') { '&' } else { '?' };

    let mut xml = format!(r#"<SegmentList timescale="1000" duration="{segment_millis}">"#);
    xml.push_str(&format!(
        r#"<Initialization sourceURL="{}" range="0-{}"/>"#,
        xml_escape(&format!("{proxy_url}{joiner}seg=init")),
        track.init_end
    ));
    for (index, segment) in track.sidx.segments.iter().enumerate() {
        xml.push_str(&format!(
            r#"<SegmentURL media="{}" mediaRange="{}-{}"/>"#,
            xml_escape(&format!("{proxy_url}{joiner}seg={index}")),
            segment.start_byte,
            segment.end_byte
        ));
    }
    xml.push_str("</SegmentList>");
    xml
}

/// 用两条轨的本机代理地址合成 MPD。
///
/// 清单本身也必须由 HTTP 提供：插件取 MPD 的 XHR 会给地址拼 `?`，
/// `blob:` URL 走精确匹配因此 404。
pub fn build_mpd(
    selection: &VideoPlaySelection,
    video_proxy_url: &str,
    audio_proxy_url: &str,
) -> String {
    let video = &selection.video;
    let audio = &selection.audio;
    // 时长取视频轨 sidx 时间轴，与分片表严格一致；用列表接口的整数秒会与
    // 分片累加值差出小数，尾片可能被播放器判成越界。
    let duration = video.sidx.duration_secs();
    let width = video.width.unwrap_or_default();
    let height = video.height.unwrap_or_default();
    let frame_rate = xml_escape(video.frame_rate.as_deref().unwrap_or("25"));
    let sar = xml_escape(video.sar.as_deref().unwrap_or("1:1"));

    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT{duration}S" minBufferTime="PT1.5S">
  <Period duration="PT{duration}S">
    <AdaptationSet mimeType="video/mp4">
      <Representation id="{video_id}" mimeType="video/mp4" codecs="{video_codecs}" width="{width}" height="{height}" frameRate="{frame_rate}" sar="{sar}" startWithSAP="{video_sap}" bandwidth="{video_bandwidth}">
        {video_segments}
      </Representation>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4">
      <Representation id="{audio_id}" mimeType="audio/mp4" codecs="{audio_codecs}" startWithSAP="{audio_sap}" bandwidth="{audio_bandwidth}">
        {audio_segments}
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>"#,
        video_id = xml_escape(&video.rep_id),
        video_codecs = xml_escape(&video.codecs),
        video_sap = video.start_with_sap,
        video_bandwidth = video.bandwidth,
        video_segments = segment_list_xml(video, video_proxy_url),
        audio_id = xml_escape(&audio.rep_id),
        audio_codecs = xml_escape(&audio.codecs),
        audio_sap = audio.start_with_sap,
        audio_bandwidth = audio.bandwidth,
        audio_segments = segment_list_xml(audio, audio_proxy_url),
    )
}

// ---------------------------------------------------------------------------
// VOD 弹幕：seg.so protobuf
// ---------------------------------------------------------------------------

/// 段号：6 分钟一段，从 1 开始。
pub fn danmaku_segment_index(position_millis: i64) -> i64 {
    position_millis.max(0) / DANMAKU_SEGMENT_MILLIS + 1
}

/// 解码 `DmSegMobileReply`。
///
/// 手写解码而不引 protobuf 运行时：只需要读一层嵌套里的 7 个标量字段，
/// 为此拉入代码生成与运行时依赖并不划算。
///
/// 解码器必须**跳过未知字段**：实测单条 elem 会出现 13/20/21 等 schema 之外的
/// 字段，上游随时可能再加。遇到不认识的编号就按 wire type 跳过，
/// 否则每次上游扩展字段都会让弹幕整段解析失败。
pub fn decode_danmaku_segment(bytes: &[u8]) -> AppResult<Vec<DanmakuItem>> {
    let mut reader = ProtoReader::new(bytes);
    let mut items = Vec::new();
    while let Some((field, value)) = reader
        .next_field()
        .map_err(|e| video_err(format!("弹幕 protobuf: {e}")))?
    {
        // 顶层只关心 elems = 1；state / ai_flag / segment_rules 等一律跳过。
        if let (1, ProtoValue::Bytes(elem)) = (field, value)
            && let Some(item) = decode_danmaku_elem(elem)?
        {
            items.push(item);
        }
    }
    Ok(items)
}

fn decode_danmaku_elem(bytes: &[u8]) -> AppResult<Option<DanmakuItem>> {
    let mut reader = ProtoReader::new(bytes);
    let mut progress = 0_i64;
    let mut mode = 0_i32;
    let mut fontsize = 0_i32;
    let mut color = 0_u32;
    let mut content = String::new();
    let mut weight = 0_i32;
    let mut pool = 0_i32;
    while let Some((field, value)) = reader
        .next_field()
        .map_err(|e| video_err(format!("弹幕 elem protobuf: {e}")))?
    {
        match (field, value) {
            // 实测有约 1% 的弹幕省略 progress（proto3 省略零值），按 0 处理。
            (2, ProtoValue::Varint(raw)) => progress = raw as i64,
            (3, ProtoValue::Varint(raw)) => mode = raw as i32,
            (4, ProtoValue::Varint(raw)) => fontsize = raw as i32,
            (5, ProtoValue::Varint(raw)) => color = u32::try_from(raw).unwrap_or(0xff_ffff),
            (7, ProtoValue::Bytes(raw)) => {
                content = String::from_utf8_lossy(raw)
                    .chars()
                    .take(MAX_DANMAKU_CONTENT)
                    .collect();
            }
            (9, ProtoValue::Varint(raw)) => weight = raw as i32,
            (11, ProtoValue::Varint(raw)) => pool = raw as i32,
            _ => {}
        }
    }
    let content = content.trim().to_string();
    if content.is_empty() {
        return Ok(None);
    }
    Ok(Some(DanmakuItem {
        progress,
        // 上游省略这两个字段时按普通滚动弹幕与默认字号渲染，
        // 而不是用 0 —— 0 号模式不存在，0 字号会渲染成看不见的弹幕。
        mode: if mode == 0 { 1 } else { mode },
        fontsize: if fontsize == 0 { 25 } else { fontsize },
        color: if color == 0 { 0xff_ffff } else { color },
        content,
        weight,
        pool,
    }))
}

// ---------------------------------------------------------------------------
// 选流
// ---------------------------------------------------------------------------

/// 从 playurl 的 dash 负载中挑出一条视频轨与一条音频轨。
///
/// `accept_quality` 列出的是稿件存在的全部档位，而当前身份能实际取到的只有
/// `dash.video[]` 里出现的那些（实测匿名最高 480P）。因此可用性以实际返回的
/// representation 为准，`accept_quality` 只用来给出档位名称。
fn select_streams(
    data: &Value,
    request: &VideoPlayRequest,
) -> AppResult<(Value, Value, i64, String, Vec<VideoQuality>)> {
    // PGC 付费墙：非免费分集匿名只给试看 MP4（is_preview=1、error_code=-10403），
    // 没有可解析的 DASH。把上游状态透进报错，用户能看出「需要登录或大会员」
    // 而不是以为客户端坏了。
    let missing_dash_hint = match data.get("is_preview").and_then(Value::as_i64) {
        Some(1) => "该分集需要登录或大会员（当前身份只有试看片段，无 DASH 流）",
        _ => "playurl 缺少 dash（该稿件可能不支持 DASH 或受限）",
    };
    let dash = data
        .get("dash")
        .ok_or_else(|| video_err(missing_dash_hint))?;
    let videos = dash
        .get("video")
        .and_then(Value::as_array)
        .filter(|videos| !videos.is_empty())
        .ok_or_else(|| video_err("playurl 缺少可用视频流"))?;
    let audios = dash
        .get("audio")
        .and_then(Value::as_array)
        .filter(|audios| !audios.is_empty())
        .ok_or_else(|| video_err("playurl 缺少可用音频流"))?;

    let codec = request.codec.as_deref().unwrap_or(DEFAULT_CODEC);
    // representation 的 `id` 就是该档位的 qn。
    let available: std::collections::BTreeSet<i64> = videos
        .iter()
        .map(|rep| as_i64(rep.get("id").unwrap_or(&Value::Null)))
        .collect();
    let accept_quality = data
        .get("accept_quality")
        .and_then(Value::as_array)
        .map(|list| {
            let labels = data.get("accept_description").and_then(Value::as_array);
            list.iter()
                .enumerate()
                .map(|(index, qn)| {
                    let qn = as_i64(qn);
                    let label = labels
                        .and_then(|labels| labels.get(index))
                        .map(as_str)
                        .filter(|label| !label.is_empty())
                        .unwrap_or_else(|| format!("qn {qn}"));
                    VideoQuality {
                        qn,
                        label,
                        available: available.contains(&qn),
                    }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    // 先按请求画质与编码筛，逐步放宽：编码匹配的目标画质 → 目标画质任意编码
    // → 编码匹配的最高画质 → 任意最高画质。任何一步都不返回空。
    let pick = |quality: Option<i64>, codec: Option<&str>| -> Option<&Value> {
        videos
            .iter()
            .filter(|rep| {
                quality.is_none_or(|qn| as_i64(rep.get("id").unwrap_or(&Value::Null)) == qn)
            })
            .filter(|rep| {
                codec.is_none_or(|codec| {
                    rep.get("codecs")
                        .map(as_str)
                        .unwrap_or_default()
                        .starts_with(codec)
                })
            })
            .max_by_key(|rep| as_i64(rep.get("bandwidth").unwrap_or(&Value::Null)))
    };
    let video = pick(request.qn, Some(codec))
        .or_else(|| pick(request.qn, None))
        .or_else(|| pick(None, Some(codec)))
        .or_else(|| pick(None, None))
        .ok_or_else(|| video_err("没有可用的视频流"))?;
    let audio = audios
        .iter()
        .max_by_key(|rep| as_i64(rep.get("bandwidth").unwrap_or(&Value::Null)))
        .ok_or_else(|| video_err("没有可用的音频流"))?;

    let quality = as_i64(video.get("id").unwrap_or(&Value::Null));
    let quality_label = accept_quality
        .iter()
        .find(|candidate| candidate.qn == quality)
        .map(|candidate| candidate.label.clone())
        .unwrap_or_else(|| format!("qn {quality}"));
    Ok((
        video.clone(),
        audio.clone(),
        quality,
        quality_label,
        accept_quality,
    ))
}

fn segment_base_ranges(rep: &Value) -> AppResult<(u64, u64, u64)> {
    let base = rep
        .get("segment_base")
        .ok_or_else(|| video_err("representation 缺少 segment_base"))?;
    let parse_range = |key: &str| -> AppResult<(u64, u64)> {
        let raw = base
            .get(key)
            .map(as_str)
            .ok_or_else(|| video_err(format!("segment_base 缺少 {key}")))?;
        let (start, end) = raw
            .split_once('-')
            .ok_or_else(|| video_err(format!("segment_base.{key} 格式异常: {raw}")))?;
        Ok((
            start
                .trim()
                .parse()
                .map_err(|_| video_err(format!("{key} 起始非数字")))?,
            end.trim()
                .parse()
                .map_err(|_| video_err(format!("{key} 结束非数字")))?,
        ))
    };
    let (_, init_end) = parse_range("initialization")?;
    let (index_start, index_end) = parse_range("index_range")?;
    Ok((init_end, index_start, index_end))
}

// ---------------------------------------------------------------------------
// BilibiliSite 上的 VOD 方法
// ---------------------------------------------------------------------------

/// UGC 分区榜 rid（上游没有对应接口，参考实现同样硬编码）。
pub const VIDEO_ZONES: &[(&str, i64)] = &[
    ("全站", 0),
    ("动画", 1005),
    ("音乐", 1003),
    ("舞蹈", 1004),
    ("游戏", 1008),
    ("知识", 1010),
    ("科技", 1012),
    ("运动", 1018),
    ("汽车", 1013),
    ("美食", 1020),
    ("动物", 1024),
    ("鬼畜", 1007),
    ("时尚", 1014),
    ("娱乐", 1002),
    ("影视", 1001),
];

impl BilibiliSite {
    /// 首页推荐流。
    ///
    /// 有 cookie 才是个性化流，匿名返回通用流。`fresh_idx`/`brush` 跟着页码走，
    /// 上游据此吐出不重复的下一刷。
    pub async fn video_recommend(&self, page: u32, page_size: u32) -> AppResult<VideoListPage> {
        let page = page.max(1);
        let mut params = BTreeMap::new();
        params.insert("version".into(), "1".into());
        params.insert("feed_version".into(), "V8".into());
        params.insert("homepage_ver".into(), "1".into());
        params.insert("ps".into(), page_size.clamp(1, 30).to_string());
        params.insert("fresh_idx".into(), page.to_string());
        params.insert("brush".into(), page.to_string());
        params.insert("fresh_type".into(), "4".into());
        let text = self
            .get_json_signed(
                "https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd",
                params,
            )
            .await?;
        parse_recommend(&text)
    }

    /// 热门。该接口不需要 WBI，匿名可用。
    pub async fn video_popular(&self, page: u32, page_size: u32) -> AppResult<VideoListPage> {
        let text = self
            .get_json(
                "https://api.bilibili.com/x/web-interface/popular",
                &[
                    ("pn", page.max(1).to_string()),
                    ("ps", page_size.clamp(1, 50).to_string()),
                ],
            )
            .await?;
        parse_popular(&text)
    }

    /// UGC 分区榜。需要 WBI，匿名可用；一次返回整张榜，没有翻页。
    pub async fn video_zone(&self, rid: i64) -> AppResult<VideoListPage> {
        let mut params = BTreeMap::new();
        params.insert("rid".into(), rid.to_string());
        params.insert("type".into(), "all".into());
        let text = self
            .get_json_signed(
                "https://api.bilibili.com/x/web-interface/ranking/v2",
                params,
            )
            .await?;
        parse_zone(&text)
    }

    /// PGC 索引：番剧（`index_type` 为 `None`）与影视（`Some(102)`）。
    ///
    /// 除 `index_type` 外两者参数完全一致，因此共用一个方法；
    /// 未使用的筛选位必须显式传 `-1`，省略会被上游当成非法组合。
    pub async fn video_pgc_index(
        &self,
        season_type: i64,
        index_type: Option<i64>,
        page: u32,
    ) -> AppResult<PgcListPage> {
        let mut query = vec![
            ("st", season_type.to_string()),
            ("season_type", season_type.to_string()),
            ("order", "3".to_string()),
            ("sort", "0".to_string()),
            ("pagesize", "20".to_string()),
            ("type", "1".to_string()),
            ("page", page.max(1).to_string()),
        ];
        for key in [
            "season_version",
            "spoken_language_type",
            "area",
            "is_finish",
            "copyright",
            "season_status",
            "season_month",
            "year",
            "style_id",
            "producer_id",
            "is_hd",
        ] {
            query.push((key, "-1".to_string()));
        }
        if let Some(index_type) = index_type {
            query.push(("index_type", index_type.to_string()));
        }
        let text = self
            .get_json("https://api.bilibili.com/pgc/season/index/result", &query)
            .await?;
        parse_pgc_index(&text)
    }

    /// PGC 排行榜。番剧与其他 season_type 走不同端点，响应结构相同。
    pub async fn video_pgc_zone(&self, season_type: i64) -> AppResult<PgcListPage> {
        let url = if season_type == 1 {
            "https://api.bilibili.com/pgc/web/rank/list"
        } else {
            "https://api.bilibili.com/pgc/season/rank/web/list"
        };
        let text = self
            .get_json(
                url,
                &[
                    ("day", "3".to_string()),
                    ("season_type", season_type.to_string()),
                ],
            )
            .await?;
        parse_pgc_rank(&text)
    }

    /// season 详情。`season_id` 与 `ep_id` 至少给一个。
    pub async fn video_season(
        &self,
        season_id: Option<&str>,
        ep_id: Option<&str>,
    ) -> AppResult<VideoSeason> {
        let query = match (season_id, ep_id) {
            (Some(season_id), _) if !season_id.is_empty() => {
                vec![("season_id", season_id.to_string())]
            }
            (_, Some(ep_id)) if !ep_id.is_empty() => vec![("ep_id", ep_id.to_string())],
            _ => return Err(video_err("season 查询缺少 season_id 与 ep_id")),
        };
        let text = self
            .get_json("https://api.bilibili.com/pgc/view/web/season", &query)
            .await?;
        parse_season(&text)
    }

    /// 相关视频（`archive/related`）。匿名可用，无需 WBI。
    pub async fn video_related(&self, bvid: &str) -> AppResult<VideoListPage> {
        if bvid.is_empty() {
            return Err(video_err("相关视频缺少 bvid"));
        }
        let text = self
            .get_json(
                "https://api.bilibili.com/x/web-interface/archive/related",
                &[("bvid", bvid.to_string())],
            )
            .await?;
        parse_related(&text)
    }

    /// 搜索视频（`x/web-interface/search/type`）。
    ///
    /// 关键词搜索，支持分页。与直播搜索复用同一接口，只是 `search_type` 不同。
    pub async fn video_search(&self, keyword: &str, page: u32) -> AppResult<VideoListPage> {
        if keyword.is_empty() {
            return Err(video_err("搜索缺少关键词"));
        }
        let text = self
            .get_json(
                "https://api.bilibili.com/x/web-interface/search/type",
                &[
                    ("search_type", "video".into()),
                    ("keyword", keyword.into()),
                    ("page", page.to_string()),
                    ("order", "".into()),
                    ("duration", "0".into()),
                    ("tids", "0".into()),
                ],
            )
            .await?;
        parse_search_videos(&text, page)
    }

    /// UP 主空间视频列表（`x/space/wbi/arc/search`）。
    ///
    /// 获取指定 UP 主的投稿视频，支持分页。需要 WBI 签名。
    pub async fn video_uploader_videos(&self, mid: &str, page: u32) -> AppResult<VideoListPage> {
        if mid.is_empty() {
            return Err(video_err("UP 主视频列表缺少 mid"));
        }
        let mut params = BTreeMap::new();
        params.insert("mid".into(), mid.to_string());
        params.insert("ps".into(), "30".to_string());
        params.insert("tid".into(), "0".into());
        params.insert("pn".into(), page.max(1).to_string());
        params.insert("keyword".into(), "".into());
        params.insert("order".into(), "pubdate".into());
        let text = self
            .get_json_signed(
                "https://api.bilibili.com/x/space/wbi/arc/search",
                params,
            )
            .await?;
        parse_uploader_videos(&text)
    }

    /// 稿件详情（`x/web-interface/view`）。WBI 签名接口，未签名会被风控拦下。
    pub async fn video_archive(&self, bvid: &str) -> AppResult<VideoArchive> {
        if bvid.is_empty() {
            return Err(video_err("稿件详情缺少 bvid"));
        }
        let mut params = BTreeMap::new();
        params.insert("bvid".into(), bvid.to_string());
        let text = self
            .get_json_signed("https://api.bilibili.com/x/web-interface/view", params)
            .await?;
        parse_archive(&text)
    }

    /// 评论首页（`x/v2/reply/main`，游标翻页）。匿名可用。
    ///
    /// `mode`：2 按时间、3 按热度；`next` 首次传 0，之后传上一页返回的游标。
    pub async fn video_comments(
        &self,
        aid: &str,
        mode: u8,
        next: i64,
    ) -> AppResult<VideoCommentPage> {
        if aid.is_empty() {
            return Err(video_err("评论缺少 aid"));
        }
        // 实测：该接口对「携带 buvid3/buvid4 的匿名会话」只回 3 条左右并谎称
        // is_end=true；未签名的裸路径在被风控盯上后一律 -352。与网页一致的
        // `/wbi/main` + 签名路径两者都回避：匿名走无 cookie 的签名请求（get_public_json_signed），
        // 登录态带完整 cookie（get_json_signed）。
        let mut params = BTreeMap::new();
        params.insert("type".into(), "1".into());
        params.insert("oid".into(), aid.to_string());
        params.insert("mode".into(), mode.clamp(2, 3).to_string());
        params.insert("ps".into(), "20".into());
        params.insert("next".into(), next.max(0).to_string());
        let url = "https://api.bilibili.com/x/v2/reply/wbi/main";
        let text = if self.cookie.contains("SESSDATA") {
            self.get_json_signed(url, params).await?
        } else {
            self.get_public_json_signed(url, params).await?
        };
        parse_comments(&text)
    }

    /// 二级回复（`x/v2/reply/reply`，pn 翻页）。匿名可用。
    pub async fn video_comment_replies(
        &self,
        aid: &str,
        root: i64,
        page: u32,
    ) -> AppResult<VideoCommentPage> {
        if aid.is_empty() {
            return Err(video_err("二级回复缺少 aid"));
        }
        if root <= 0 {
            return Err(video_err("二级回复缺少 root"));
        }
        let text = self
            .get_json(
                "https://api.bilibili.com/x/v2/reply/reply",
                &[
                    ("type", "1".to_string()),
                    ("oid", aid.to_string()),
                    ("root", root.to_string()),
                    ("pn", page.max(1).to_string()),
                    ("ps", COMMENT_REPLIES_PAGE_SIZE.to_string()),
                    ("sort", "2".to_string()),
                ],
            )
            .await?;
        parse_comment_replies(&text, page.max(1))
    }

    /// 取 playurl 并解出两条轨的完整分片表。
    ///
    /// UGC 与 PGC 是两条链路：端点不同、响应层级不同（PGC 的负载在
    /// `result.video_info`），但 dash 内部结构一致，所以只在这里分叉一次。
    pub async fn video_play_selection(
        &self,
        request: &VideoPlayRequest,
    ) -> AppResult<VideoPlaySelection> {
        if request.cid <= 0 {
            return Err(video_err("播放请求缺少 cid"));
        }
        let mut params = BTreeMap::new();
        params.insert("cid".into(), request.cid.to_string());
        params.insert("qn".into(), request.qn.unwrap_or(112).to_string());
        params.insert("fnval".into(), "4048".into());
        params.insert("fourk".into(), "1".into());
        params.insert("fnver".into(), "0".into());

        let data = match request.ep_id.as_deref().filter(|id| !id.is_empty()) {
            Some(ep_id) => {
                params.insert("ep_id".into(), ep_id.to_string());
                params.insert("support_multi_audio".into(), "true".into());
                let text = self
                    .get_json_signed("https://api.bilibili.com/pgc/player/web/v2/playurl", params)
                    .await?;
                let root: Value = serde_json::from_str(&text)
                    .map_err(|e| video_err(format!("PGC playurl json: {e}")))?;
                root.pointer("/result/video_info").cloned().ok_or_else(|| {
                    video_err("PGC playurl 缺少 result.video_info（可能受版权或地区限制）")
                })?
            }
            None => {
                let bvid = request
                    .bvid
                    .as_deref()
                    .filter(|bvid| !bvid.is_empty())
                    .ok_or_else(|| video_err("UGC 播放请求缺少 bvid"))?;
                params.insert("bvid".into(), bvid.to_string());
                params.insert("try_look".into(), "1".into());
                params.insert("web_location".into(), "1315873".into());
                let text = self
                    .get_json_signed("https://api.bilibili.com/x/player/wbi/playurl", params)
                    .await?;
                let root: Value = serde_json::from_str(&text)
                    .map_err(|e| video_err(format!("UGC playurl json: {e}")))?;
                root.get("data")
                    .cloned()
                    .ok_or_else(|| video_err("UGC playurl 缺少 data"))?
            }
        };

        let (video, audio, quality, quality_label, accept_quality) =
            select_streams(&data, request)?;
        let video = self.video_track(&video, true).await?;
        let audio = self.video_track(&audio, false).await?;
        Ok(VideoPlaySelection {
            video,
            audio,
            quality,
            quality_label,
            accept_quality,
        })
    }

    /// 抓一条轨的 sidx 并组装成 [`VideoTrack`]。
    ///
    /// 地址按 [`stream_candidates`] 的顺序逐个尝试，首个能返回 sidx 的成为该轨
    /// 的上游地址（代理转发与 sidx 预抓共用它）；全部失败时抛最后一个错误。
    async fn video_track(&self, rep: &Value, is_video: bool) -> AppResult<VideoTrack> {
        let candidates = stream_candidates(rep);
        if candidates.is_empty() {
            return Err(video_err("representation 缺少 base_url"));
        }
        let (init_end, index_start, index_end) = segment_base_ranges(rep)?;
        let mut last_error = video_err("representation 缺少 base_url");
        for candidate in &candidates {
            let sidx_bytes = match self.fetch_range(candidate, index_start, index_end).await {
                Ok(bytes) => bytes,
                Err(error) => {
                    last_error = error;
                    continue;
                }
            };
            let sidx = parse_sidx(&sidx_bytes, index_end)?;
            return Ok(VideoTrack {
                base_url: candidate.clone(),
                init_end,
                sidx,
                codecs: rep.get("codecs").map(as_str).unwrap_or_default(),
                bandwidth: rep.get("bandwidth").map(as_i64).unwrap_or_default(),
                rep_id: rep.get("id").map(as_str).unwrap_or_default(),
                width: is_video.then(|| rep.get("width").map(as_i64).unwrap_or_default()),
                height: is_video.then(|| rep.get("height").map(as_i64).unwrap_or_default()),
                frame_rate: is_video.then(|| {
                    rep.get("frame_rate")
                        .or_else(|| rep.get("frameRate"))
                        .map(as_str)
                        .unwrap_or_default()
                }),
                sar: is_video.then(|| rep.get("sar").map(as_str).unwrap_or_default()),
                start_with_sap: rep
                    .get("start_with_sap")
                    .or_else(|| rep.get("startWithSap"))
                    .map(as_i64)
                    .unwrap_or(1),
            });
        }
        Err(last_error)
    }

    /// 对媒体 URL 发一次 Range 请求。
    ///
    /// 不走 `get_json_request`：那层会解 JSON 并校验 `code`，而这里要的是裸字节。
    /// Referer 必须用站点域名，媒体 CDN 有一部分主机在缺少它时直接 403。
    async fn fetch_range(&self, url: &str, start: u64, end: u64) -> AppResult<Vec<u8>> {
        let response = self
            .client
            .get(url)
            .header("user-agent", DEFAULT_USER_AGENT)
            .header("referer", VIDEO_REFERER)
            .header("range", format!("bytes={start}-{end}"))
            .send()
            .await
            .map_err(|e| video_err(format!("媒体 Range 请求失败: {e}")).retryable())?;
        if !response.status().is_success() {
            return Err(video_err(format!(
                "媒体 Range 请求返回 HTTP {}",
                response.status().as_u16()
            ))
            .retryable());
        }
        Ok(response
            .bytes()
            .await
            .map_err(|e| video_err(format!("媒体 Range 响应读取失败: {e}")).retryable())?
            .to_vec())
    }

    /// 取一段 VOD 弹幕。
    ///
    /// 该接口无需 cookie / WBI，返回裸 protobuf，并且用 **HTTP 304** 表示段号越界。
    /// 因此不能走 `get_json_request`：那层要求 body 是 JSON 且 `code == 0`，
    /// 会把正常的结束信号当成错误。
    ///
    /// `pid`（aid）实测传对、传错、不传的响应完全一致，故省略。
    pub async fn video_danmaku(
        &self,
        cid: i64,
        segment_index: i64,
    ) -> AppResult<VideoDanmakuSegment> {
        if cid <= 0 {
            return Err(video_err("弹幕请求缺少 cid"));
        }
        let response = self
            .client
            .get("https://api.bilibili.com/x/v2/dm/web/seg.so")
            .header("user-agent", DEFAULT_USER_AGENT)
            .header("referer", VIDEO_REFERER)
            .query(&[
                ("type", "1".to_string()),
                ("oid", cid.to_string()),
                ("segment_index", segment_index.max(1).to_string()),
            ])
            .send()
            .await
            .map_err(|e| video_err(format!("弹幕请求失败: {e}")).retryable())?;

        // 304 = 段号越界，是遍历的正常终点。上游同时会带 `bili-status-code: -304`，
        // 但该头并非每次都出现（实测有仅 304 无该头的应答），所以只认状态码。
        if response.status().as_u16() == 304 {
            return Ok(VideoDanmakuSegment {
                has_more: false,
                items: Vec::new(),
            });
        }
        if !response.status().is_success() {
            return Err(
                video_err(format!("弹幕接口返回 HTTP {}", response.status().as_u16())).retryable(),
            );
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|e| video_err(format!("弹幕响应读取失败: {e}")).retryable())?;
        let items = decode_danmaku_segment(&bytes)?;
        // 空 body 不代表结束：正常段也可能没有弹幕。只有 304 才是停止条件。
        Ok(VideoDanmakuSegment {
            has_more: true,
            items,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造一个 sidx box。`version` 决定 earliest_pts / first_offset 的宽度。
    fn build_sidx(
        version: u8,
        timescale: u32,
        first_offset: u64,
        entries: &[(u32, u32)],
    ) -> Vec<u8> {
        let mut body = Vec::new();
        body.extend_from_slice(&[0, 0, 0, 0]); // size 占位
        body.extend_from_slice(b"sidx");
        body.push(version);
        body.extend_from_slice(&[0, 0, 0]); // flags
        body.extend_from_slice(&1_u32.to_be_bytes()); // reference_id
        body.extend_from_slice(&timescale.to_be_bytes());
        if version == 0 {
            body.extend_from_slice(&0_u32.to_be_bytes()); // earliest_pts
            body.extend_from_slice(&(first_offset as u32).to_be_bytes());
        } else {
            body.extend_from_slice(&0_u64.to_be_bytes());
            body.extend_from_slice(&first_offset.to_be_bytes());
        }
        body.extend_from_slice(&0_u16.to_be_bytes()); // reserved
        body.extend_from_slice(&(entries.len() as u16).to_be_bytes());
        for (size, duration) in entries {
            // 最高位是 reference_type，置 0 表示媒体分片。
            body.extend_from_slice(&size.to_be_bytes());
            body.extend_from_slice(&duration.to_be_bytes());
            body.extend_from_slice(&0x9000_0000_u32.to_be_bytes()); // SAP
        }
        let len = body.len() as u32;
        body[..4].copy_from_slice(&len.to_be_bytes());
        body
    }

    #[test]
    fn sidx_v1_yields_contiguous_byte_and_time_ranges() {
        // 对齐实测形态：version 1、timescale 16000、5s 一片。
        let bytes = build_sidx(
            1,
            16_000,
            0,
            &[(435_496, 80_000), (434_880, 80_000), (200_000, 40_000)],
        );
        let sidx = parse_sidx(&bytes, 1601).expect("sidx 应解析成功");

        assert_eq!(sidx.timescale, 16_000);
        assert_eq!(sidx.segments.len(), 3);
        // 首片起始 = index_range_end + 1 + first_offset。
        assert_eq!(sidx.segments[0].start_byte, 1602);
        assert_eq!(sidx.segments[0].end_byte, 1602 + 435_496 - 1);
        // 字节区间必须首尾相接，不留空洞也不重叠。
        assert_eq!(sidx.segments[1].start_byte, sidx.segments[0].end_byte + 1);
        assert_eq!(sidx.segments[2].start_byte, sidx.segments[1].end_byte + 1);
        // 时间轴同样累加。
        assert_eq!(
            (sidx.segments[0].t_start, sidx.segments[0].t_end),
            (0, 80_000)
        );
        assert_eq!(
            (sidx.segments[1].t_start, sidx.segments[1].t_end),
            (80_000, 160_000)
        );
        assert_eq!(
            (sidx.segments[2].t_start, sidx.segments[2].t_end),
            (160_000, 200_000)
        );
        assert_eq!(sidx.duration_secs(), 12.5);
    }

    #[test]
    fn sidx_v0_uses_32_bit_header_fields_and_honours_first_offset() {
        let bytes = build_sidx(0, 1_000, 16, &[(100, 500), (200, 500)]);
        let sidx = parse_sidx(&bytes, 999).expect("sidx v0 应解析成功");
        // first_offset 必须计入首片起始：1000 + 16。
        assert_eq!(sidx.segments[0].start_byte, 1016);
        assert_eq!(sidx.segments[0].end_byte, 1115);
        assert_eq!(sidx.segments[1].start_byte, 1116);
        assert_eq!(sidx.duration_secs(), 1.0);
    }

    #[test]
    fn sidx_rejects_wrong_box_type_and_truncation() {
        let mut wrong = build_sidx(1, 16_000, 0, &[(10, 10)]);
        wrong[4..8].copy_from_slice(b"moof");
        assert!(parse_sidx(&wrong, 0).is_err(), "非 sidx box 必须报错");

        let full = build_sidx(1, 16_000, 0, &[(10, 10), (20, 10)]);
        // 砍掉最后一条 reference，越界读取必须被边界检查拦住。
        assert!(
            parse_sidx(&full[..full.len() - 6], 0).is_err(),
            "截断必须报错"
        );
        assert!(parse_sidx(b"sid", 0).is_err(), "过短输入必须报错");
    }

    fn track_fixture() -> VideoTrack {
        VideoTrack {
            base_url: "https://upos.example.com/media.m4s".into(),
            init_end: 937,
            sidx: Sidx {
                timescale: 16_000,
                segments: vec![
                    SidxSegment {
                        start_byte: 1602,
                        end_byte: 2000,
                        t_start: 0,
                        t_end: 80_000,
                    },
                    SidxSegment {
                        start_byte: 2001,
                        end_byte: 3000,
                        t_start: 80_000,
                        t_end: 160_000,
                    },
                ],
            },
            codecs: "avc1.640033".into(),
            bandwidth: 631_556,
            rep_id: "32".into(),
            width: Some(854),
            height: Some(480),
            frame_rate: Some("30.000".into()),
            sar: Some("3844:3843".into()),
            start_with_sap: 1,
        }
    }

    #[test]
    fn mpd_uses_segment_list_with_unique_urls_per_segment() {
        let mut audio = track_fixture();
        audio.codecs = "mp4a.40.2".into();
        audio.rep_id = "30232".into();
        audio.width = None;
        audio.height = None;
        audio.frame_rate = None;
        audio.sar = None;
        let selection = VideoPlaySelection {
            video: track_fixture(),
            audio,
            quality: 32,
            quality_label: "清晰 480P".into(),
            accept_quality: Vec::new(),
        };

        let mpd = build_mpd(
            &selection,
            "http://127.0.0.1:5001/live",
            "http://127.0.0.1:5002/live",
        );

        // 插件不认 SegmentBase，只实现了 SegmentTemplate / SegmentList。
        assert!(mpd.contains("<SegmentList"), "必须输出 SegmentList");
        assert!(!mpd.contains("SegmentBase"), "不得输出 SegmentBase");
        assert!(mpd.contains(
            r#"<Initialization sourceURL="http://127.0.0.1:5001/live?seg=init" range="0-937"/>"#
        ));
        // 每片 URL 必须唯一，否则插件的 Task 队列按 URL 去重会丢掉除首片外的全部分片。
        assert!(mpd.contains(r#"media="http://127.0.0.1:5001/live?seg=0" mediaRange="1602-2000""#));
        assert!(mpd.contains(r#"media="http://127.0.0.1:5001/live?seg=1" mediaRange="2001-3000""#));
        assert!(mpd.contains(r#"media="http://127.0.0.1:5002/live?seg=1" mediaRange="2001-3000""#));
        // 分片时长按单片给出（5s → 5000ms）。
        assert!(mpd.contains(r#"<SegmentList timescale="1000" duration="5000">"#));
        // 时长取 sidx 时间轴：160000/16000 = 10s。
        assert!(mpd.contains(r#"mediaPresentationDuration="PT10S""#));
        assert!(mpd.contains(r#"codecs="avc1.640033""#));
        assert!(mpd.contains(r#"codecs="mp4a.40.2""#));
    }

    #[test]
    fn mpd_escapes_xml_and_appends_to_existing_query() {
        let selection = VideoPlaySelection {
            video: track_fixture(),
            audio: track_fixture(),
            quality: 32,
            quality_label: "清晰 480P".into(),
            accept_quality: Vec::new(),
        };
        let mpd = build_mpd(
            &selection,
            "http://127.0.0.1:5001/live?x=1",
            "http://127.0.0.1:5002/live",
        );
        // 已有 query 时用 `&`，且必须转义成 `&amp;` 才是合法 XML。
        assert!(mpd.contains("http://127.0.0.1:5001/live?x=1&amp;seg=0"));
        assert!(
            !mpd.contains("live?x=1&seg=0"),
            "裸 & 会让 MPD 不是合法 XML"
        );
    }

    // --- protobuf 弹幕 ---

    fn varint(value: u64, out: &mut Vec<u8>) {
        let mut value = value;
        loop {
            let byte = (value & 0x7f) as u8;
            value >>= 7;
            if value == 0 {
                out.push(byte);
                return;
            }
            out.push(byte | 0x80);
        }
    }

    fn tag(field: u32, wire: u8, out: &mut Vec<u8>) {
        varint(u64::from(field) << 3 | u64::from(wire), out);
    }

    fn proto_varint(field: u32, value: u64, out: &mut Vec<u8>) {
        tag(field, 0, out);
        varint(value, out);
    }

    fn proto_bytes(field: u32, value: &[u8], out: &mut Vec<u8>) {
        tag(field, 2, out);
        varint(value.len() as u64, out);
        out.extend_from_slice(value);
    }

    #[test]
    fn danmaku_decoder_reads_scheduling_fields() {
        let mut elem = Vec::new();
        proto_varint(1, 2_190_644_797_575_173_888, &mut elem); // id
        proto_varint(2, 146_927, &mut elem); // progress
        proto_varint(3, 5, &mut elem); // mode 顶部
        proto_varint(4, 25, &mut elem); // fontsize
        proto_varint(5, 16_777_215, &mut elem); // color
        proto_bytes(6, b"e905bd13", &mut elem); // mid_hash
        proto_bytes(7, "喔～".as_bytes(), &mut elem); // content
        proto_varint(9, 11, &mut elem); // weight
        proto_varint(11, 1, &mut elem); // pool

        let mut reply = Vec::new();
        proto_bytes(1, &elem, &mut reply);

        let items = decode_danmaku_segment(&reply).expect("弹幕应解析成功");
        assert_eq!(items.len(), 1);
        let item = &items[0];
        assert_eq!(item.progress, 146_927);
        assert_eq!(item.mode, 5);
        assert_eq!(item.fontsize, 25);
        assert_eq!(item.color, 16_777_215);
        assert_eq!(item.content, "喔～");
        assert_eq!(item.weight, 11);
        assert_eq!(item.pool, 1);
    }

    #[test]
    fn danmaku_decoder_skips_unknown_fields_and_omitted_progress() {
        let mut elem = Vec::new();
        // 实测存在但不在 schema 内的字段：13 varint、20/21 bytes、24 varint。
        proto_varint(13, 1_048_576, &mut elem);
        proto_bytes(20, b"0", &mut elem);
        proto_bytes(21, b"0", &mut elem);
        proto_varint(24, 3, &mut elem);
        proto_varint(26, 41_473_934_959, &mut elem);
        // 未来可能出现的 fixed32 / fixed64，也必须能按 wire type 跳过。
        tag(90, 5, &mut elem);
        elem.extend_from_slice(&[1, 2, 3, 4]);
        tag(91, 1, &mut elem);
        elem.extend_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8]);
        // progress 省略（proto3 零值），必须落到 0 而不是解析失败。
        proto_bytes(7, "无 progress".as_bytes(), &mut elem);

        let mut reply = Vec::new();
        proto_bytes(1, &elem, &mut reply);
        // 顶层同样有 schema 外/不关心的字段，一并跳过。
        proto_varint(2, 0, &mut reply);
        proto_bytes(4, b"\x01", &mut reply);
        proto_bytes(5, b"\x02", &mut reply);
        proto_bytes(6, b"ctx", &mut reply);

        let items = decode_danmaku_segment(&reply).expect("未知字段不得导致解析失败");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].progress, 0);
        assert_eq!(items[0].content, "无 progress");
        // mode / fontsize / color 省略时回落到可见的默认值。
        assert_eq!(items[0].mode, 1);
        assert_eq!(items[0].fontsize, 25);
        assert_eq!(items[0].color, 0xff_ffff);
    }

    #[test]
    fn danmaku_decoder_drops_empty_content_and_rejects_garbage() {
        let mut elem = Vec::new();
        proto_varint(2, 1_000, &mut elem);
        proto_bytes(7, b"   ", &mut elem); // 只有空白，丢弃
        let mut reply = Vec::new();
        proto_bytes(1, &elem, &mut reply);
        assert!(
            decode_danmaku_segment(&reply)
                .expect("应解析成功")
                .is_empty()
        );

        // 截断的 varint 必须报错，而不是静默返回半条弹幕。
        assert!(decode_danmaku_segment(&[0x0a, 0x05, 0x10]).is_err());
    }

    #[test]
    fn danmaku_segment_index_is_six_minute_buckets() {
        assert_eq!(danmaku_segment_index(0), 1);
        assert_eq!(danmaku_segment_index(-500), 1);
        assert_eq!(danmaku_segment_index(359_999), 1);
        assert_eq!(danmaku_segment_index(360_000), 2);
        assert_eq!(danmaku_segment_index(720_001), 3);
    }

    // --- 列表解析 ---

    #[test]
    fn recommend_keeps_only_playable_ugc_items() {
        let raw = serde_json::json!({
            "code": 0,
            "data": { "item": [
                { "goto": "av", "id": 117_191_437_455_648_i64, "bvid": "BV1x", "cid": 41_473_934_959_i64,
                  "title": "标题", "pic": "http://i1.hdslb.com/a.jpg", "duration": 258, "pubdate": 1_788_226_200,
                  "owner": { "name": "up主", "face": "https://i0.hdslb.com/bfs/face/x.jpg" },
                  "stat": { "view": 1_465_320, "danmaku": 547 }, "rcmd_reason": null },
                // 直播卡：没有 owner，不可播。
                { "goto": "live", "id": 5, "title": "直播" },
                // 番剧卡：goto 不是 av。
                { "goto": "bangumi", "id": 6, "bvid": "BV1y", "owner": { "name": "x" } },
            ]}
        })
        .to_string();

        let page = parse_recommend(&raw).expect("推荐流应解析成功");
        assert_eq!(page.items.len(), 1);
        let item = &page.items[0];
        // aid 必须是字符串且保持全精度：按 f64 走会丢到 117191437455648 之外。
        assert_eq!(item.aid, "117191437455648");
        assert_eq!(item.cid, Some(41_473_934_959));
        assert_eq!(item.view, 1_465_320);
        // http 封面必须升级成 https，否则 WebView 按混合内容拦掉。
        assert_eq!(item.cover, "https://i1.hdslb.com/a.jpg");
        assert!(page.has_more);
    }

    #[test]
    fn popular_reads_object_rcmd_reason_and_no_more_flag() {
        let raw = serde_json::json!({
            "code": 0,
            "data": { "no_more": true, "list": [
                { "aid": 117_191_437_455_648_i64, "bvid": "BV1x", "cid": 41_473_934_959_i64, "title": "t",
                  "pic": "https://i1.hdslb.com/a.jpg", "duration": 258, "pubdate": 1,
                  "owner": { "name": "up", "face": "" }, "stat": { "view": 10, "danmaku": 2 },
                  "rcmd_reason": { "content": "百万播放", "corner_mark": 0 } }
            ]}
        })
        .to_string();

        let page = parse_popular(&raw).expect("热门应解析成功");
        assert!(!page.has_more, "no_more=true 必须终止翻页");
        assert_eq!(page.items[0].rcmd_reason.as_deref(), Some("百万播放"));
        assert_eq!(page.items[0].author_face, None, "空头像不应产出无效 URL");
    }

    #[test]
    fn pgc_index_reads_first_ep_and_has_next() {
        let raw = serde_json::json!({
            "code": 0,
            "data": { "has_next": 1, "list": [
                { "season_id": 12345, "title": "番剧", "cover": "https://i0.hdslb.com/c.png",
                  "badge": "大会员", "index_show": "全8话", "first_ep": { "ep_id": 826_497 } },
                { "season_id": 6789, "title": "无首集", "cover": "", "badge": "", "index_show": "" },
            ]}
        })
        .to_string();

        let page = parse_pgc_index(&raw).expect("PGC 索引应解析成功");
        assert!(page.has_more, "has_next 为 1 时应可翻页");
        assert_eq!(page.items[0].season_id, "12345");
        assert_eq!(page.items[0].ep_id.as_deref(), Some("826497"));
        assert_eq!(page.items[0].badge.as_deref(), Some("大会员"));
        // 缺 first_ep 时留空，由调用方回退 season 详情。
        assert_eq!(page.items[1].ep_id, None);
        assert_eq!(page.items[1].badge, None);
    }

    #[test]
    fn pgc_rank_accepts_both_result_and_data_envelopes() {
        let result_shaped = serde_json::json!({
            "code": 0, "result": { "list": [ { "season_id": 1, "title": "番剧榜", "cover": "" } ] }
        })
        .to_string();
        let data_shaped = serde_json::json!({
            "code": 0, "data": { "list": [ { "season_id": 2, "title": "影视榜", "cover": "" } ] }
        })
        .to_string();

        assert_eq!(
            parse_pgc_rank(&result_shaped).unwrap().items[0].season_id,
            "1"
        );
        assert_eq!(
            parse_pgc_rank(&data_shaped).unwrap().items[0].season_id,
            "2"
        );
        // 榜单是固定快照，没有下一页。
        assert!(!parse_pgc_rank(&result_shaped).unwrap().has_more);
    }

    #[test]
    fn season_converts_episode_duration_to_seconds() {
        let raw = serde_json::json!({
            "code": 0,
            "result": {
                "season_id": 62_837, "title": "剧集", "cover": "https://i0.hdslb.com/c.png",
                "evaluate": "简介",
                "episodes": [ { "id": 826_497, "ep_id": 826_497, "aid": 1_455_924_625_i64,
                    "cid": 1_602_741_036_i64, "bvid": "BV1z", "title": "1",
                    "long_title": "为了消灭鬼舞辻无惨", "cover": "", "duration": 2_938_060, "badge": "" } ]
            }
        })
        .to_string();

        let season = parse_season(&raw).expect("season 应解析成功");
        assert_eq!(season.episodes.len(), 1);
        // 上游是毫秒，对外统一成秒。
        assert_eq!(season.episodes[0].duration, 2_938);
        assert_eq!(season.episodes[0].ep_id, "826497");
        assert_eq!(season.episodes[0].aid, "1455924625");
    }

    #[test]
    fn select_streams_prefers_requested_codec_and_marks_locked_qualities() {
        let data = serde_json::json!({
            "accept_quality": [112, 80, 32],
            "accept_description": ["高清 1080P+", "高清 1080P", "清晰 480P"],
            "dash": {
                "video": [
                    { "id": 32, "codecs": "av01.0.08M.08", "bandwidth": 340_895, "base_url": "https://a/av01" },
                    { "id": 32, "codecs": "avc1.640033", "bandwidth": 631_556, "base_url": "https://a/avc1" },
                    { "id": 32, "codecs": "hvc1.1.6.L120.90", "bandwidth": 329_921, "base_url": "https://a/hvc1" },
                ],
                "audio": [
                    { "id": 30216, "codecs": "mp4a.40.2", "bandwidth": 67_224, "base_url": "https://a/a1" },
                    { "id": 30232, "codecs": "mp4a.40.2", "bandwidth": 85_370, "base_url": "https://a/a2" },
                ]
            }
        });

        let (video, audio, quality, label, accept) =
            select_streams(&data, &VideoPlayRequest::default()).expect("选流应成功");
        // 默认必须落在 avc1 上，而不是同画质里带宽更低的 hvc1/av01。
        assert_eq!(video.get("codecs").unwrap(), "avc1.640033");
        assert_eq!(audio.get("base_url").unwrap(), "https://a/a2");
        assert_eq!(quality, 32);
        assert_eq!(label, "清晰 480P");
        // 只有实际返回了 representation 的档位才算可用；1080P 需大会员，标不可用。
        assert_eq!(accept.len(), 3);
        assert!(accept.iter().find(|q| q.qn == 32).unwrap().available);
        assert!(!accept.iter().find(|q| q.qn == 112).unwrap().available);
    }

    #[test]
    fn select_streams_falls_back_when_codec_is_absent() {
        let data = serde_json::json!({
            "dash": {
                "video": [ { "id": 16, "codecs": "hvc1.1.6", "bandwidth": 1, "base_url": "https://a/v" } ],
                "audio": [ { "id": 30216, "codecs": "mp4a.40.2", "bandwidth": 1, "base_url": "https://a/a" } ]
            }
        });
        let request = VideoPlayRequest {
            qn: Some(112),
            ..VideoPlayRequest::default()
        };
        // 请求 1080P + avc1 都不存在时必须回落到唯一可用流，而不是报错。
        let (video, _, quality, _, _) = select_streams(&data, &request).expect("应回落");
        assert_eq!(video.get("codecs").unwrap(), "hvc1.1.6");
        assert_eq!(quality, 16);

        let empty = serde_json::json!({ "dash": { "video": [], "audio": [] } });
        assert!(select_streams(&empty, &VideoPlayRequest::default()).is_err());
        let no_dash = serde_json::json!({ "timelength": 1 });
        assert!(select_streams(&no_dash, &VideoPlayRequest::default()).is_err());
    }

    #[test]
    fn segment_base_ranges_reads_init_and_index_bounds() {
        let rep = serde_json::json!({
            "segment_base": { "initialization": "0-937", "index_range": "938-1601" }
        });
        assert_eq!(segment_base_ranges(&rep).unwrap(), (937, 938, 1601));

        let broken = serde_json::json!({ "segment_base": { "initialization": "0-937", "index_range": "938" } });
        assert!(segment_base_ranges(&broken).is_err());
        assert!(segment_base_ranges(&serde_json::json!({})).is_err());
    }

    #[test]
    fn stream_candidates_prefers_base_then_dedupes_backups() {
        let rep = serde_json::json!({
            "base_url": "https://mcdn.example.com/a.m4s",
            "backup_url": ["https://upos.example.com/a.m4s", "", "https://mcdn.example.com/a.m4s"],
            "backupBaseUrl": ["https://upos-2.example.com/a.m4s"]
        });
        let candidates = stream_candidates(&rep);
        assert_eq!(
            candidates,
            [
                "https://mcdn.example.com/a.m4s",
                "https://upos.example.com/a.m4s",
                "https://upos-2.example.com/a.m4s"
            ]
        );
        assert!(stream_candidates(&serde_json::json!({ "id": 32 })).is_empty());
    }

    #[test]
    fn parse_search_videos_dedupes_and_reads_flat_fields() {
        let raw = serde_json::json!({
            "code": 0,
            "data": {
                "numPages": 2,
                "result": [
                    {
                        "type": "video",
                        "bvid": "BV1duPqq",
                        "aid": 659724249i64,
                        "pic": "http://i2.hdslb.com/bfs/archive/a.jpg",
                        "title": "<em class=\"keyword\">甜药换枪</em>精剪版",
                        "author": "UP 主甲",
                        "duration": "1:02:03",
                        "play": "13856",
                        "video_review": "58",
                        "pubdate": 1759000000
                    },
                    // 同 bvid 重复返回，前端网格的 key 会冲突，这里应去重。
                    { "type": "video", "bvid": "BV1duPqq", "aid": 1, "title": "重复", "author": "", "duration": "" },
                    { "type": "video", "bvid": "BV2abcdefgh", "aid": 2, "title": "第二条", "author": "UP 主乙", "duration": "6:29", "play": 7, "video_review": 2 },
                    // 非稿件条目混入结果。
                    { "type": "biz", "bvid": "BV3xxxxxxxx" }
                ]
            }
        })
        .to_string();
        let page = parse_search_videos(&raw, 1).unwrap();
        assert!(page.has_more);
        assert_eq!(page.items.len(), 2);
        let first = &page.items[0];
        assert_eq!(first.aid, "659724249");
        // 标题里的 <em> 高亮标签被剥掉。
        assert_eq!(first.title, "甜药换枪精剪版");
        // 扁平字段：author/play/video_review 取代 owner/stat。
        assert_eq!(first.author, "UP 主甲");
        assert_eq!(first.view, 13_856);
        assert_eq!(first.danmaku, 58);
        // 字符串时长 H:MM:SS → 秒。
        assert_eq!(first.duration, 3723);
        // 搜索条目没有 cid —— 可播性由播放页用稿件详情补齐。
        assert_eq!(first.cid, None);
        assert_eq!(page.items[1].duration, 389);

        let last = parse_search_videos(&raw, 2).unwrap();
        assert!(!last.has_more);
        assert!(parse_search_videos("{}", 1).is_err());
    }

    #[test]
    fn parse_related_maps_owner_and_stat() {
        let raw = serde_json::json!({
            "code": 0,
            "data": [{
                "bvid": "BV1t5xDzKEFJ",
                "aid": 115331263634260i64,
                "pic": "http://i1.hdslb.com/bfs/archive/a8b83.jpg",
                "duration": 226,
                "title": "东北街头12元猪蹄红烧肉饭",
                "owner": { "name": "转生成为毛毛", "face": "//i0.hdslb.com/bfs/face/1f.jpg" },
                "stat": { "view": 1385636, "danmaku": 5870 }
            }]
        })
        .to_string();
        let page = parse_related(&raw).unwrap();
        assert!(!page.has_more);
        assert_eq!(page.items.len(), 1);
        let item = &page.items[0];
        // aid 是超大整数，必须无损转成字符串。
        assert_eq!(item.aid, "115331263634260");
        assert_eq!(item.bvid, "BV1t5xDzKEFJ");
        assert_eq!(item.author, "转生成为毛毛");
        assert_eq!(item.view, 1_385_636);
        assert!(item.cover.starts_with("https://i1.hdslb.com/"));
        assert!(item.author_face.as_deref().unwrap().starts_with("https://"));

        assert!(parse_related("{}").is_err());
    }

    #[test]
    fn parse_archive_reads_aid_desc_and_stats() {
        let raw = serde_json::json!({
            "code": 0,
            "data": {
                "bvid": "BV1Ybuq6nEYq",
                "aid": 117075725000671i64,
                "cid": 311001234i64,
                "title": "测试稿件",
                "desc": "简介内容",
                "owner": { "name": "UP 主", "face": "https://i0.hdslb.com/bfs/face/2f.jpg" },
                "stat": { "view": 100, "danmaku": 5, "reply": 4986 },
                "pubdate": 1759000000
            }
        })
        .to_string();
        let archive = parse_archive(&raw).unwrap();
        assert_eq!(archive.aid, "117075725000671");
        assert_eq!(archive.cid, 311_001_234);
        assert_eq!(archive.desc, "简介内容");
        assert_eq!(archive.reply, 4986);
        assert_eq!(archive.pubdate, 1759000000);

        // 根上没有 cid 时退回首 P（搜索/UP 列表的条目靠这条路径补齐取流键）。
        let multi_page = serde_json::json!({
            "code": 0,
            "data": {
                "bvid": "BV1Ybuq6nEYq",
                "aid": 117075725000671i64,
                "title": "多P稿件",
                "pages": [{ "cid": 998877i64 }]
            }
        })
        .to_string();
        assert_eq!(parse_archive(&multi_page).unwrap().cid, 998877);

        assert!(parse_archive("{}").is_err());
    }

    #[test]
    fn parse_comments_merges_top_replies_and_emotes() {
        let raw = serde_json::json!({
            "code": 0,
            "data": {
                "cursor": { "is_end": false, "all_count": 4986, "next": 2 },
                // UP 主置顶也可能出现在 top.upper（对象）而非 top_replies。
                "top": { "upper": {
                    "rpid": 111, "member": { "uname": "upper 置顶", "mid": "8" },
                    "content": { "message": "另一种置顶形态" }
                } },
                "top_replies": [ {
                    "rpid": 111, "like": 9, "ctime": 1759000000, "rcount": 0,
                    "member": { "uname": "置顶", "mid": "42", "avatar": "https://i0.hdslb.com/bfs/face/noface.jpg", "level_info": { "current_level": 6 } },
                    "content": { "message": "置顶评论" }
                } ],
                "replies": [ {
                    "rpid": 313239931440i64, "like": 560, "ctime": 1786490948, "rcount": 9,
                    "member": { "uname": "小趴菜", "mid": "493576201", "avatar": "https://i0.hdslb.com/bfs/face/x.jpg", "level_info": { "current_level": 5 } },
                    "content": {
                        "message": "烤鸡腿[大哭]",
                        "emote": { "[大哭]": { "text": "[大哭]", "url": "https://i0.hdslb.com/bfs/emote/2ca.png" } },
                        "pictures": [ { "img_src": "//i0.hdslb.com/bfs/new_dyn/1.jpg" } ]
                    },
                    "replies": [ {
                        "rpid": 222, "like": 29, "ctime": 1786491000, "rcount": 0,
                        "member": { "uname": "路人", "mid": "7", "avatar": "https://i0.hdslb.com/bfs/face/y.jpg" },
                        "content": { "message": "转的鸡肉技术" }
                    } ]
                } ]
            }
        })
        .to_string();
        let page = parse_comments(&raw).unwrap();
        assert!(page.has_more);
        assert_eq!(page.next, 2);
        assert_eq!(page.all_count, 4986);
        // top.upper 与 top_replies 同 rpid 时只留先到的一条，置顶在前。
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.items[0].uname, "置顶");
        assert_eq!(page.items[0].rpid, 111);
        let main = &page.items[1];
        assert_eq!(main.rpid, 313239931440);
        assert_eq!(main.level, 5);
        assert_eq!(main.emotes.len(), 1);
        assert_eq!(main.emotes[0].text, "[大哭]");
        assert!(main.pictures[0].starts_with("https://"));
        assert_eq!(main.replies.len(), 1);
        assert_eq!(main.replies[0].uname, "路人");

        assert!(parse_comments("{}").is_err());
    }

    #[test]
    fn parse_comments_takes_upper_pinned_when_top_replies_missing() {
        // 上游对 UP 主置顶有两种形态：top_replies 数组与 top.upper 对象，可能只给其一。
        let raw = serde_json::json!({
            "data": {
                "cursor": { "is_end": true, "all_count": 3, "next": 1 },
                "top": { "upper": {
                    "rpid": 888, "member": { "uname": "只有 upper", "mid": "9" },
                    "content": { "message": "置顶在 upper 字段" }
                } },
                "replies": [ {
                    "rpid": 1, "member": { "uname": "甲", "mid": "1" }, "content": { "message": "普通" }
                } ]
            }
        })
        .to_string();
        let page = parse_comments(&raw).unwrap();
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.items[0].uname, "只有 upper");
        assert_eq!(page.items[0].rpid, 888);
        assert!(!page.has_more);
    }

    #[test]
    fn parse_comment_replies_derives_has_more_from_page_count() {
        let raw = serde_json::json!({
            "code": 0,
            "data": {
                "page": { "num": 1, "size": 20, "count": 86 },
                "replies": [ {
                    "rpid": 1, "like": 0, "ctime": 1, "rcount": 0,
                    "member": { "uname": "甲", "mid": "1", "avatar": "" },
                    "content": { "message": "回复内容" }
                } ]
            }
        })
        .to_string();
        let page = parse_comment_replies(&raw, 1).unwrap();
        assert_eq!(page.all_count, 86);
        assert!(page.has_more);
        assert_eq!(page.items[0].message, "回复内容");
        assert_eq!(page.items[0].level, 0);
        assert!(page.items[0].avatar.is_none());

        // 取满最后一页后 has_more 应为 false。
        let last = serde_json::json!({
            "data": { "page": { "count": 5 }, "replies": [ { "rpid": 2, "member": { "uname": "乙", "mid": "2" }, "content": { "message": "x" } } ] }
        })
        .to_string();
        assert!(!parse_comment_replies(&last, 1).unwrap().has_more);
    }
}
