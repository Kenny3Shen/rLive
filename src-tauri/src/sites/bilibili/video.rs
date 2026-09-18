//! Bilibili 视频（VOD）能力：列表、DASH 播放信息与分段弹幕。
//!
//! VOD 不属于 [`crate::sites::traits::LiveSite`]：它是 Bilibili 独有的表面，
//! 其他站点没有对应概念。因此这里作为 [`BilibiliSite`] 的 inherent impl 追加，
//! 复用同一份 cookie、buvid 与 WBI 签名，而不去污染跨站点的 trait。

use std::collections::{BTreeMap, HashSet};

use serde_json::Value;

use crate::danmu_rs::{ProtoReader, ProtoValue};
use crate::error::{AppError, AppResult};
use crate::models::video::{
    DanmakuItem, PgcItem, PgcListPage, SeasonEpisode, VideoArchive, VideoArchivePage, VideoComment,
    VideoCommentPage, VideoDanmakuSegment, VideoDimension, VideoEmote, VideoItem, VideoListPage,
    VideoPlayRequest, VideoQuality, VideoSeason, VideoSeasonEpisode, VideoStoryboard,
    VideoSubtitle, VideoUgcSeason,
};

use super::BilibiliSite;
use super::api::{DEFAULT_USER_AGENT, as_i64, as_str, avatar_thumb, strip_em_tags};

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

/// story feed **首屏**一页串行拉几批。
///
/// 该接口无游标、每批只给 4~5 条，且轮换游标在**服务端**按时间推进。取批必须
/// **串行**：并发拿到的不是独立几页，而是同一个游标窗口的重叠切片 —— 实测带
/// `buvid` 并发 4 批 20 条只得 11~12 条唯一（同时发不同 buvid 也照样重叠，因此
/// 是服务端按窗口共享游标，不是设备级会话状态）。串行连拉零重复：N=8 实测 40/40、
/// N=12 实测 60/60。
///
/// 串行**不需要额外加延时**：单次往返约 335ms，本身已超过实测的重叠阈值（约
/// 250ms）。只有把取批改成并发时才需要人为错峰，而那是反效果的 —— 并发只是把
/// 同样的唯一条目分给更多请求。
///
/// 两批约 9 条，正好填满首屏竖屏消费的预取窗口，
/// 再多给的是白等的往返（首屏多等一个是直接的流失）。要更多条走补货档，
/// 见 [`STORY_FEED_MORE_BATCHES`]。
const STORY_FEED_BATCHES: usize = 2;

/// 一次请求允许串行拉的最大批数。
///
/// 上游没有公开的频控阈值，实测连续 130 轮（含 N=16 并发）未出现过非 0 code，
/// 但这个上限是防手滑的：批数是调接口次数，涨上去的代价是线性的，而单页
/// 收益会随去重递减。
const STORY_FEED_MAX_BATCHES: usize = 8;

/// 补货一页串行拉几批。
///
/// 比首屏多得多，因为代价与收益在两条路径上不对称：首屏多等一个往返是直接的流失，
/// 而补货发生在用户已经投入之后（他正滑着，不是在等第一个画面）。约 30 条 ~2s，
/// 而剩余 3 条在快划下大约能撑 3~6s 的跑道，因此来得及。
const STORY_FEED_MORE_BATCHES: usize = 6;

/// 把「要几批」夹到合法范围。
///
/// 抽成纯函数只为了能单测：传 0 或一个巨大的数都不该报错，也不该真的去打那么多次
/// 接口。`None` 是首屏（省往返），`clamp` 的下界 1 保证「至少拉一批」—— 传 0 时
/// 返回空列表会被上层当成取流失败。
///
/// 批数**不**随「新条目够不够」浮动，尽管上游头部很黏（真机实测：登录态连续 6 次
/// 首屏，60 条只有 43 条唯一，一条 6 轮全中，跨调用重复率 ≈28%）。直觉是「不够新就
/// 多拉几批」，实测否掉了它：记忆攒满后每多拉一批只换来约 0.4 条新条目，首屏为凑
/// 6 条新的打满 4 批要 1.65s，而固定两批约 0.8s。同一组实测里另有一次调用 4 批给了
/// 20 条全新 —— 上游是**不定时整体轮换**，多打接口催不动它，只是把「此刻没有新
/// 内容」按批数收费，而首屏多等一个往返是直接的流失。
///
/// 因此批数守住实测过的时延画像，跨调用记忆只改变**发哪些条目**与**排序**
/// （见 [`StoryPick`]）。
fn story_batch_count(requested: Option<usize>) -> usize {
    requested
        .unwrap_or(STORY_FEED_BATCHES)
        .clamp(1, STORY_FEED_MAX_BATCHES)
}

/// 组装 story feed 的 query 参数。
///
/// 基础只有 `pull=1`。有种子时额外带 `bvid` 与 `display_id=1`（实测：这样才能让种子
/// 稿件排在首位并换出一组不重叠的窗口；只带种子不带 `display_id` 时种子不进首位，
/// `display_id=2` 是另一种语义）。用 `bvid` 而不是 `aid`：调用方（当前条目、观看历史）
/// 天然持有 bvid，两种写法实测等价。空字符串与 `"0"` 都当无种子，避免调用方把
/// 「没有」编码成空值传上去。
fn story_query_params(seed: Option<&str>) -> Vec<(&'static str, String)> {
    let mut params = vec![("pull", "1".to_string())];
    if let Some(bvid) = seed
        .map(str::trim)
        .filter(|bvid| !bvid.is_empty() && *bvid != "0")
    {
        params.push(("bvid", bvid.to_string()));
        params.push(("display_id", "1".to_string()));
    }
    params
}

/// 逐批累积 story 条目，按「见过没见过」分两摊。
///
/// 上游无游标，批与批之间只能靠服务端时间轴推进，重叠不可避，因此跨批去重是硬需求
/// （`taken`）。`seen` 是更外面一层的记忆：本进程这次运行发过的，加上最近看过的
/// （见 `commands::video::video_get_story`）—— 那些条目**不是错误**，只是应该排到
/// 后面去。
struct StoryPick {
    /// 本次已收下的 bvid，跨批去重用。
    taken: HashSet<String>,
    /// 没见过的（优先给）。
    fresh: Vec<VideoItem>,
    /// 见过的（只在挑不出新的时兜底）。
    repeats: Vec<VideoItem>,
}

impl StoryPick {
    fn new() -> Self {
        Self {
            taken: HashSet::new(),
            fresh: Vec::new(),
            repeats: Vec::new(),
        }
    }

    /// 收下一批，按 `seen` 分摊。同一批内或跨批的重复 bvid 直接丢掉。
    fn absorb(&mut self, page: VideoListPage, seen: &HashSet<String>) {
        for item in page.items {
            if !self.taken.insert(item.bvid.clone()) {
                continue;
            }
            if seen.contains(&item.bvid) {
                self.repeats.push(item);
            } else {
                self.fresh.push(item);
            }
        }
    }

    /// 收工成一页。
    ///
    /// 有新的就只给新的。一条新的都没有时**仍然**把重复条目发出去，但把 `has_more`
    /// 落下：前端的跨页去重集合是按查询算的（重进这一页就清空），因此这些条目对
    /// 当次浏览仍是有内容的一页；而「这批没有新的」正是原注释写的那个终止条件
    /// 「新条目耗尽即停」。
    ///
    /// 这里不能回 `has_more: true`：前端拿到全是重复的一页会把它整页去掉，流长度不变
    /// 而补货判定仍然成立，于是立刻再发一次 —— 每轮一次真实往返地空转。
    fn finish(self) -> VideoListPage {
        let has_more = !self.fresh.is_empty();
        let items = if self.fresh.is_empty() {
            self.repeats
        } else {
            self.fresh
        };
        VideoListPage { has_more, items }
    }
}

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

/// 读取上游 `dimension`。宽高任一为 0 时当作未下发（无法判定画幅）。
fn video_dimension(item: &Value) -> Option<VideoDimension> {
    let raw = item.get("dimension")?;
    let width = raw.get("width").map(as_i64).unwrap_or(0);
    let height = raw.get("height").map(as_i64).unwrap_or(0);
    if width <= 0 || height <= 0 {
        return None;
    }
    Some(VideoDimension {
        width,
        height,
        rotate: raw.get("rotate").map(as_i64).unwrap_or(0),
    })
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
        title: strip_em_tags(&item.get("title").map(as_str).unwrap_or_default()),
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
        // 列表接口（推荐/搜索/热门/相关/投稿）都不下发粉丝数，只有 story feed 带。
        author_fans: None,
        duration: item_duration(item),
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
        // 推荐流/搜索/热门给 Unix 秒；UP 主投稿列表的 `created` 当前也是 Unix 秒
        // （数字），老接口返回过北京时间字符串，两种形状都收。都没有时为 0，
        // 前端不渲染日期。
        pubdate: item
            .get("pubdate")
            .map(as_i64)
            .filter(|pubdate| *pubdate > 0)
            .unwrap_or_else(|| created_to_unix(item.get("created"))),
        rcmd_reason: rcmd_reason(item),
        dimension: video_dimension(item),
    }
}

/// UP 主投稿列表的 `created` → Unix 秒。数字（当前接口）直接用；
/// `yyyy-MM-dd HH:mm`（北京时间字符串，老接口形状）按 UTC 解析再减 8 小时
/// 还原真实时刻。解析失败返回 0，前端按「无发布日期」处理。
fn created_to_unix(value: Option<&Value>) -> i64 {
    let Some(value) = value else { return 0 };
    let secs = as_i64(value);
    if secs > 0 {
        return secs;
    }
    chrono::NaiveDateTime::parse_from_str(&as_str(value), "%Y-%m-%d %H:%M")
        .map(|dt| dt.and_utc().timestamp() - 8 * 3600)
        .unwrap_or(0)
}

