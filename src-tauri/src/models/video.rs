//! B 站视频（VOD）跨 IPC 的数据模型。
//!
//! 与直播模型（[`crate::models::live`]）刻意分开：VOD 的标识符、分片与弹幕语义
//! 都和直播房间不同，混在一起会让两侧的字段含义都变模糊。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// 视频画面尺寸（上游 `dimension`）。
///
/// 竖屏判定的唯一依据：`rotate` 非 0 时宽高互换后再比较。只有少数列表接口
/// 下发（story feed、热门），其余接口为 `None`。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct VideoDimension {
    pub width: i64,
    pub height: i64,
    /// 旋转标记。非 0 表示上游给出的宽高需要互换才是实际画幅。
    pub rotate: i64,
}

/// 列表页中的一条 UGC 稿件。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoItem {
    pub bvid: String,
    /// 稿件 av 号，**刻意是字符串**。
    ///
    /// Bilibili 的新 aid 已是超大整数（实测 `117191437455648`），
    /// 超出 JS `number` 的安全整数范围，按数字过 IPC 必然静默丢精度。
    /// 前端只把它当不透明标识符透传，禁止参与算术。
    pub aid: String,
    /// 首个分 P 的 cid。列表接口通常直接给出；缺失时必须先取稿件详情才能播放。
    pub cid: Option<i64>,
    pub title: String,
    pub cover: String,
    pub author: String,
    pub author_face: Option<String>,
    /// UP 主粉丝数。**只有 story feed 直接下发**（`owner.fans`，实测每条都有且与
    /// `x/web-interface/card` 的 `follower` 完全一致）；其余列表接口不给，为 `None`。
    ///
    /// 与 [`VideoArchive::author_fans`] 的区别：那个是详情接口单独请求卡片后拿到的
    /// 数值（缺失时是 0），这个是流里白带的；用 `Option` 区分「上游说 0 个粉丝」与
    /// 「上游没说」，前端据此决定要不要画粉丝数。
    #[serde(default)]
    pub author_fans: Option<i64>,
    /// 时长，秒。
    pub duration: i64,
    pub view: i64,
    pub danmaku: i64,
    pub pubdate: i64,
    /// 平台给出的推荐理由（如「百万播放」），仅推荐与热门流提供。
    pub rcmd_reason: Option<String>,
    /// 画面尺寸。仅 story feed 与热门下发，用于竖屏判定；其余接口为 `None`。
    #[serde(default)]
    pub dimension: Option<VideoDimension>,
}

/// 番剧 / 影视等 PGC 剧集的列表条目。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PgcItem {
    pub season_id: String,
    /// 首集 ep_id。索引接口在 `first_ep` 里给出，排行榜接口不给，
    /// 因此调用方拿不到时需要先请求 season 详情才能播放。
    pub ep_id: Option<String>,
    pub title: String,
    pub cover: String,
    /// 角标文案，如「大会员」「独家」。
    pub badge: Option<String>,
    /// 更新进度文案，如「全 8 话」。
    pub index_show: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoListPage {
    pub has_more: bool,
    pub items: Vec<VideoItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PgcListPage {
    pub has_more: bool,
    pub items: Vec<PgcItem>,
}

/// PGC season 详情中的一集。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeasonEpisode {
    pub ep_id: String,
    /// 见 [`VideoItem::aid`]：同样按字符串传输。
    pub aid: String,
    pub cid: i64,
    pub bvid: String,
    /// 短标题，通常是集号，如「1」。
    pub title: String,
    /// 长标题，即本集正式名称。
    pub long_title: String,
    pub cover: String,
    /// 时长，秒。上游 `episodes[].duration` 是毫秒，这里已换算，
    /// 与 [`VideoItem::duration`] 统一。
    pub duration: i64,
    pub badge: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoSeason {
    pub season_id: String,
    pub title: String,
    pub cover: String,
    /// 剧集简介。
    pub evaluate: String,
    pub episodes: Vec<SeasonEpisode>,
}

/// 一个可选画质档位。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoQuality {
    /// 上游 `qn` 值，回传给 play-info 即可切换画质。
    pub qn: i64,
    pub label: String,
    /// 当前身份是否真的能取到该档位的流。
    ///
    /// `accept_quality` 列出的是该稿件存在的全部档位，而匿名与非大会员账号
    /// 实际只会拿到其中一部分（实测匿名最高 480P）。分开表达可以让前端
    /// 把不可用档位标成需要登录/大会员，而不是切过去再黑屏。
    pub available: bool,
}

/// 播放一条 VOD 所需的全部内容。
///
/// `mpd_url` 是后端合成的 MPD 清单的 HTTP 地址，交给 Video.js DASH 适配器
/// （dash.js）按 URL 拉取；仅音频模式为空串。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoPlayInfo {
    pub mpd_url: String,
    /// 视频轨的本机代理地址（已注入 Referer，转发 Range）。
    pub video_url: String,
    /// 音频轨的本机代理地址。
    pub audio_url: String,
    /// 时长，秒。取自 sidx 时间轴累加，比列表接口的整数秒更精确。
    pub duration: f64,
    /// 实际选中的 `qn`。
    pub quality: i64,
    pub quality_label: String,
    /// 实际选中的视频编码，如 `avc1.640033`。
    pub codecs: String,
    pub accept_quality: Vec<VideoQuality>,
    pub session_ids: VideoSessionIds,
    /// 仅音频模式（听视频）：不走 DASH——音轨 fMP4 是完整文件，前端把
    /// `audio_url`（代理转发 Range）直接交给媒体元素播放，`video_url` 为空串。
    pub audio_only: bool,
}

/// DLNA 投屏源：html5 playurl 返回的 MP4 直链（电视经中继可直连）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoCastSource {
    pub url: String,
    /// 中继向上游携带的请求头（UA / Referer）。
    pub headers: HashMap<String, String>,
}

/// CC 字幕轨道（player v2 接口）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoSubtitle {
    /// 语言代码，如 `zh-CN`；AI 字幕以 `ai-` 开头（需登录才会返回）。
    pub lan: String,
    /// 展示名，如「中文（自动生成）」。
    pub lan_doc: String,
    /// 字幕 JSON 地址。
    pub url: String,
}

/// 视频缩略图（快照/storyboard）元数据，对应 B 站 videoshot 接口。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoStoryboard {
    /// 拼版横向小图数（一般为 10）
    pub img_x_len: u32,
    /// 拼版纵向小图数（一般为 10）
    pub img_y_len: u32,
    /// 单张缩略图宽（一般为 160）
    pub img_x_size: u32,
    /// 单张缩略图高（一般为 90）
    pub img_y_size: u32,
    /// 拼版图片 URL 列表
    pub images: Vec<String>,
    /// 截取时间表（秒），与拼版小图一一对应
    pub index: Vec<u32>,
}

/// 一次 VOD 播放占用的代理会话：视频轨 / 音轨 / MPD 清单各一条
/// （仅音频模式只启动音轨，未启动的 id 停止时是无害的 no-op）。
///
/// `StreamProxy::start` 按 `session_id` 覆盖同名代理，三条流共用一个 id 会
/// 互相顶掉，所以必须各自独立。离开播放页时全部 stop，否则连接泄漏。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoSessionIds {
    pub video: String,
    pub audio: String,
    pub mpd: String,
}

/// 一条 VOD 弹幕。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DanmakuItem {
    /// 出现时间，毫秒（相对视频起点）。调度按这个字段。
    pub progress: i64,
    /// 1/2/3 滚动、4 底部、5 顶部、6 逆向、7 高级、8 代码、9 BAS。
    pub mode: i32,
    pub fontsize: i32,
    /// RGB 十进制。
    pub color: u32,
    pub content: String,
    /// 屏蔽等级，取值 [1,10]。
    pub weight: i32,
    /// 0 普通、1 字幕、2 特殊。
    pub pool: i32,
}

/// 一段（6 分钟）VOD 弹幕。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoDanmakuSegment {
    /// 是否还可能有下一段。
    ///
    /// 上游用 **HTTP 304** 表示段号越界，这就是唯一的停止条件；
    /// 空 body 不是（正常段也可能一条弹幕都没有）。
    pub has_more: bool,
    pub items: Vec<DanmakuItem>,
}

/// play-info 请求参数。
///
/// 打包成结构体而不是长参数列表：UGC 与 PGC 两条链路共用同一组可选字段，
/// 平铺会让调用点难以看出哪些组合有效。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct VideoPlayRequest {
    /// UGC 必填。
    pub bvid: Option<String>,
    /// 两条链路都必填。
    pub cid: i64,
    /// 填了就走 PGC playurl。
    pub ep_id: Option<String>,
    /// 期望画质；缺省取当前身份可用的最高档。
    pub qn: Option<i64>,
    /// 仅音频模式（听视频省流）：跳过视频轨代理，也不合成 MPD。
    pub audio_only: Option<bool>,
}