/// 条目时长的取值：`duration` 优先，缺失或为 0 时回退 `length`。
///
/// 热门/推荐/搜索/相关给 `duration`（秒或 `H:MM:SS` 字符串）；UP 主投稿列表
/// （`x/space/wbi/arc/search` 的 `vlist[]`）**只有** `length`（字符串），
/// 漏掉这一路会让投稿抽屉里每条都显示 0:00。
fn item_duration(item: &Value) -> i64 {
    let duration = video_duration(item.get("duration"));
    if duration > 0 {
        duration
    } else {
        video_duration(item.get("length"))
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
        if let Some(url) = rep.get(key).map(as_str).filter(|url| !url.is_empty())
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

/// 列表接口的公共骨架：反序列化 + 按指针（可多个回退）取条目数组，
/// 过滤与 has_more 逻辑由 `build` 就地完成（各接口不同，部分接口还要读根
/// 上的分页字段，因此把根也交给 `build`）。
/// 错误串逐字保持：`{name} json: {e}` 与 `{name}缺少 {what}`。
fn json_items<T>(
    raw: &str,
    name: &str,
    what: &str,
    pointers: &[&str],
    build: impl FnOnce(&Value, &[Value]) -> T,
) -> AppResult<T> {
    let root: Value =
        serde_json::from_str(raw).map_err(|e| video_err(format!("{name} json: {e}")))?;
    let items = pointers
        .iter()
        .find_map(|pointer| root.pointer(pointer))
        .and_then(Value::as_array)
        .ok_or_else(|| video_err(format!("{name}缺少 {what}")))?;
    Ok(build(&root, items))
}

/// 解析推荐流 `data.item[]`。
///
/// 该接口会混入直播、番剧等非稿件条目，只有 `goto == "av"` 且带 `owner` 的
/// 才是可播的 UGC 稿件。
pub fn parse_recommend(raw: &str) -> AppResult<VideoListPage> {
    json_items(
        raw,
        "推荐流",
        "data.item",
        &["/data/item"],
        |_root, items| {
            let items: Vec<VideoItem> = items
                .iter()
                .filter(|item| item.get("goto").map(as_str).as_deref() == Some("av"))
                .filter(|item| item.get("owner").is_some())
                .map(video_item)
                .filter(|item| !item.bvid.is_empty())
                .collect();
            // 推荐流是无限刷新的，只要这一刷还有内容就认为可以继续。
            VideoListPage {
                has_more: !items.is_empty(),
                items,
            }
        },
    )
}

/// 解析热门 `data.list[]`。尾页由 `data.no_more` 明确告知。
pub fn parse_popular(raw: &str) -> AppResult<VideoListPage> {
    json_items(
        raw,
        "热门",
        "data.list",
        &["/data/list"],
        |root, items| {
            let items: Vec<VideoItem> = items.iter().map(video_item).collect();
            let no_more = root
                .pointer("/data/no_more")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            VideoListPage {
                has_more: !no_more,
                items,
            }
        },
    )
}

/// 解析分区榜 `data.list[]`（结构与热门一致，但该接口只有一页）。
pub fn parse_zone(raw: &str) -> AppResult<VideoListPage> {
    json_items(
        raw,
        "分区榜",
        "data.list",
        &["/data/list"],
        |_root, items| {
            let items: Vec<VideoItem> = items.iter().map(video_item).collect();
            // `ranking/v2` 一次返回全部榜单条目，没有翻页参数。
            VideoListPage {
                has_more: false,
                items,
            }
        },
    )
}

/// 解析一条 story feed 条目。
///
/// 字段名与其他列表接口不同，故不复用 [`video_item`]：封面在 `cover`（不是 `pic`），
/// aid 在 `param`，cid 在 `player_args.cid`。`param` 是 aid 的字符串形态，正好对应
/// [`VideoItem::aid`] 的字符串约定（实测 `117263042742272`，超 JS 安全整数）。
///
/// 封面优先 `cover` 而不是首帧图 `ff_cover`：后者是竖屏播放器的预热帧，并非
/// UP 主选定的封面，当卡片缩略图用会出现黑帧。
fn story_item(item: &Value) -> VideoItem {
    let owner = item.get("owner");
    let stat = item.get("stat");
    let cover = item
        .get("cover")
        .map(as_str)
        .filter(|cover| !cover.is_empty())
        .or_else(|| item.get("ff_cover").map(as_str))
        .unwrap_or_default();
    VideoItem {
        bvid: item.get("bvid").map(as_str).unwrap_or_default(),
        // `param` 就是 aid；`player_args.aid` 是同一个值的数字形态，缺 `param` 时回退。
        aid: item
            .get("param")
            .map(as_str)
            .filter(|aid| !aid.is_empty() && aid != "0")
            .or_else(|| item.pointer("/player_args/aid").map(as_str))
            .unwrap_or_default(),
        cid: item
            .pointer("/player_args/cid")
            .map(as_i64)
            .filter(|cid| *cid > 0),
        title: item.get("title").map(as_str).unwrap_or_default(),
        cover: video_cover(&cover),
        author: owner
            .and_then(|owner| owner.get("name"))
            .map(as_str)
            .unwrap_or_default(),
        author_face: owner
            .and_then(|owner| owner.get("face"))
            .map(as_str)
            .map(|face| avatar_thumb(&face))
            .filter(|face| !face.is_empty()),
        // story 的 `owner.fans` 是白带的：实测 12/12 条都有，数值与
        // `x/web-interface/card` 的 `follower` 一致（同一 mid 实测均为 11389）。
        // 因此信息行里的粉丝数不需要额外请求。上游没给时为 `None`（不是 0）。
        author_fans: owner.and_then(|owner| owner.get("fans")).map(as_i64),
        duration: video_duration(item.get("duration")),
        view: stat
            .and_then(|stat| stat.get("view"))
            .map(as_i64)
            .unwrap_or(0),
        danmaku: stat
            .and_then(|stat| stat.get("danmaku"))
            .map(as_i64)
            .unwrap_or(0),
        pubdate: item.get("pubdate").map(as_i64).unwrap_or(0),
        // story 条目不带 `rcmd_reason`；它自带的 `sub_title`（「N 万播放」）与 `view`
        // 重复，不当推荐理由用。
        rcmd_reason: None,
        dimension: video_dimension(item),
    }
}

/// 解析 story feed `data.items[]`（竖屏播放器入口流）。
///
/// 只保留 `card_goto == "vertical_av"` 且取流键（`bvid` + `cid`）齐备的条目：该流与
/// 推荐流同构，上游可能掘入广告与非稿件卡片，而竖屏舞台拿不到 cid 就无法
/// 直接起播。画幅**不过滤**：story 是混合流（实测 40 条中竖 22 / 横 18），横屏
/// 条目在竖屏舞台内 contain 居中，前端按 `dimension` 自行适配。
pub fn parse_story(raw: &str) -> AppResult<VideoListPage> {
    json_items(
        raw,
        "短视频流",
        "data.items",
        &["/data/items"],
        |_root, items| {
            let items: Vec<VideoItem> = items
                .iter()
                .filter(|item| {
                    item.get("card_goto")
                        .or_else(|| item.get("goto"))
                        .map(as_str)
                        .as_deref()
                        == Some("vertical_av")
                })
                .map(story_item)
                .filter(|item| !item.bvid.is_empty() && item.cid.is_some_and(|cid| cid > 0))
                .collect();
            // 无游标的轮换流：只要这一批还有内容就能继续拉（同 [`parse_recommend`]）。
            VideoListPage {
                has_more: !items.is_empty(),
                items,
            }
        },
    )
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
    json_items(
        raw,
        "PGC 索引",
        "data.list",
        &["/data/list"],
        |root, items| {
            let items: Vec<PgcItem> = items
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
            PgcListPage { has_more, items }
        },
    )
}

/// 解析 PGC 排行榜。
///
/// 番剧走 `pgc/web/rank/list`，结果在 `result.list`；其他 season_type 走
/// `pgc/season/rank/web/list`，结果在 `data.list`。两处结构相同，
/// 因此按存在的那个键取。
pub fn parse_pgc_rank(raw: &str) -> AppResult<PgcListPage> {
    json_items(
        raw,
        "PGC 榜单",
        "list",
        &["/result/list", "/data/list"],
        |_root, items| {
            let items: Vec<PgcItem> = items
                .iter()
                .map(pgc_item)
                .filter(|item| !item.season_id.is_empty())
                .collect();
            // 榜单是固定长度的快照，没有下一页。
            PgcListPage {
                has_more: false,
                items,
            }
        },
    )
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
    json_items(
        raw,
        "相关视频",
        "data 数组",
        &["/data"],
        |_root, items| {
            let items: Vec<VideoItem> = items.iter().map(video_item).collect();
            VideoListPage {
                has_more: false,
                items,
            }
        },
    )
}

/// 解析视频搜索结果 `data.result[]`。
///
/// 搜索接口返回的结构与热门/推荐略有不同（扁平字段、字符串时长、无 cid），
/// 差异由 [`video_item`] 的回退分支吸收。上游会把同一个稿件重复返回，
/// 这里按 bvid 去重，否则前端网格的 key 会冲突。分页由 `numPages` 与当前页码判断。
pub fn parse_search_videos(raw: &str, page: u32) -> AppResult<VideoListPage> {
    json_items(
        raw,
        "搜索视频",
        "data.result",
        &["/data/result"],
        |root, items| {
            let mut items: Vec<VideoItem> = items
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
            VideoListPage {
                has_more: page < num_pages,
                items,
            }
        },
    )
}

/// 解析 UP 主空间视频列表 `data.list.vlist[]`（WBI 签名接口 `x/space/wbi/arc/search`）。
pub fn parse_uploader_videos(raw: &str) -> AppResult<VideoListPage> {
    json_items(
        raw,
        "UP 主视频列表",
        "data.list.vlist",
        &["/data/list/vlist"],
        |root, items| {
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
            let items: Vec<VideoItem> = items
                .iter()
                .map(video_item)
                .filter(|item| !item.bvid.is_empty())
                .collect();
            VideoListPage {
                has_more: (pn * ps) < count,
                items,
            }
        },
    )
}

/**
 * 解析 html5 playurl 的 `durl[0]`：优先主地址，缺失时回退 backup_url。
 */
fn parse_cast_durl(data: &Value) -> AppResult<String> {
    let durl = data
        .get("durl")
        .and_then(Value::as_array)
        .and_then(|list| list.first())
        .ok_or_else(|| video_err("html5 playurl 缺少 durl（可能受版权或清晰度限制）"))?;
    let url = durl
        .get("url")
        .map(as_str)
        .filter(|url| !url.is_empty())
        .or_else(|| {
            durl.get("backup_url")
                .and_then(Value::as_array)
                .and_then(|list| list.first())
                .map(as_str)
        })
        .filter(|url| !url.is_empty())
        .ok_or_else(|| video_err("html5 playurl 的 durl 缺少可用地址"))?;
    Ok(url)
}

/**
 * 解析 player v2 的 `data.subtitle.subtitles[]`：跳过没给地址的条目，
 * 协议相对地址（`//aisubtitle...`）补上 https。
 */
fn parse_subtitles(list: Option<&Value>) -> Vec<VideoSubtitle> {
    let mut subtitles = Vec::new();
    for item in list.and_then(Value::as_array).into_iter().flatten() {
        let url = item.get("subtitle_url").map(as_str).unwrap_or_default();
        if url.is_empty() {
            continue;
        }
        let url = match url.strip_prefix("//") {
            Some(rest) => format!("https://{rest}"),
            None => url,
        };
        subtitles.push(VideoSubtitle {
            lan: item.get("lan").map(as_str).unwrap_or_default(),
            lan_doc: item.get("lan_doc").map(as_str).unwrap_or_default(),
            url,
        });
    }
    subtitles
}

/**
 * 解析 UGC 合集（`ugc_season`）：各分区分集展平。
 *
 * 少于 2 集不成连播列表，返回 None。条目里没有的分集跳过。
 */
fn parse_ugc_season(data: &Value) -> Option<VideoUgcSeason> {
    let season = data.get("ugc_season")?;
    let title = season.get("title").map(as_str).unwrap_or_default();
    let mut episodes = Vec::new();
    let sections = season.get("sections").and_then(Value::as_array)?;
    for section in sections {
        let section_episodes = section.get("episodes").and_then(Value::as_array);
        for episode in section_episodes.into_iter().flatten() {
            let bvid = episode.get("bvid").map(as_str).unwrap_or_default();
            let cid = episode
                .get("cid")
                .and_then(Value::as_i64)
                .or_else(|| episode.pointer("/page/cid").and_then(Value::as_i64))
                .unwrap_or(0);
            if bvid.is_empty() || cid <= 0 {
                continue;
            }
            // 展示标题：long_title（B 站客户端的长标题）空则用稿件标题。
            let long_title = episode.get("long_title").map(as_str).unwrap_or_default();
            let arc_title = episode
                .pointer("/arc/title")
                .map(as_str)
                .unwrap_or_default();
            episodes.push(VideoSeasonEpisode {
                bvid,
                cid,
                title: if long_title.is_empty() {
                    arc_title
                } else {
                    long_title
                },
                aid: episode.get("aid").map(as_str).unwrap_or_default(),
                duration: episode
                    .pointer("/arc/duration")
                    .and_then(Value::as_i64)
                    .or_else(|| episode.pointer("/page/duration").and_then(Value::as_i64))
                    .unwrap_or(0),
                cover: episode.get("cover").map(as_str).unwrap_or_default(),
            });
        }
    }
    if episodes.len() < 2 {
        return None;
    }
    Some(VideoUgcSeason { title, episodes })
}

/// 解析稿件分 P（`pages[]`）：多 P 稿件的选集与连播列表。
///
/// 少于 2 个有效 P 不成选集，返回空表。`part` 为空时保留空串，
/// 展示方回退到 P 序号。
fn parse_archive_pages(data: &Value) -> Vec<VideoArchivePage> {
    let mut pages = Vec::new();
    let Some(list) = data.get("pages").and_then(Value::as_array) else {
        return pages;
    };
    for item in list {
        let cid = item.get("cid").and_then(Value::as_i64).unwrap_or(0);
        if cid <= 0 {
            continue;
        }
        pages.push(VideoArchivePage {
            page: item.get("page").and_then(Value::as_i64).unwrap_or(0),
            cid,
            part: item.get("part").map(as_str).unwrap_or_default(),
            duration: item.get("duration").and_then(Value::as_i64).unwrap_or(0),
        });
    }
    if pages.len() < 2 {
        pages.clear();
    }
    pages
}

/// 解析稿件 Tags（`x/tag/archive/tags`），保留上游顺序并丢弃空名称。
fn parse_archive_tags(raw: &str) -> Vec<String> {
    let Ok(root) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    root.get("data")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let name = item.get("tag_name").map(as_str).unwrap_or_default();
                    let name = name.trim();
                    (!name.is_empty()).then(|| name.to_string())
                })
                .collect()
        })
        .unwrap_or_default()
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
        cover: data.get("pic").map(as_str).unwrap_or_default(),
        desc: data.get("desc").map(as_str).unwrap_or_default(),
        tags: Vec::new(),
        author: owner
            .and_then(|owner| owner.get("name"))
            .map(as_str)
            .unwrap_or_default(),
        author_face,
        author_mid: owner
            .and_then(|owner| owner.get("mid"))
            .map(as_str)
            .unwrap_or_default(),
        author_fans: 0,
        author_videos: 0,
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
        pages: parse_archive_pages(data),
        ugc_season: parse_ugc_season(data),
    })
}