/// 稿件详情（`x/web-interface/view`）。
///
/// 播放页主要用它拿两样东西：评论区的 `oid`（aid）与稿件简介/统计，
/// 它是 WBI 签名接口，也是 URL 直入时补齐 aid 的唯一途径。
/// UGC 合集（`ugc_season`）的分集条目：合集连播沿这个列表走。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoSeasonEpisode {
    pub bvid: String,
    pub cid: i64,
    /// 展示标题：优先 long_title，空则用稿件标题。
    pub title: String,
    pub aid: String,
    pub duration: i64,
    pub cover: String,
}

/// UGC 合集：各分区的分集按顺序展平。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoUgcSeason {
    pub title: String,
    pub episodes: Vec<VideoSeasonEpisode>,
}

/// 稿件的一个分 P（`x/web-interface/view` 的 `pages[]`）。
///
/// 多 P 稿件的选集与连播沿这个列表走，与合集（`ugc_season`）互为补充：
/// 合集跨稿件，分 P 在同一稿件内部。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoArchivePage {
    /// P 序号，从 1 开始。
    pub page: i64,
    pub cid: i64,
    /// 分 P 标题（上游 `part`），可能为空，展示时回退到 P 序号。
    pub part: String,
    pub duration: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoArchive {
    pub bvid: String,
    /// 见 [`VideoItem::aid`]：字符串传输，避免丢精度。
    pub aid: String,
    /// 首 P 的 cid。搜索与 UP 主空间列表的条目没有 cid，播放页用它补齐取流键。
    pub cid: i64,
    pub title: String,
    /// 稿件封面（上游 `pic`）。观看历史用它，播放页自身不展示。
    pub cover: String,
    pub desc: String,
    /// 稿件 Tags，顺序与 B 站详情页一致；点击后用于视频关键词搜索。
    pub tags: Vec<String>,
    pub author: String,
    pub author_face: Option<String>,
    /// UP 主的 mid（member ID），用于获取 UP 主的投稿列表。
    pub author_mid: String,
    /// UP 主粉丝数；统计接口不可用时为 0。
    pub author_fans: i64,
    /// UP 主投稿视频数；统计接口不可用时为 0。
    pub author_videos: i64,
    pub view: i64,
    pub danmaku: i64,
    pub reply: i64,
    pub pubdate: i64,
    /// 多 P 稿件的分 P 列表：选集与连播沿它走；少于 2 个 P 不成选集，为空。
    pub pages: Vec<VideoArchivePage>,
    /// UGC 合集（ugc_season）：稿件属于合集时连播沿合集走，无合集为 None。
    pub ugc_season: Option<VideoUgcSeason>,
}

/// 评论内联表情（`[大哭]` 之类的占位符 → 图片 URL）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoEmote {
    /// 占位符原文，如 `[大哭]`。
    pub text: String,
    pub url: String,
}

/// 一条评论（或二级回复，两者同构）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoComment {
    pub rpid: i64,
    /// 发布者 mid。上游是字符串，原样透传。
    pub mid: String,
    pub uname: String,
    /// 头像可能缺失（部分用户没有头像字段），前端需容错。
    pub avatar: Option<String>,
    /// 用户等级（0-6 级，0 表示解析失败或不存在）。
    pub level: i64,
    pub message: String,
    /// 文本里的内联表情。
    pub emotes: Vec<VideoEmote>,
    /// 图片评论的图片地址。
    pub pictures: Vec<String>,
    pub like: i64,
    /// 发布时间，Unix 秒。
    pub ctime: i64,
    /// 二级回复总数。
    pub rcount: i64,
    /// 主接口附带的二级回复预览（前 2-3 条）。
    #[serde(default)]
    pub replies: Vec<VideoComment>,
    /// 是否是稿件作者（UP 主）本人发出的评论/回复。
    ///
    /// 上游不在条目上标作者：页面级 `data.upper.mid` 与评论者 `member.mid` 比对
    /// 得出，因此解析时就固化成这个布尔值，前端只负责渲染标识。
    /// `upper` 缺失或 mid 为 0（身份未知）时一律 false，宁可少标不可错标。
    #[serde(default)]
    pub is_upper: bool,
}

/// 一页评论（游标翻页）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoCommentPage {
    /// 评论区总条数（一级评论数，不含二级回复）。
    pub all_count: i64,
    /// 下一页游标（`reply/main`）；`is_end` 为 true 时不再有意义。
    pub next: i64,
    pub has_more: bool,
    pub items: Vec<VideoComment>,
}