fn parse_uploader_count(raw: &str, field: &str) -> Option<i64> {
    let root = serde_json::from_str::<Value>(raw).ok()?;
    Some(as_i64(root.get("data")?.get(field)?))
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

/// 评论区里稿件作者（UP 主）的 mid。
///
/// 上游在页面级 `data.upper.mid` 给出（评论首页与二级回复两个接口都有，实测）。
/// 该字段缺失或为 0 时回退到 UP 置顶对象（`data.top.upper.member.mid`）——能置顶的
/// 必然是作者本人。两者都拿不到时返回空串，此时**没有任何评论**会被标成 UP：
/// 宁可少标一个标识，也不把路人标成作者。
fn comment_upper_mid(data: &Value) -> String {
    let non_zero = |value: Option<String>| value.filter(|mid| !mid.is_empty() && mid != "0");
    non_zero(data.pointer("/upper/mid").map(as_str))
        .or_else(|| non_zero(data.pointer("/top/upper/member/mid").map(as_str)))
        .unwrap_or_default()
}

/// 评论与二级回复同构，递归解析；上游预览只嵌一层，但多余层级解析出来也无害。
/// `upper_mid` 是稿件作者 mid，用来给作者本人的评论打上 `is_upper`。
fn video_comment(item: &Value, upper_mid: &str) -> VideoComment {
    let member = item.get("member");
    let content = item.get("content");
    let avatar = member
        .and_then(|member| member.get("avatar"))
        .or_else(|| member.and_then(|member| member.get("face")))
        .map(as_str)
        .map(|face| avatar_thumb(&face))
        .filter(|face| !face.is_empty());
    let mid = member
        .and_then(|member| member.get("mid"))
        .map(as_str)
        .unwrap_or_default();
    VideoComment {
        is_upper: !upper_mid.is_empty() && mid == upper_mid,
        rpid: item.get("rpid").map(as_i64).unwrap_or_default(),
        mid,
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
            .map(|replies| {
                replies
                    .iter()
                    .map(|reply| video_comment(reply, upper_mid))
                    .collect()
            })
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
    let upper_mid = comment_upper_mid(data);
    let mut items: Vec<VideoComment> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let push_comment = |reply: &Value,
                        items: &mut Vec<VideoComment>,
                        seen: &mut std::collections::HashSet<i64>| {
        let comment = video_comment(reply, &upper_mid);
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
///
/// `page_size` 必须与本次请求实际用的 `ps` 一致：上游不给 `is_end`，
/// `has_more` 只能由「已经取过多少条」推导（见下）。
pub fn parse_comment_replies(raw: &str, page: u32, page_size: i64) -> AppResult<VideoCommentPage> {
    let root: Value =
        serde_json::from_str(raw).map_err(|e| video_err(format!("二级回复 json: {e}")))?;
    let data = root
        .get("data")
        .ok_or_else(|| video_err("二级回复缺少 data"))?;
    let items: Vec<VideoComment> = data
        .get("replies")
        .and_then(Value::as_array)
        .map(|replies| {
            let upper_mid = comment_upper_mid(data);
            replies
                .iter()
                .map(|reply| video_comment(reply, &upper_mid))
                .collect()
        })
        .unwrap_or_default();
    let all_count = data
        .pointer("/page/count")
        .and_then(Value::as_i64)
        .or_else(|| data.pointer("/page/acount").and_then(Value::as_i64))
        .unwrap_or(items.len() as i64);
    let page_size = page_size.max(1);
    Ok(VideoCommentPage {
        all_count,
        next: page as i64,
        // 上游不给 is_end：按「已取过的条数未到总数」推导。按传入的 `ps` 算而不是
        // 写死默认页大小 —— 桌面端的回复分页用更小的页（10），套 20 会提前宣布到尾。
        has_more: (page as i64) * page_size < all_count,
        items,
    })
}

/// 二级回复每页条数（移动端无限滚动的页大小；桌面端分页传自己的更小值）。
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
    /// 结束时刻，单位为 sidx 的 timescale。
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

/// 从 `offset` 起读 N 字节大端整数（u16/u32/u64 共用，错误消息里的
/// 位宽由 N 推出）。
fn be<const N: usize>(bytes: &[u8], offset: usize) -> AppResult<[u8; N]> {
    bytes
        .get(offset..offset + N)
        .and_then(|slice| slice.try_into().ok())
        .ok_or_else(|| video_err(format!("sidx 截断：读取 u{} 越界", N * 8)))
}

/// 把「init 段 + sidx」的合并响应切回两段。
///
/// 合并请求的区间是 `0-index_end`，其中 `init_end + 1` 是 sidx 的起点，因此
/// 切片边界固定为 `init_end + 1`。截断到不足 init 段时宁可报错也不猜 —— 把半个
/// init 段当成 init、或把 init 的尾巴当成 sidx，都会在下游变成难查的解析错误。
fn split_init_and_sidx(bytes: &[u8], init_end: u64) -> AppResult<(Vec<u8>, Vec<u8>)> {
    let boundary = usize::try_from(init_end)
        .ok()
        .and_then(|value| value.checked_add(1))
        .ok_or_else(|| video_err("init 段字节区间溢出"))?;
    if bytes.len() < boundary {
        return Err(video_err("init 段与 sidx 的合并响应被截断"));
    }
    Ok((bytes[..boundary].to_vec(), bytes[boundary..].to_vec()))
}

/// 解析 `segment_base.index_range` 取回的 ISO BMFF `sidx` box。
///
/// 后端在 play-info 阶段就把分片表解出来：MPD 由此合成带逐片字节区间与精确
/// 时长（`SegmentList` + `SegmentTimeline`）的清单，sidx 异常也在这一步以站点
/// 错误模型直接报给用户，而不是把问题留到播放器缓冲阶段。
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
    let timescale = u32::from_be_bytes(be::<4>(bytes, offset + 4)?);
    offset += 8;
    let first_offset = match version {
        // version 0：earliest_presentation_time(4) + first_offset(4)
        0 => {
            let value = u64::from(u32::from_be_bytes(be::<4>(bytes, offset + 4)?));
            offset += 8;
            value
        }
        // version 1：两个字段各 8 字节。实测 B 站返回的正是 version 1。
        1 => {
            let value = u64::from_be_bytes(be::<8>(bytes, offset + 8)?);
            offset += 16;
            value
        }
        other => return Err(video_err(format!("不支持的 sidx version={other}"))),
    };
    // reserved(2) + reference_count(2)
    let count = u16::from_be_bytes(be::<2>(bytes, offset + 2)?);
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
        let size = u64::from(u32::from_be_bytes(be::<4>(bytes, entry)?) & 0x7fff_ffff);
        let duration = u64::from(u32::from_be_bytes(be::<4>(bytes, entry + 4)?));
        if size == 0 {
            return Err(video_err("sidx 分片长度为 0"));
        }
        let end = base
            .checked_add(size)
            .ok_or_else(|| video_err("sidx 分片字节区间溢出"))?;
        segments.push(SidxSegment {
            start_byte: base,
            end_byte: end - 1,
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
    /// init 段的原始字节。
    ///
    /// 取流阶段它已随 sidx 一起取回（见 `video_track` 的合并 Range），在这里
    /// 带出来供调用方预写进分片缓存：播放器起播的第一个请求就是它，命中本机
    /// 就省掉一次完整 CDN 往返。
    pub init_bytes: Vec<u8>,
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

/// 为一条轨输出 `<SegmentList>`：逐片 `mediaRange` + `<SegmentTimeline>` 精确时长。
///
/// 1. 携带 `SegmentTimeline` 的 `SegmentList` 是 dash.js 原生支持的形态：其对
///    含 `SegmentTimeline` 的 `SegmentList` 走按时间轴取片的 getter，第 k 个
///    `<S>` 与第 k 个 `<SegmentURL>` 一一对应——时刻来自 `t`/`d`，字节区间来自
///    `mediaRange`。B 站按关键帧切片、片长不等，任何等长假设（固定 `duration`
///    展开时间轴）都会让 seek 选错分片，因此逐片写出真实时长。
/// 2. `timescale` 与 `<S>` 的 `t`/`d` 直接取该轨 sidx 的原值：视频轨与音轨的
///    timescale 各自独立（实测 16000 / 48000），不做换算也就不引入舍入。
/// 3. 全部分片共用同一条代理 URL，差异只在 `Range` 请求头；dash.js 按时间轴
///    区分分片（不以 URL 去重），并为带 `mediaRange` 的分片发 `Range: bytes=a-b`，
///    代理照头转发即可，无需给每片编造独立地址。
fn segment_list_xml(track: &VideoTrack, proxy_url: &str) -> String {
    let media = xml_escape(proxy_url);
    let mut xml = format!(r#"<SegmentList timescale="{}">"#, track.sidx.timescale);
    xml.push_str(&format!(
        r#"<Initialization sourceURL="{media}" range="0-{}"/>"#,
        track.init_end
    ));
    for segment in &track.sidx.segments {
        xml.push_str(&format!(
            r#"<SegmentURL media="{media}" mediaRange="{}-{}"/>"#,
            segment.start_byte, segment.end_byte
        ));
    }
    // sidx 只给逐片 t_end：分片 k 的起点是上一片的 t_end（首片为 0），
    // 时长 = 本片 t_end − 起点。
    let mut start = 0_u64;
    xml.push_str("<SegmentTimeline>");
    for segment in &track.sidx.segments {
        xml.push_str(&format!(
            r#"<S t="{start}" d="{}"/>"#,
            segment.t_end - start
        ));
        start = segment.t_end;
    }
    xml.push_str("</SegmentTimeline></SegmentList>");
    xml
}

/// 用两条轨的本机代理地址合成 MPD。
///
/// 清单经文本代理按播放会话挂到 HTTP 上，适配器按 URL 拉取；清单里的分片
/// 地址是两条轨各自的代理绝对地址，与清单本身同在本机回环。
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

    let codec = DEFAULT_CODEC;
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

/// 搜索筛选的分区 tid（`x/web-interface/search/type` 的 `tids` 位）。
///
/// 与 [`VIDEO_ZONES`] 的分区榜 rid 是两套 ID：搜索接口只认大区 tid，两个表不能混用。
/// 「全部」不进表 —— `tids = 0` 就是它。取值与 PiliPlus 一致（其对齐 B 站网页端搜索）。
pub const VIDEO_SEARCH_ZONES: &[(&str, i64)] = &[
    ("动画", 1),
    ("番剧", 13),
    ("国创", 167),
    ("音乐", 3),
    ("舞蹈", 129),
    ("游戏", 4),
    ("知识", 36),
    ("科技", 188),
    ("运动", 234),
    ("汽车", 223),
    ("生活", 160),
    ("美食", 221),
    ("动物", 217),
    ("鬼畜", 119),
    ("时尚", 115),
    ("资讯", 202),
    ("娱乐", 5),
    ("影视", 181),
    ("纪录片", 177),
    ("电影", 23),
    ("电视剧", 11),
];

/// `search/type` 认的排序键。空串是综合排序（上游对缺省 order 的语义），保持
/// 与既有请求一致地总是发送该位。
const SEARCH_ORDERS: &[&str] = &["", "click", "pubdate", "dm", "stow", "scores"];
/// 发布时间预设换算成上游的 `pubtime_begin_s` / `pubtime_end_s`（unix 秒）。
///
/// 口径与 PiliPlus 对齐：begin 是 N 天前的本地零点，end 是当天 23:59:59 ——
/// 也就是「今天在内的最近 N+1 个自然日」。
fn pub_time_window(pub_time: &str, now: chrono::DateTime<chrono::Local>) -> Option<(i64, i64)> {
    let days_back = match pub_time {
        "day" => 0,
        "week" => 6,
        "halfYear" => 179,
        _ => return None,
    };
    let today = now.date_naive();
    let begin_date = today - chrono::Duration::days(days_back);
    let begin = begin_date
        .and_hms_opt(0, 0, 0)?
        .and_local_timezone(chrono::Local)
        .single()?
        .timestamp();
    let end = today
        .and_hms_opt(23, 59, 59)?
        .and_local_timezone(chrono::Local)
        .single()?
        .timestamp();
    Some((begin, end))
}

/// 组装搜索的筛选 query 位。
///
/// `order` 非法值回落综合排序，`duration` 越界夹回 0-4，负 `tids` 当 0；
/// `pub_time` 未知预设不带发布时间位。默认输入产出与旧请求完全相同的参数
/// （`order=""&duration=0&tids=0`），筛选因此是纯增量。
fn search_filter_query(
    order: Option<&str>,
    duration: Option<i64>,
    tids: Option<i64>,
    pub_time: Option<&str>,
    now: chrono::DateTime<chrono::Local>,
) -> Vec<(&'static str, String)> {
    let order = order.unwrap_or("").trim();
    let order = if SEARCH_ORDERS.contains(&order) {
        order
    } else {
        ""
    };
    let duration = duration.unwrap_or(0).clamp(0, 4);
    let tids = tids.unwrap_or(0).max(0);
    let mut query = vec![
        ("order", order.to_string()),
        ("duration", duration.to_string()),
        ("tids", tids.to_string()),
    ];
    if let Some((begin, end)) = pub_time.and_then(|preset| pub_time_window(preset, now)) {
        query.push(("pubtime_begin_s", begin.to_string()));
        query.push(("pubtime_end_s", end.to_string()));
    }
    query
}
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

    /// 短视频（story feed）。上游是竖屏播放器的入口流，与其他列表接口有三处不同：
    ///
    /// 1. **不需 WBI、不需 appkey/sign**，裸请求即 `code 0`（已实测）。
    /// 2. **需要独立的 `buvid` 请求头**，只写 cookie 不生效：带头时条目的
    ///    `track_id` 为 `story_0.router-story-…`（推荐引擎生效），不带则降级为
    ///    `gateway_fallback_…`（已实测）。降级流仍可用，只是推荐质量下降。
    /// 3. **无游标**，`page` 不作为上游参数（`ps`/`count` 实测无效），仅用于前端
    ///    翻页语义；轮换由服务端时间轴推进，因此取批必须串行（见
    ///    [`STORY_FEED_BATCHES`]）。
    ///
    /// `pull` 必须传 `1`/`0`，传字符串 `"true"` 会直接 -400。
    ///
    /// `more` 是「补货还是首屏」的粗语义，不是批数：一次扣多少次接口属于上游调用
    /// 策略，两个档位与夹取都住在 [`story_batch_count`]。让调用方传具体数字的话，那个
    /// 数字会在两个语言里各存一份，且传大了就绕过了夹取。
    ///
    /// `seen` 是「最近已经给过或已经看过的 bvid」。它存在是因为上游**头部很黏**：
    /// 不传的话同一条会在每次进页时反复出现（实测 6 轮首屏里有一条全中）。空集合
    /// 就是「不过滤」，真网烟测试用的就是那个。
    ///
    /// `seed` 是「以某条视频为起点继续刷」的种子（上游 `bvid` + `display_id`）。实测
    /// （2026-09，真机登录态）带 `bvid` + `display_id=1` 时：该稿件排在结果首位，且与
    /// 不带种子的结果集**零重叠**；只带种子不带 `display_id` 时种子不进首位，
    /// `display_id=2` 又是另一种语义。因此这里固定发 `display_id=1`，只把 `bvid` 当旋钮。
    /// 种子解决的是「每次都从同一个黏性头部开始」，与 `seen`（去重）是两回事。
    pub async fn video_story(
        &self,
        more: bool,
        seen: &HashSet<String>,
        seed: Option<&str>,
    ) -> AppResult<VideoListPage> {
        let batches = story_batch_count(more.then_some(STORY_FEED_MORE_BATCHES));
        let mut pick = StoryPick::new();
        let mut last_err = None;
        for _ in 0..batches {
            match self
                .get_json_with_buvid_header(
                    "https://api.bilibili.com/x/v2/feed/index/story",
                    &story_query_params(seed),
                )
                .await
                .and_then(|text| parse_story(&text))
            {
                Ok(page) => pick.absorb(page, seen),
                // 单批失败不否定整页：拉到一批就能继续消费。全批都败才报错。
                Err(e) => last_err = Some(e),
            }
        }
        let page = pick.finish();
        if page.items.is_empty() {
            return Err(last_err.unwrap_or_else(|| video_err("短视频流未返回内容")));
        }
        Ok(page)
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
    /// 关键词搜索，支持分页与可选筛选（排序 / 时长 / 分区 / 发布时间），
    /// 筛选位由 [`search_filter_query`] 组装。与直播搜索复用同一接口，只是
    /// `search_type` 不同。
    pub async fn video_search(
        &self,
        keyword: &str,
        page: u32,
        order: Option<&str>,
        duration: Option<i64>,
        tids: Option<i64>,
        pub_time: Option<&str>,
    ) -> AppResult<VideoListPage> {
        if keyword.is_empty() {
            return Err(video_err("搜索缺少关键词"));
        }
        let mut query = vec![
            ("search_type", "video".to_string()),
            ("keyword", keyword.to_string()),
            ("page", page.to_string()),
        ];
        query.extend(search_filter_query(
            order,
            duration,
            tids,
            pub_time,
            chrono::Local::now(),
        ));
        let text = self
            .get_json(
                "https://api.bilibili.com/x/web-interface/search/type",
                &query,
            )
            .await?;
        parse_search_videos(&text, page)
    }
    /// UP 主空间视频列表（`x/space/wbi/arc/search`）。
    ///
    /// 获取指定 UP 主的投稿视频，支持分页与排序。需要 WBI 签名。
    pub async fn video_uploader_videos(
        &self,
        mid: &str,
        page: u32,
        order: Option<&str>,
    ) -> AppResult<VideoListPage> {
        if mid.is_empty() {
            return Err(video_err("UP 主视频列表缺少 mid"));
        }
        let mut params = BTreeMap::new();
        params.insert("mid".into(), mid.to_string());
        params.insert("ps".into(), "30".to_string());
        params.insert("tid".into(), "0".into());
        params.insert("pn".into(), page.max(1).to_string());
        params.insert("keyword".into(), "".into());
        let order = matches!(order, Some("click"))
            .then_some("click")
            .unwrap_or("pubdate");
        params.insert("order".into(), order.into());
        let text = self
            .get_json_signed("https://api.bilibili.com/x/space/wbi/arc/search", params)
            .await?;
        parse_uploader_videos(&text)
    }

    /// 稿件详情（`x/web-interface/view`）及 Tags。详情是必需数据；Tags 是补充信息，
    /// 请求失败时降级为空，不阻断播放与评论。
    pub async fn video_archive(&self, bvid: &str) -> AppResult<VideoArchive> {
        if bvid.is_empty() {
            return Err(video_err("稿件详情缺少 bvid"));
        }
        let mut params = BTreeMap::new();
        params.insert("bvid".into(), bvid.to_string());
        let tag_query = [("bvid", bvid.to_string())];
        let (detail, tags) = tokio::join!(
            self.get_json_signed("https://api.bilibili.com/x/web-interface/view", params),
            self.get_public_json("https://api.bilibili.com/x/tag/archive/tags", &tag_query),
        );
        let mut archive = parse_archive(&detail?)?;
        if let Ok(raw) = tags {
            archive.tags = parse_archive_tags(&raw);
        }
        if !archive.author_mid.is_empty() {
            let card_query = [
                ("mid", archive.author_mid.clone()),
                ("photo", "false".to_string()),
            ];
            if let Ok(raw) = self
                .get_public_json("https://api.bilibili.com/x/web-interface/card", &card_query)
                .await
            {
                archive.author_fans = parse_uploader_count(&raw, "follower").unwrap_or(0);
                archive.author_videos = parse_uploader_count(&raw, "archive_count").unwrap_or(0);
            }
        }
        Ok(archive)
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
    ///
    /// `page_size` 缺省走 [`COMMENT_REPLIES_PAGE_SIZE`]（移动端无限滚动的页大小）；
    /// 桌面端的回复分页传自己的 10，请求与 `has_more` 推导共用同一个值。
    pub async fn video_comment_replies(
        &self,
        aid: &str,
        root: i64,
        page: u32,
        page_size: Option<u32>,
    ) -> AppResult<VideoCommentPage> {
        if aid.is_empty() {
            return Err(video_err("二级回复缺少 aid"));
        }
        if root <= 0 {
            return Err(video_err("二级回复缺少 root"));
        }
        let page_size = page_size
            .map(|size| (size as i64).max(1))
            .unwrap_or(COMMENT_REPLIES_PAGE_SIZE);
        let text = self
            .get_json(
                "https://api.bilibili.com/x/v2/reply/reply",
                &[
                    ("type", "1".to_string()),
                    ("oid", aid.to_string()),
                    ("root", root.to_string()),
                    ("pn", page.max(1).to_string()),
                    ("ps", page_size.to_string()),
                    ("sort", "2".to_string()),
                ],
            )
            .await?;
        parse_comment_replies(&text, page.max(1), page_size)
    }

    /// PGC/UGC 双链路的公共骨架：`ep_id` 非空走 PGC 端点，否则要求 `bvid`
    /// 走 UGC 端点，各自插入额外参数、发起签名请求并反序列化成根对象。
    /// 端点、额外参数、json 错误前缀与缺 bvid 的错误串由调用方传入
    /// （各接口不同），全部逐字保持；负载提取留在调用方。
    async fn fork_json(
        &self,
        mut params: BTreeMap<String, String>,
        request: &VideoPlayRequest,
        bvid_missing: &str,
        pgc: (&str, &[(&str, &str)], &str),
        ugc: (&str, &[(&str, &str)], &str),
    ) -> AppResult<Value> {
        let (text, json_label) = match request.ep_id.as_deref().filter(|id| !id.is_empty()) {
            Some(ep_id) => {
                let (url, extras, label) = pgc;
                params.insert("ep_id".into(), ep_id.to_string());
                for (key, value) in extras {
                    params.insert((*key).into(), (*value).into());
                }
                (self.get_json_signed(url, params).await?, label)
            }
            None => {
                let (url, extras, label) = ugc;
                let bvid = request
                    .bvid
                    .as_deref()
                    .filter(|bvid| !bvid.is_empty())
                    .ok_or_else(|| video_err(bvid_missing))?;
                params.insert("bvid".into(), bvid.to_string());
                for (key, value) in extras {
                    params.insert((*key).into(), (*value).into());
                }
                (self.get_json_signed(url, params).await?, label)
            }
        };
        serde_json::from_str(&text).map_err(|e| video_err(format!("{json_label} json: {e}")))
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

        let root = self
            .fork_json(
                params,
                request,
                "UGC 播放请求缺少 bvid",
                (
                    "https://api.bilibili.com/pgc/player/web/v2/playurl",
                    &[("support_multi_audio", "true")],
                    "PGC playurl",
                ),
                (
                    "https://api.bilibili.com/x/player/wbi/playurl",
                    &[("try_look", "1"), ("web_location", "1315873")],
                    "UGC playurl",
                ),
            )
            .await?;
        let data = match request.ep_id.as_deref().filter(|id| !id.is_empty()) {
            Some(_) => root.pointer("/result/video_info").cloned().ok_or_else(|| {
                video_err("PGC playurl 缺少 result.video_info（可能受版权或地区限制）")
            })?,
            None => root
                .get("data")
                .cloned()
                .ok_or_else(|| video_err("UGC playurl 缺少 data"))?,
        };

        let (video, audio, quality, quality_label, accept_quality) =
            select_streams(&data, request)?;
        // 两条轨的 sidx 预抓互不依赖（各自独立的 CDN Range 请求），并发执行
        // 省掉一次串行往返；错误优先级保持视频轨在前，与原先的串行顺序一致。
        // 轨内的候选地址回退（mcdn 403 → upos 镜像）是依赖顺序，保持串行。
        let (video_track, audio_track) = tokio::join!(
            self.video_track(&video, true),
            self.video_track(&audio, false)
        );
        let video = video_track?;
        let audio = audio_track?;
        Ok(VideoPlaySelection {
            video,
            audio,
            quality,
            quality_label,
            accept_quality,
        })
    }

    /// 取 DLNA 投屏直链：html5 playurl 的 MP4 `durl`。
    ///
    /// 电视端的 DLNA 渲染器只认渐进式流（MP4/HLS），不能播 DASH MPD；B 站
    /// html5 接口（`platform=html5&high_quality=1`）返回 480P 内的 MP4 durl，
    /// 经中继注入 Referer 后电视可直连。PiliPili 的投屏同源。
    pub async fn video_cast_url(&self, request: &VideoPlayRequest) -> AppResult<String> {
        if request.cid <= 0 {
            return Err(video_err("投屏请求缺少 cid"));
        }
        let mut params = BTreeMap::new();
        params.insert("cid".into(), request.cid.to_string());
        params.insert("qn".into(), "64".into());
        params.insert("fnval".into(), "1".into());
        params.insert("platform".into(), "html5".into());
        params.insert("high_quality".into(), "1".into());
        params.insert("fnver".into(), "0".into());

        let root = self
            .fork_json(
                params,
                request,
                "投屏请求缺少 bvid",
                (
                    "https://api.bilibili.com/pgc/player/web/v2/playurl",
                    &[],
                    "PGC html5 playurl",
                ),
                (
                    "https://api.bilibili.com/x/player/wbi/playurl",
                    &[("try_look", "1")],
                    "html5 playurl",
                ),
            )
            .await?;
        let data = match request.ep_id.as_deref().filter(|id| !id.is_empty()) {
            Some(_) => root.pointer("/result/video_info").cloned().ok_or_else(|| {
                video_err("PGC html5 playurl 缺少 result.video_info（可能受版权或地区限制）")
            })?,
            None => root
                .get("data")
                .cloned()
                .ok_or_else(|| video_err("html5 playurl 缺少 data"))?,
        };

        parse_cast_durl(&data)
    }

    /// 取 CC 字幕列表（player v2 接口）。
    ///
    /// 手动 CC 公开可用；AI 字幕（`ai-` 前缀）需登录身份才会返回。
    pub async fn video_subtitles(
        &self,
        request: &VideoPlayRequest,
    ) -> AppResult<Vec<VideoSubtitle>> {
        if request.cid <= 0 {
            return Err(video_err("字幕请求缺少 cid"));
        }
        let mut params = BTreeMap::new();
        params.insert("cid".into(), request.cid.to_string());
        let root = self
            .fork_json(
                params,
                request,
                "字幕请求缺少 bvid",
                ("https://api.bilibili.com/x/player/wbi/v2", &[], "player v2"),
                ("https://api.bilibili.com/x/player/wbi/v2", &[], "player v2"),
            )
            .await?;
        Ok(parse_subtitles(root.pointer("/data/subtitle/subtitles")))
    }

    /// 缩略图（快照/storyboard）元数据（`x/player/videoshot`）。
    ///
    /// 获取缩略图雪碧图 URL 列表与时间戳对应表。视频无快照或不支持时返回 `Ok(None)`。
    pub async fn video_storyboard(
        &self,
        request: &VideoPlayRequest,
    ) -> AppResult<Option<VideoStoryboard>> {
        if request.cid <= 0 {
            return Ok(None);
        }

        let bvid = match request.bvid.as_deref().filter(|s| !s.is_empty()) {
            Some(bvid) => bvid.to_string(),
            None => {
                if let Some(ep_id) = request.ep_id.as_deref().filter(|s| !s.is_empty()) {
                    match self.video_season(None, Some(ep_id)).await {
                        Ok(season) => {
                            if let Some(ep) = season.episodes.into_iter().find(|e| e.ep_id == ep_id)
                            {
                                ep.bvid
                            } else {
                                return Ok(None);
                            }
                        }
                        Err(_) => return Ok(None),
                    }
                } else {
                    return Ok(None);
                }
            }
        };

        let cid_str = request.cid.to_string();
        let query = [
            ("bvid", bvid.as_str()),
            ("cid", cid_str.as_str()),
            ("index", "1"),
        ];

        let response = match self
            .video_fetch(
                self.client
                    .get("https://api.bilibili.com/x/player/videoshot")
                    .query(&query),
                "快照请求失败",
                "快照请求返回",
                false,
                false,
            )
            .await
        {
            Ok(res) => res,
            Err(_) => return Ok(None),
        };

        let body: Value = match response.json().await {
            Ok(v) => v,
            Err(_) => return Ok(None),
        };

        if body.get("code").and_then(|v| v.as_i64()) != Some(0) {
            return Ok(None);
        }

        let data = match body.get("data").filter(|d| d.is_object()) {
            Some(d) => d,
            None => return Ok(None),
        };

        let img_x_len = data.get("img_x_len").and_then(|v| v.as_u64()).unwrap_or(10) as u32;
        let img_y_len = data.get("img_y_len").and_then(|v| v.as_u64()).unwrap_or(10) as u32;
        let img_x_size = data
            .get("img_x_size")
            .and_then(|v| v.as_u64())
            .unwrap_or(160) as u32;
        let img_y_size = data
            .get("img_y_size")
            .and_then(|v| v.as_u64())
            .unwrap_or(90) as u32;

        let images: Vec<String> = data
            .get("image")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| item.as_str())
                    .map(|s| {
                        if s.starts_with("//") {
                            format!("https:{s}")
                        } else if s.starts_with("http://") {
                            s.replacen("http://", "https://", 1)
                        } else {
                            s.to_string()
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();

        if images.is_empty() {
            return Ok(None);
        }

        let mut index: Vec<u32> = data
            .get("index")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| item.as_u64().map(|n| n as u32))
                    .collect()
            })
            .unwrap_or_default();

        if index.len() <= 1
            && let Some(pvdata_url) = data
                .get("pvdata")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
        {
            let full_url = if pvdata_url.starts_with("//") {
                format!("https:{pvdata_url}")
            } else if pvdata_url.starts_with("http://") {
                pvdata_url.replacen("http://", "https://", 1)
            } else {
                pvdata_url.to_string()
            };
            if let Ok(res) = self
                .video_fetch(
                    self.client.get(&full_url),
                    "pvdata请求失败",
                    "pvdata请求返回",
                    false,
                    false,
                )
                .await
                && let Ok(bytes) = res.bytes().await
            {
                let (pairs, _) = bytes.as_chunks::<2>();
                index = pairs
                    .iter()
                    .map(|pair| u16::from_be_bytes(*pair) as u32)
                    .collect();
            }
        }

        if index.len() <= 1 {
            return Ok(None);
        }

        Ok(Some(VideoStoryboard {
            img_x_len,
            img_y_len,
            img_x_size,
            img_y_size,
            images,
            index,
        }))
    }

    /// 手写 GET 的公共骨架：站点 UA + VIDEO_REFERER + 状态码检查。
    ///
    /// 字幕、sidx Range 与 VOD 弹幕三个调用点共用；错误前缀与可重试位
    /// 各不相同，由调用方传入以保持错误串逐字节不变。`allow_304` 只给
    /// 弹幕接口：304 是段号越界的正常终点，不能当错误。Range 头与 query
    /// 由调用方先拼进 builder，body 读取同样留在调用方。
    async fn video_fetch(
        &self,
        builder: reqwest::RequestBuilder,
        fail: &str,
        status: &str,
        retry: bool,
        allow_304: bool,
    ) -> AppResult<reqwest::Response> {
        let err = |message: String| {
            let error = video_err(message);
            if retry { error.retryable() } else { error }
        };
        let response = builder
            .header("user-agent", DEFAULT_USER_AGENT)
            .header("referer", VIDEO_REFERER)
            .send()
            .await
            .map_err(|e| err(format!("{fail}: {e}")))?;
        let code = response.status();
        if allow_304 && code.as_u16() == 304 {
            return Ok(response);
        }
        if !code.is_success() {
            return Err(err(format!("{status} HTTP {}", code.as_u16())));
        }
        Ok(response)
    }

    /// 拉取字幕 JSON 原文（aisubtitle 主机无 CORS 头，必须由本端代拉）。
    pub async fn fetch_subtitle(&self, url: &str) -> AppResult<String> {
        let response = self
            .video_fetch(
                self.client.get(url),
                "字幕请求失败",
                "字幕请求返回",
                false,
                false,
            )
            .await?;
        response
            .text()
            .await
            .map_err(|e| video_err(format!("字幕响应读取失败: {e}")))
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
        // init 段与 sidx 在字节布局上连续（`index_start == init_end + 1`）：并成
        // 一次 Range 请求把两者一起取回，init 段就是白拿的。它只有 1KB 上下，
        // 却要在播放器起播时单独付一次完整 CDN 往返（实测视频轨 97ms、音轨
        // 70ms，且串在首个媒体分片之前）。不连续时退回两次请求，语义与原先一致。
        let contiguous = index_start == init_end + 1;
        let mut last_error = video_err("representation 缺少 base_url");
        for candidate in &candidates {
            let (init_bytes, sidx_bytes) = if contiguous {
                match self.fetch_range(candidate, 0, index_end).await {
                    Ok(bytes) => match split_init_and_sidx(&bytes, init_end) {
                        Ok(parts) => parts,
                        Err(error) => {
                            last_error = error;
                            continue;
                        }
                    },
                    Err(error) => {
                        last_error = error;
                        continue;
                    }
                }
            } else {
                let init_bytes = match self.fetch_range(candidate, 0, init_end).await {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        last_error = error;
                        continue;
                    }
                };
                match self.fetch_range(candidate, index_start, index_end).await {
                    Ok(bytes) => (init_bytes, bytes),
                    Err(error) => {
                        last_error = error;
                        continue;
                    }
                }
            };
            let sidx = parse_sidx(&sidx_bytes, index_end)?;
            return Ok(VideoTrack {
                base_url: candidate.clone(),
                init_end,
                init_bytes,
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
            .video_fetch(
                self.client
                    .get(url)
                    .header("range", format!("bytes={start}-{end}")),
                "媒体 Range 请求失败",
                "媒体 Range 请求返回",
                true,
                false,
            )
            .await?;
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
            .video_fetch(
                self.client
                    .get("https://api.bilibili.com/x/v2/dm/web/seg.so")
                    .query(&[
                        ("type", "1".to_string()),
                        ("oid", cid.to_string()),
                        ("segment_index", segment_index.max(1).to_string()),
                    ]),
                "弹幕请求失败",
                "弹幕接口返回",
                true,
                true,
            )
            .await?;

        // 304 = 段号越界，是遍历的正常终点。上游同时会带 `bili-status-code: -304`，
        // 但该头并非每次都出现（实测有仅 304 无该头的应答），所以只认状态码。
        if response.status().as_u16() == 304 {
            return Ok(VideoDanmakuSegment {
                has_more: false,
                items: Vec::new(),
            });
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
    fn split_init_and_sidx_cuts_at_the_recorded_boundary() {
        // 对齐实测形态：init `0-937`、sidx 从 938 开始。
        let mut merged = vec![0xAA_u8; 938];
        merged.extend_from_slice(b"sidx");
        merged.extend_from_slice(&[0xBB_u8; 20]);
        let (init, sidx) = split_init_and_sidx(&merged, 937).expect("应按边界切开");
        assert_eq!(
            init.len(),
            938,
            "init 段必须含 0..=init_end 共 init_end+1 字节"
        );
        assert!(init.iter().all(|byte| *byte == 0xAA));
        assert_eq!(sidx.len(), 24);
        assert_eq!(&sidx[..4], b"sidx", "sidx 起点不能偏移");
    }

    #[test]
    fn split_init_and_sidx_rejects_truncated_merged_response() {
        // 上游只回了 init 的一部分：既不能把半个 init 当成 init，也不能拿它当 sidx。
        let truncated = vec![0xAA_u8; 100];
        assert!(split_init_and_sidx(&truncated, 937).is_err());
        // 恰好只够 init、没有 sidx：可以切开，sidx 为空（由 parse_sidx 报错）。
        let init_only = vec![0xAA_u8; 938];
        let (init, sidx) = split_init_and_sidx(&init_only, 937).expect("边界上应可切开");
        assert_eq!(init.len(), 938);
        assert!(sidx.is_empty());
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
        assert_eq!(sidx.segments[0].t_end, 80_000);
        assert_eq!(sidx.segments[1].t_end, 160_000);
        assert_eq!(sidx.segments[2].t_end, 200_000);
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
            // init 段字节本身与 MPD 合成无关，占位即可。
            init_bytes: vec![0_u8; 938],
            sidx: Sidx {
                timescale: 16_000,
                segments: vec![
                    SidxSegment {
                        start_byte: 1602,
                        end_byte: 2000,
                        t_end: 80_000,
                    },
                    SidxSegment {
                        start_byte: 2001,
                        end_byte: 3000,
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
    fn mpd_pairs_segment_list_with_precise_timelines_per_track() {
        let mut audio = track_fixture();
        audio.codecs = "mp4a.40.2".into();
        audio.rep_id = "30232".into();
        audio.width = None;
        audio.height = None;
        audio.frame_rate = None;
        audio.sar = None;
        // 音轨 timescale 与视频轨不同（实测形态 48000）：两条时间轴必须各自成立。
        audio.sidx = Sidx {
            timescale: 48_000,
            segments: vec![
                SidxSegment {
                    start_byte: 1602,
                    end_byte: 2000,
                    t_end: 240_000,
                },
                SidxSegment {
                    start_byte: 2001,
                    end_byte: 3000,
                    t_end: 480_000,
                },
            ],
        };
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

        // dash.js 原生支持 SegmentList + SegmentTimeline：第 k 个 <S> 与第 k 个
        // <SegmentURL> 一一对应，逐片字节区间与时刻精确，不需要前端时间轴修补。
        assert!(mpd.contains("<SegmentList"), "必须输出 SegmentList");
        assert!(
            mpd.contains("<SegmentTimeline>"),
            "必须输出 SegmentTimeline"
        );
        assert!(
            mpd.contains(
                r#"<Initialization sourceURL="http://127.0.0.1:5001/live" range="0-937"/>"#
            )
        );
        // 分片共用代理 URL，差异只在 Range；逐片 mediaRange 来自 sidx。
        assert!(mpd.contains(
            r#"<SegmentURL media="http://127.0.0.1:5001/live" mediaRange="1602-2000"/>"#
        ));
        assert!(mpd.contains(
            r#"<SegmentURL media="http://127.0.0.1:5002/live" mediaRange="2001-3000"/>"#
        ));
        assert!(
            !mpd.contains("seg="),
            "不得再给分片拼 seg 查询参数（旧播放器补丁）"
        );
        // 两条轨的 timescale 各自独立：视频 16000、音频 48000。
        assert!(mpd.contains(r#"<SegmentList timescale="16000">"#));
        assert!(mpd.contains(r#"<SegmentList timescale="48000">"#));
        // S 的 t/d 用该轨 sidx 原单位写出。
        assert!(mpd.contains(r#"<S t="0" d="80000"/>"#));
        assert!(mpd.contains(r#"<S t="80000" d="80000"/>"#));
        assert!(mpd.contains(r#"mediaPresentationDuration="PT10S""#));
        assert!(mpd.contains(r#"codecs="avc1.640033""#));
        assert!(mpd.contains(r#"codecs="mp4a.40.2""#));
    }

    #[test]
    fn mpd_segment_timeline_carries_unequal_durations() {
        // 实测形态：中途出现短片（2.7s），总时长因此小于「片数 × 首片时长」。
        // 等长假设（固定 duration 展开时间轴）会让短片后的 seek 选错分片，
        // 这里锁死逐片精确时长。
        let mut video = track_fixture();
        video.sidx.segments = vec![
            SidxSegment {
                start_byte: 1602,
                end_byte: 2000,
                t_end: 80_000,
            },
            SidxSegment {
                start_byte: 2001,
                end_byte: 3000,
                t_end: 160_000,
            },
            SidxSegment {
                start_byte: 3001,
                end_byte: 3500,
                t_end: 203_200,
            },
        ];
        let selection = VideoPlaySelection {
            video: video.clone(),
            audio: video,
            quality: 32,
            quality_label: "清晰 480P".into(),
            accept_quality: Vec::new(),
        };

        let mpd = build_mpd(
            &selection,
            "http://127.0.0.1:5001/live",
            "http://127.0.0.1:5002/live",
        );

        // 逐片 t/d 精确等于 sidx 边界：5s、5s、2.7s（timescale 16000）。
        // 末片若按平均槽位（4.23s）或首片时长（5s）展开，2.7s 片内的任何时刻
        // 都会被算进错误的分片。
        assert!(mpd.contains(r#"<S t="160000" d="43200"/>"#));
        assert!(mpd.contains(r#"mediaPresentationDuration="PT12.7S""#));
    }

    #[test]
    fn mpd_escapes_xml_special_characters_in_urls() {
        let selection = VideoPlaySelection {
            video: track_fixture(),
            audio: track_fixture(),
            quality: 32,
            quality_label: "清晰 480P".into(),
            accept_quality: Vec::new(),
        };
        let mpd = build_mpd(
            &selection,
            "http://127.0.0.1:5001/live?a=1&b=<2>",
            "http://127.0.0.1:5002/live",
        );
        // URL 里的 & 与 < 必须转义，否则 MPD 不是合法 XML。
        assert!(mpd.contains("http://127.0.0.1:5001/live?a=1&amp;b=&lt;2&gt;"));
        assert!(!mpd.contains("live?a=1&b="), "裸 & 会让 MPD 不是合法 XML");
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
    fn story_maps_player_args_and_keeps_mixed_orientations() {
        let raw = serde_json::json!({
            "code": 0,
            "data": { "items": [
                // 竖屏条目：cid 在 player_args、aid 在 param、封面在 cover。
                { "card_goto": "vertical_av", "goto": "vertical_av",
                  "param": "117263042742272", "bvid": "BV1VXYe6rEoc",
                  "player_args": { "aid": 117_263_042_742_272_i64, "cid": 41_855_094_127_i64, "type": "av" },
                  "title": "竖屏", "cover": "http://i1.hdslb.com/bfs/archive/a.jpg",
                  "ff_cover": "http://i1.hdslb.com/bfs/storyff/b.jpg",
                  "duration": 93, "pubdate": 1_789_292_152,
                  "dimension": { "width": 1080, "height": 1920, "rotate": 0 },
                  "owner": { "name": "up主", "face": "https://i2.hdslb.com/bfs/face/x.jpg",
                             "fans": 12345 },
                  "stat": { "view": 187_172, "danmaku": 24 } },
                // 横屏条目：story 是混合流，照样保留，由前端按 dimension 适配舞台。
                { "card_goto": "vertical_av", "param": "2", "bvid": "BV1y",
                  "player_args": { "cid": 2 }, "title": "横屏", "cover": "",
                  "dimension": { "width": 1920, "height": 1080, "rotate": 0 } },
                // 非竖屏卡：card_goto 不是 vertical_av。
                { "card_goto": "ad_av", "param": "3", "bvid": "BV1z", "player_args": { "cid": 3 } },
                // 缺 cid：竖屏舞台无法直接起播。
                { "card_goto": "vertical_av", "param": "4", "bvid": "BV1w", "player_args": { "aid": 4 } },
            ]}
        })
        .to_string();

        let page = parse_story(&raw).expect("短视频流应解析成功");
        assert_eq!(page.items.len(), 2, "只保留取流键齐备的 vertical_av 条目");
        let vertical = &page.items[0];
        // aid 取 param（字符串形态），必须保持全精度。
        assert_eq!(vertical.aid, "117263042742272");
        assert_eq!(vertical.cid, Some(41_855_094_127));
        assert_eq!(vertical.view, 187_172);
        assert_eq!(vertical.duration, 93);
        // 粉丝数是 story 白带的（`owner.fans`），信息行因此不必再请求详情。
        assert_eq!(vertical.author_fans, Some(12_345));
        // 封面优先 cover 而不是首帧图 ff_cover，且必须升成 https。
        assert_eq!(vertical.cover, "https://i1.hdslb.com/bfs/archive/a.jpg");
        let dimension = vertical.dimension.expect("竖屏判定依赖 dimension");
        assert!(dimension.height > dimension.width);
        assert!(
            page.items[1]
                .dimension
                .expect("横屏条目也带 dimension")
                .width
                > 1000
        );
        assert!(page.has_more, "无游标轮换流：非空即可继续拉");
    }

    #[test]
    fn story_falls_back_to_first_frame_cover_and_player_args_aid() {
        let raw = serde_json::json!({
            "code": 0,
            "data": { "items": [
                { "card_goto": "vertical_av", "bvid": "BV1x",
                  "player_args": { "aid": 117_190_447_667_445_i64, "cid": 41_467_905_537_i64 },
                  "title": "无 param 与 cover", "ff_cover": "//i0.hdslb.com/bfs/storyff/c.jpg" },
            ]}
        })
        .to_string();

        let page = parse_story(&raw).expect("短视频流应解析成功");
        let item = &page.items[0];
        assert_eq!(
            item.aid, "117190447667445",
            "缺 param 时回退 player_args.aid"
        );
        assert_eq!(item.cover, "https://i0.hdslb.com/bfs/storyff/c.jpg");
        // 上游没有下发 dimension 时不能编造画幅。
        assert!(item.dimension.is_none());
        // 没有 fans 字段时是「没说」而不是「0 个粉丝」。
        assert_eq!(item.author_fans, None);
    }

    /// 只有 bvid 有意义的 story 条目：取批/去重的测试都只看 bvid。
    fn story_test_item(bvid: &str) -> VideoItem {
        VideoItem {
            bvid: bvid.to_string(),
            aid: String::new(),
            cid: Some(1),
            title: String::new(),
            cover: String::new(),
            author: String::new(),
            author_face: None,
            author_fans: None,
            duration: 0,
            view: 0,
            danmaku: 0,
            pubdate: 0,
            rcmd_reason: None,
            dimension: None,
        }
    }

    fn story_test_batch(bvids: &[&str]) -> VideoListPage {
        VideoListPage {
            has_more: true,
            items: bvids.iter().map(|bvid| story_test_item(bvid)).collect(),
        }
    }

    #[test]
    fn story_batches_dedupe_across_rounds() {
        // 串行取批零重复是实测结论，但上游无游标、不作任何保证，去重不能省。
        let batch = story_test_batch;

        let empty_seen = HashSet::new();
        let mut pick = StoryPick::new();
        pick.absorb(batch(&["a", "b"]), &empty_seen);
        pick.absorb(batch(&["b", "c"]), &empty_seen);
        let combined = pick.finish();
        let bvids: Vec<&str> = combined
            .items
            .iter()
            .map(|item| item.bvid.as_str())
            .collect();
        assert_eq!(bvids, ["a", "b", "c"], "跨批重复必须按首次出现顺序折叠");
        assert!(combined.has_more);

        let mut nothing = StoryPick::new();
        nothing.absorb(batch(&[]), &empty_seen);
        assert!(!nothing.finish().has_more, "新条目耗尽即停");
    }

    #[test]
    fn story_pick_prefers_unseen_and_falls_back_to_repeats() {
        let batch = story_test_batch;
        let seen: HashSet<String> = ["a".to_string(), "b".to_string()].into_iter().collect();

        // 见过的排掉，只给没见过的 —— 这正是「总是同一批」的修法。
        let mut pick = StoryPick::new();
        pick.absorb(batch(&["a", "b", "c"]), &seen);
        let picked = pick.finish();
        let fresh: Vec<&str> = picked.items.iter().map(|item| item.bvid.as_str()).collect();
        assert_eq!(fresh, ["c"]);

        // 整批都见过时不能给空页：`has_more` 就是「这批非空」，空了会被前端当成到底。
        let mut all_seen = StoryPick::new();
        all_seen.absorb(batch(&["a", "b"]), &seen);
        let fallback = all_seen.finish();
        assert_eq!(fallback.items.len(), 2, "兜底给重复条目而不是空列表");
        // 但要落下 `has_more`：全是重复的一页会被前端整页去掉，流长度不变而补货判定
        // 仍然成立，回 true 就会每轮一次真实往返地空转。
        assert!(!fallback.has_more, "这批没有新的即为暂时到底");
    }

    #[test]
    fn story_batch_count_defaults_and_clamps() {
        // 首屏不传 = 用小的那档（少等一个往返）。
        assert_eq!(story_batch_count(None), STORY_FEED_BATCHES);
        // 传具体数时原值生效（补货档走这条）。
        assert_eq!(
            story_batch_count(Some(STORY_FEED_MORE_BATCHES)),
            STORY_FEED_MORE_BATCHES
        );
        // 0 会被夹到 1：拉 0 批返回空列表，上层会当成取流失败。
        assert_eq!(story_batch_count(Some(0)), 1);
        // 超大值夹到上限，而不是真的打那么多次接口。
        assert_eq!(story_batch_count(Some(usize::MAX)), STORY_FEED_MAX_BATCHES);
        // 两个档位的差异是设计的一部分：首屏快、补货多。写成同一个值就把这个设计
        // 无声地取消了，而两端调用点看起来都还正常。经函数比较而不是直接比两个常量：
        // 后者是编译期常量折叠（clippy 也会指出那不是断言），而这里要守的是「两条
        // 调用路径拿到的批数不同」。
        assert!(
            story_batch_count(Some(STORY_FEED_MORE_BATCHES)) > story_batch_count(None),
            "补货档必须比首屏多拉"
        );
    }

    #[test]
    fn story_query_params_only_adds_seed_with_display_id() {
        // 无种子：只有 pull=1（现状路径）。
        assert_eq!(story_query_params(None), vec![("pull", "1".to_string())]);
        // 空 / 零 / 空白当无种子，避免把「没有」编码成一个空 bvid 传上去。
        for empty in [Some(""), Some("   "), Some("0")] {
            assert_eq!(story_query_params(empty), vec![("pull", "1".to_string())]);
        }
        // 有种子：bvid + display_id=1 必须成对出现 —— 实测只有这样才能让种子排首位。
        assert_eq!(
            story_query_params(Some("BV1Sw8U6cEEV")),
            vec![
                ("pull", "1".to_string()),
                ("bvid", "BV1Sw8U6cEEV".to_string()),
                ("display_id", "1".to_string()),
            ]
        );
        // 两侧空白要修剪，否则上游会当成非法 bvid。
        assert_eq!(
            story_query_params(Some(" BV1Sw8U6cEEV ")),
            vec![
                ("pull", "1".to_string()),
                ("bvid", "BV1Sw8U6cEEV".to_string()),
                ("display_id", "1".to_string()),
            ]
        );
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
        // 搜索条目自带 Unix 秒发布时间。
        assert_eq!(first.pubdate, 1_759_000_000);
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
    fn parse_uploader_videos_reads_created_as_pubdate() {
        let raw = serde_json::json!({
            "code": 0,
            "data": {
                "list": {
                    "vlist": [
                        // 当前接口形状：created 是 Unix 秒（数字）。
                        {
                            "bvid": "BV1up",
                            "aid": 117_191_437_455_648_i64,
                            "title": "投稿",
                            "pic": "http://i1.hdslb.com/bfs/archive/a.jpg",
                            "author": "up",
                            "length": "10:30",
                            "play": 100,
                            "video_review": 5,
                            "created": 1_788_235_200
                        },
                        // 老接口形状：北京时间字符串，按 UTC 解析再减 8 小时
                        // 还原真实时刻，与上一条数字是同一时刻。
                        { "bvid": "BV2up", "aid": 2, "title": "字符串日期", "created": "2026-09-01 12:00" },
                        // created 缺失或畸形：pubdate 落 0，前端不渲染日期。
                        { "bvid": "BV3up", "aid": 3, "title": "无日期", "created": "not-a-date" }
                    ]
                },
                "page": { "count": 60, "pn": 1, "ps": 30 }
            }
        })
        .to_string();
        let page = parse_uploader_videos(&raw).unwrap();
        assert!(page.has_more);
        assert_eq!(page.items.len(), 3);
        // 投稿列表只给 `length`（`10:30`），没有 `duration`：漏掉这一路会全部显示 0:00。
        assert_eq!(page.items[0].duration, 630);
        assert_eq!(page.items[1].duration, 0);
        assert_eq!(page.items[0].pubdate, 1_788_235_200);
        assert_eq!(page.items[1].pubdate, 1_788_235_200);
        assert_eq!(page.items[2].pubdate, 0);
    }

    #[test]
    fn item_duration_prefers_duration_then_falls_back_to_length() {
        // 带 `duration` 的接口不受 `length` 影响（同时给出时以 `duration` 为准）。
        let both = serde_json::json!({ "duration": 300, "length": "10:30" });
        assert_eq!(item_duration(&both), 300);
        // 投稿列表的形态：只有字符串 `length`。
        let only_length = serde_json::json!({ "length": "1:02:03" });
        assert_eq!(item_duration(&only_length), 3_723);
        // 畸形与缺失都退回 0，由前端渲染成 0:00 占位。
        assert_eq!(item_duration(&serde_json::json!({ "length": "" })), 0);
        assert_eq!(item_duration(&serde_json::json!({})), 0);
    }

    /// 测试内共用的「已知本地时刻」构造（`Local::with_ymd_and_hms` 是
    /// `TimeZone` trait 方法，这里走 NaiveDate 路径避免引入 trait 导入）。
    fn local_dt(y: i32, m: u32, d: u32, h: u32) -> chrono::DateTime<chrono::Local> {
        chrono::NaiveDate::from_ymd_opt(y, m, d)
            .unwrap()
            .and_hms_opt(h, 0, 0)
            .unwrap()
            .and_local_timezone(chrono::Local)
            .unwrap()
    }

    #[test]
    fn search_filter_query_defaults_match_the_legacy_request() {
        // 全默认时与旧请求逐字相同：order 空串、duration/tids 归零，不带发布时间位。
        let query = search_filter_query(None, None, None, None, local_dt(2026, 9, 6, 12));
        assert_eq!(
            query,
            vec![
                ("order", "".to_string()),
                ("duration", "0".to_string()),
                ("tids", "0".to_string()),
            ]
        );
    }

    #[test]
    fn search_filter_query_sanitizes_unknown_values() {
        let query = search_filter_query(
            Some("hack"),
            Some(9),
            Some(-3),
            Some("lastYear"),
            local_dt(2026, 9, 6, 12),
        );
        assert_eq!(
            query,
            vec![
                ("order", "".to_string()),
                ("duration", "4".to_string()),
                ("tids", "0".to_string()),
            ]
        );
    }

    #[test]
    fn pub_time_window_spans_local_midnights() {
        // 本地时区语义：拿同一日期的本地零点比对时间戳，DST 边界之外两边
        // 走同一条构造路径，时区差异互相抵消。
        fn midnight(y: i32, m: u32, d: u32) -> i64 {
            local_dt(y, m, d, 0).timestamp()
        }

        let now = local_dt(2026, 9, 6, 12);
        // 最近一天：今天全天。
        let (begin, end) = pub_time_window("day", now).unwrap();
        assert_eq!(begin, midnight(2026, 9, 6));
        assert_eq!(end - begin, 24 * 3600 - 1);

        // 最近一周：6 天前零点起（今天在内的 7 个自然日）。
        let (begin, _) = pub_time_window("week", now).unwrap();
        assert_eq!(begin, midnight(2026, 8, 31));

        // 最近半年：179 天前零点起（今天在内的 180 个自然日）。
        let (begin, _) = pub_time_window("halfYear", now).unwrap();
        assert_eq!(begin, midnight(2026, 3, 11));

        assert!(pub_time_window("month", now).is_none());
        // 跨月回退由 chrono 的日期算术处理，这里只固定一个已知组合。
        let (begin, _) = pub_time_window("week", local_dt(2026, 3, 1, 8)).unwrap();
        assert_eq!(begin, midnight(2026, 2, 23));
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
    fn parse_archive_collects_ugc_season_episodes() {
        let raw = serde_json::json!({
            "code": 0,
            "data": {
                "bvid": "BV1Ybuq6nEYq",
                "cid": 311001234i64,
                "ugc_season": {
                    "title": "合集标题",
                    "sections": [
                        {
                            "title": "正片",
                            "episodes": [
                                {
                                    "bvid": "BV1Ybuq6nEYq",
                                    "cid": 311001234i64,
                                    "aid": 117075725000671i64,
                                    "title": "1",
                                    "long_title": "",
                                    "cover": "https://i0.hdslb.com/bfs/archive/1.jpg",
                                    "arc": { "title": "第一话", "duration": 620 }
                                },
                                { "bvid": "BV1Zz421z7Cx", "cid": 311001999i64, "title": "2", "long_title": "第二话" },
                                { "bvid": "", "cid": 5 }  // 脏数据：跳过
                            ]
                        }
                    ]
                }
            }
        })
        .to_string();
        let archive = parse_archive(&raw).unwrap();
        let season = archive.ugc_season.as_ref().unwrap();
        assert_eq!(season.title, "合集标题");
        assert_eq!(season.episodes.len(), 2);
        // long_title 空则用 arc.title；aid 数字转字符串。
        assert_eq!(season.episodes[0].title, "第一话");
        assert_eq!(season.episodes[0].aid, "117075725000671");
        assert_eq!(season.episodes[0].duration, 620);
        assert_eq!(season.episodes[1].title, "第二话");

        // 无 ugc_season 字段 → None；单集合 → 不成连播列表。
        let plain = serde_json::json!({ "code": 0, "data": { "bvid": "BV1Ybuq6nEYq", "cid": 1 } });
        assert!(
            parse_archive(&plain.to_string())
                .unwrap()
                .ugc_season
                .is_none()
        );
        let single = serde_json::json!({
            "code": 0,
            "data": { "bvid": "BV1Ybuq6nEYq", "cid": 1,
                "ugc_season": { "title": "t", "sections": [ { "episodes": [ { "bvid": "BV1Y", "cid": 1 } ] } ] } }
        });
        assert!(
            parse_archive(&single.to_string())
                .unwrap()
                .ugc_season
                .is_none()
        );
    }

    #[test]
    fn parse_archive_collects_multi_p_pages() {
        let raw = serde_json::json!({
            "code": 0,
            "data": {
                "bvid": "BV1Ykt46iEYW",
                "cid": 41444770475i64,
                "pages": [
                    { "page": 1, "cid": 41444770475i64, "part": "前言1.0", "duration": 2328 },
                    { "page": 2, "cid": 41444771227i64, "part": "01", "duration": 140 },
                    { "page": 3, "cid": 0, "part": "脏数据" },  // 无 cid：跳过
                    { "page": 4, "cid": 41444771273i64, "part": "", "duration": 140 }
                ]
            }
        })
        .to_string();
        let archive = parse_archive(&raw).unwrap();
        assert_eq!(archive.pages.len(), 3);
        assert_eq!(archive.pages[0].part, "前言1.0");
        assert_eq!(archive.pages[1].cid, 41444771227i64);
        // part 为空保留空串，展示方回退到 P 序号。
        assert_eq!(archive.pages[2].part, "");
        assert_eq!(archive.pages[2].page, 4);

        // 单 P 稿件不构成选集：pages 为空，cid 照常从根字段或 pages[0] 补齐。
        let single = serde_json::json!({
            "code": 0,
            "data": {
                "bvid": "BV1Ykt46iEYW",
                "pages": [{ "page": 1, "cid": 41444770475i64, "part": "唯一一P", "duration": 2328 }]
            }
        })
        .to_string();
        let archive = parse_archive(&single).unwrap();
        assert!(archive.pages.is_empty());
        assert_eq!(archive.cid, 41444770475);

        // 无 pages 字段 → 空表。
        let plain = serde_json::json!({ "code": 0, "data": { "bvid": "BV1Y", "cid": 1 } });
        assert!(parse_archive(&plain.to_string()).unwrap().pages.is_empty());
    }

    #[test]
    fn cast_durl_prefers_primary_and_falls_back_to_backup() {
        let primary = serde_json::json!({
            "durl": [{
                "url": "https://upos.example/primary.mp4",
                "backup_url": ["https://upos.example/backup.mp4"]
            }]
        });
        assert_eq!(
            parse_cast_durl(&primary).unwrap(),
            "https://upos.example/primary.mp4"
        );

        let backup_only = serde_json::json!({
            "durl": [{ "url": "", "backup_url": ["https://upos.example/backup.mp4"] }]
        });
        assert_eq!(
            parse_cast_durl(&backup_only).unwrap(),
            "https://upos.example/backup.mp4"
        );

        let empty = serde_json::json!({ "durl": [] });
        assert!(parse_cast_durl(&empty).is_err());
    }

    #[test]
    fn subtitles_parse_prefixes_https_and_skips_empty_urls() {
        let list = serde_json::json!([
            {
                "lan": "zh-CN",
                "lan_doc": "中文（自动生成）",
                "subtitle_url": "//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/1.json"
            },
            { "lan": "en", "lan_doc": "英语", "subtitle_url": "" }
        ]);
        let subtitles = parse_subtitles(Some(&list));
        assert_eq!(subtitles.len(), 1);
        assert_eq!(
            subtitles[0].url,
            "https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/1.json"
        );
        assert_eq!(subtitles[0].lan_doc, "中文（自动生成）");

        assert!(parse_subtitles(None).is_empty());
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
                "pic": "https://i0.hdslb.com/bfs/archive/x.jpg",
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
        assert!(archive.tags.is_empty());
        assert_eq!(archive.reply, 4986);
        assert_eq!(archive.pubdate, 1759000000);
        assert_eq!(archive.cover, "https://i0.hdslb.com/bfs/archive/x.jpg");

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
    fn parse_archive_tags_preserves_order_and_skips_empty_names() {
        let raw = serde_json::json!({
            "code": 0,
            "data": [
                { "tag_id": 1, "tag_name": "动画" },
                { "tag_id": 2, "tag_name": "  声优  " },
                { "tag_id": 3, "tag_name": "" },
                { "tag_id": 4 }
            ]
        })
        .to_string();

        assert_eq!(parse_archive_tags(&raw), ["动画", "声优"]);
        assert!(parse_archive_tags("not json").is_empty());
        assert!(parse_archive_tags(r#"{"code":0,"data":null}"#).is_empty());
    }

    #[test]
    fn parse_uploader_counts_matches_member_card_response() {
        let raw = serde_json::json!({
            "code": 0,
            "data": { "follower": 1427549, "archive_count": 321 }
        })
        .to_string();

        assert_eq!(parse_uploader_count(&raw, "follower"), Some(1427549));
        assert_eq!(parse_uploader_count(&raw, "archive_count"), Some(321));
        assert_eq!(parse_uploader_count("{}", "follower"), None);
    }

    #[test]
    fn parse_comments_merges_top_replies_and_emotes() {
        let raw = serde_json::json!({
            "code": 0,
            "data": {
                "cursor": { "is_end": false, "all_count": 4986, "next": 2 },
                // 页面级作者 mid：置顶那条（mid 42）应因此标上 UP。
                "upper": { "mid": 42 },
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

        // 页面级 `upper.mid` = 42 命中置顶那条（两条同 rpid 去重后留下的是它）；
        // 其余评论与楼中楼都不是作者，不标。
        assert!(page.items[0].is_upper);
        assert!(!page.items[1].is_upper);
        assert!(!main.replies[0].is_upper);

        assert!(parse_comments("{}").is_err());
    }

    #[test]
    fn parse_comments_marks_upper_author_on_comments_and_replies() {
        let raw = serde_json::json!({
            "data": {
                "cursor": { "is_end": true, "all_count": 2, "next": 1 },
                // 页面级 `upper.mid` 是作者标识的唯一来源（实测两个评论接口都下发）。
                "upper": { "mid": 42 },
                "replies": [
                    {
                        "rpid": 1, "member": { "uname": "UP 主", "mid": "42" },
                        "content": { "message": "本人在此" },
                        "replies": [ { "rpid": 11, "member": { "uname": "路人", "mid": "7" }, "content": { "message": "楼中楼" } } ]
                    },
                    {
                        "rpid": 2, "member": { "uname": "路人甲", "mid": "7" },
                        "content": { "message": "普通评论" },
                        "replies": [ { "rpid": 22, "member": { "uname": "UP 主", "mid": "42" }, "content": { "message": "作者回复" } } ]
                    }
                ]
            }
        })
        .to_string();
        let page = parse_comments(&raw).unwrap();
        assert!(page.items[0].is_upper, "作者本人的一级评论要标 UP");
        assert!(!page.items[0].replies[0].is_upper);
        assert!(!page.items[1].is_upper);
        assert!(
            page.items[1].replies[0].is_upper,
            "作者在楼中楼的回复也要标 UP"
        );
    }

    #[test]
    fn parse_comment_replies_marks_upper_and_ignores_unknown_identity() {
        let with_upper = serde_json::json!({
            "data": {
                "page": { "count": 1 },
                "upper": { "mid": 42 },
                "replies": [ { "rpid": 1, "member": { "uname": "UP 主", "mid": "42" }, "content": { "message": "作者回复" } } ]
            }
        })
        .to_string();
        let page = parse_comment_replies(&with_upper, 1, COMMENT_REPLIES_PAGE_SIZE).unwrap();
        assert!(page.items[0].is_upper);

        // mid 为 0（上游的「未登录/身份未知」形态）不能与同样为 0 的 author 相互命中。
        let unknown = serde_json::json!({
            "data": {
                "page": { "count": 1 },
                "upper": { "mid": 0 },
                "replies": [ { "rpid": 1, "member": { "uname": "匿名", "mid": "0" }, "content": { "message": "x" } } ]
            }
        })
        .to_string();
        assert!(!parse_comment_replies(&unknown, 1, COMMENT_REPLIES_PAGE_SIZE).unwrap().items[0].is_upper);
    }

    #[test]
    fn comment_upper_mid_falls_back_to_pinned_upper_object() {
        // `upper` 缺失时用 UP 置顶对象里的 mid 兜底（能置顶的必然是作者）。
        let data = serde_json::json!({ "top": { "upper": { "member": { "mid": "42" } } } });
        assert_eq!(comment_upper_mid(&data), "42");
        // 两种形态都没有、或 mid 为 0 时返回空串，后续一条不标。
        assert!(comment_upper_mid(&serde_json::json!({})).is_empty());
        assert!(comment_upper_mid(&serde_json::json!({ "upper": { "mid": 0 } })).is_empty());
        // 页面级 `upper` 优先于置顶对象（两者都是作者时取哪个都一样，但要确定）。
        let both = serde_json::json!({
            "upper": { "mid": "9" },
            "top": { "upper": { "member": { "mid": "42" } } }
        });
        assert_eq!(comment_upper_mid(&both), "9");
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
        let page = parse_comment_replies(&raw, 1, COMMENT_REPLIES_PAGE_SIZE).unwrap();
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
        assert!(!parse_comment_replies(&last, 1, COMMENT_REPLIES_PAGE_SIZE).unwrap().has_more);
    }

    /// 桌面端分页用更小的 `ps`：`has_more` 必须按实际页大小推导，套默认的 20
    /// 会在 pn=5 就误报「没有更多」（5*20=100 >= 86，而实际才取了 50 条）。
    #[test]
    fn parse_comment_replies_derives_has_more_from_requested_page_size() {
        let raw = serde_json::json!({
            "data": { "page": { "count": 86 }, "replies": [ {
                "rpid": 1, "member": { "uname": "甲", "mid": "1" }, "content": { "message": "x" }
            } ] }
        })
        .to_string();
        assert!(parse_comment_replies(&raw, 8, 10).unwrap().has_more);
        assert!(!parse_comment_replies(&raw, 9, 10).unwrap().has_more);
        // 同一页号在 20 条页大小下才是最后一页：页大小参与推导而非写死。
        assert!(parse_comment_replies(&raw, 4, 20).unwrap().has_more);
        assert!(!parse_comment_replies(&raw, 5, 20).unwrap().has_more);
    }

    /// story feed 的三条契约都是行为观测而非上游承诺，回归只能靠真网验证：
    /// 匿名无 WBI 即可、取流键齐备、且串行取批后仍能出新条目。
    #[tokio::test]
    #[ignore = "live network smoke — run with --ignored"]
    async fn live_story_feed_smoke() {
        let site = BilibiliSite::new(reqwest::Client::new(), String::new());
        let page = site
            .video_story(false, &HashSet::new(), None)
            .await
            .expect("匿名 story feed 应放行");

        assert!(!page.items.is_empty(), "story feed 未产出条目");
        assert!(page.has_more);
        for item in &page.items {
            assert!(!item.bvid.is_empty(), "条目缺 bvid");
            assert!(item.cid.is_some_and(|cid| cid > 0), "条目缺可播 cid");
            assert!(!item.aid.is_empty(), "条目缺 aid");
            assert!(item.cover.starts_with("https://"), "封面未升级到 https");
        }
        // 两批串行：上游单批约 4~5 条，去重后应明显多于一批。
        assert!(
            page.items.len() >= 5,
            "串行两批去重后只得 {} 条，轮换语义可能已变",
            page.items.len()
        );
    }

    /// story 条目能否直接走通现有 playurl / DASH 取流链路。
    ///
    /// 这是短视频入口的集成前提：竖屏舞台没有自己的取流实现，它把 story 给的
    /// `bvid`/`cid` 原样交给 [`BilibiliSite::video_play_selection`]。若上游哪天
    /// 改成只给 story 专用的播放凭据，这条会先失败，而不是等用户看到黑屏。
    #[tokio::test]
    #[ignore = "live network smoke — run with --ignored"]
    async fn live_story_item_plays_through_existing_playurl() {
        let site = BilibiliSite::new(reqwest::Client::new(), String::new());
        let page = site
            .video_story(false, &HashSet::new(), None)
            .await
            .expect("匿名 story feed 应放行");
        let item = page.items.first().expect("story feed 未产出条目");
        let cid = item.cid.expect("story 条目应带 cid");

        let selection = site
            .video_play_selection(&VideoPlayRequest {
                bvid: Some(item.bvid.clone()),
                cid,
                ep_id: None,
                qn: None,
                audio_only: None,
                media_cache: None,
            })
            .await
            .expect("story 条目应能走通现有 playurl");

        // 音视频两轨都要有可播地址与解析出的分片表，MPD 合成才有输入。
        assert!(selection.video.base_url.starts_with("https://"));
        assert!(selection.audio.base_url.starts_with("https://"));
        assert!(
            selection.video.sidx.duration_secs() > 0.0,
            "视频轨 sidx 为空"
        );
        assert!(
            selection.audio.sidx.duration_secs() > 0.0,
            "音频轨 sidx 为空"
        );
        assert!(!selection.accept_quality.is_empty());

        // 竖屏舞台按 dimension 决定 cover/contain，缺了它整流都会当成竖屏铺满。
        assert!(
            page.items.iter().all(|item| item.dimension.is_some()),
            "story 条目缺 dimension，竖屏判定会失效"
        );
    }
}
