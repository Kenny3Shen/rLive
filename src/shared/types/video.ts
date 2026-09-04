/**
 * B 站视频（VOD）跨 IPC 的数据模型，镜像 Rust `models::video`（serde snake_case）。
 *
 * 与直播模型（`types/live.ts`）刻意分开：VOD 的标识符、分片与弹幕语义都和直播房间
 * 不同，混在一起会让两侧的字段含义都变模糊。
 */

/** 列表页中的一条 UGC 稿件。 */
export type VideoItem = {
  bvid: string;
  /**
   * 稿件 av 号，**刻意是字符串**。
   *
   * Bilibili 的新 aid 已是超大整数（实测 `117191437455648`），超出 JS `number` 的
   * 安全整数范围。只当不透明标识符透传，禁止参与算术。
   */
  aid: string;
  /** 首个分 P 的 cid。列表接口通常直接给出；缺失时必须先取稿件详情才能播放。 */
  cid: number | null;
  title: string;
  cover: string;
  author: string;
  author_face: string | null;
  /** 时长，秒。 */
  duration: number;
  view: number;
  danmaku: number;
  pubdate: number;
  /** 平台给出的推荐理由（如「百万播放」），仅推荐与热门流提供。 */
  rcmd_reason: string | null;
};

/** 番剧 / 影视等 PGC 剧集的列表条目。 */
export type PgcItem = {
  season_id: string;
  /** 首集 ep_id。索引接口给出，排行榜接口不给 —— 缺失时需先请求 season 详情。 */
  ep_id: string | null;
  title: string;
  cover: string;
  /** 角标文案，如「大会员」「独家」。 */
  badge: string | null;
  /** 更新进度文案，如「全 8 话」。 */
  index_show: string | null;
};

export type VideoListPage = {
  has_more: boolean;
  items: VideoItem[];
};

export type PgcListPage = {
  has_more: boolean;
  items: PgcItem[];
};

/** PGC season 详情中的一集。 */
export type SeasonEpisode = {
  ep_id: string;
  /** 见 `VideoItem.aid`：同样按字符串传输。 */
  aid: string;
  cid: number;
  bvid: string;
  /** 短标题，通常是集号，如「1」。 */
  title: string;
  /** 长标题，即本集正式名称。 */
  long_title: string;
  cover: string;
  /** 时长，秒（后端已从上游毫秒换算）。 */
  duration: number;
  badge: string | null;
};

export type VideoSeason = {
  season_id: string;
  title: string;
  cover: string;
  /** 剧集简介。 */
  evaluate: string;
  episodes: SeasonEpisode[];
};

/** 一个可选画质档位。 */
export type VideoQuality = {
  /** 上游 `qn` 值，回传给 play-info 即可切换画质。 */
  qn: number;
  label: string;
  /**
   * 当前身份是否真的能取到该档位的流。匿名与非大会员实测最高 480P，
   * 分开表达可以把不可用档位标成需要登录/大会员，而不是切过去再黑屏。
   */
  available: boolean;
};

/**
 * 一次 VOD 播放占用的三个代理会话。
 *
 * `StreamProxy::start` 按 `session_id` 覆盖同名代理，三条流共用一个 id 会互相顶掉，
 * 所以必须各自独立。**离开播放页时三个都要 stop，否则连接泄漏。**
 */
export type VideoSessionIds = {
  video: string;
  audio: string;
  mpd: string;
};

/**
 * 一条视频观看历史。镜像 Rust `db::video_history::VideoHistoryRecord`。
 *
 * **按「作品」而不是「分集」去重**：`(kind, oid)` 是主键，`oid` 为 UGC 的 bvid
 * 或 PGC 的 season_id。同一稿件换分 P、同一剧集换集只更新这一行的进度与
 * `cid`/`ep_id`，历史列表因此不会被一部番的几十集刷满 —— 与 PiliPlus 的
 * 「同一作品一条记录」语义一致。
 */
export type VideoHistoryItem = {
  /** `ugc` = 稿件（oid 为 bvid），`pgc` = 番剧/影视剧集（oid 为 season_id）。 */
  kind: VideoHistoryKind;
  /** 作品标识：UGC 为 bvid，PGC 为 season_id。 */
  oid: string;
  /** 作品标题：UGC 为稿件标题，PGC 为剧集名。 */
  title: string;
  cover: string;
  /** UGC 为 UP 主名，PGC 为空（剧集无单一作者）。 */
  author: string;
  /** 最后观看的分 P / 分集标题；单 P 稿件为空。 */
  part_title: string;
  /** 续播用：最后观看分集的 bvid（PGC 分集也有 bvid）。 */
  bvid: string;
  /** 续播用：最后观看分集的 cid，即取流键。 */
  cid: number;
  /** 续播用：PGC 的 ep_id；UGC 为空。 */
  ep_id: string;
  /** 续播用：评论区 oid，可为空。 */
  aid: string;
  /** 已观看位置，秒。 */
  progress: number;
  /** 该分集总时长，秒；未知为 0。 */
  duration: number;
  /** 最后观看时间，Unix 毫秒。 */
  watched_at: number;
};

export type VideoHistoryKind = "ugc" | "pgc";

/**
 * 播放一条 VOD 所需的全部内容。
 *
 * `mpd` 是后端合成的清单文本，`mpd_url` 是同一份文本的 HTTP 地址。
 * **必须把 `mpd_url` 交给播放器**：`xgplayer-dash` 取清单的 XHR 会给地址拼 `?`，
 * `blob:` 走精确匹配因此 404。别「优化」成 blob URL。
 */
export type VideoPlayInfo = {
  mpd: string;
  mpd_url: string;
  /** 视频轨的本机代理地址（已注入 Referer，转发 Range）。 */
  video_url: string;
  /** 音频轨的本机代理地址。 */
  audio_url: string;
  /** 代理向上游携带的请求头，供诊断与前端展示。 */
  headers: Record<string, string>;
  /** 时长，秒。取自 sidx 时间轴累加，比列表接口的整数秒更精确。 */
  duration: number;
  /** 实际选中的 `qn`。 */
  quality: number;
  quality_label: string;
  /** 实际选中的视频编码，如 `avc1.640033`。 */
  codecs: string;
  accept_quality: VideoQuality[];
  /**
   * 视频轨真实分片边界时刻（秒），共 N+1 项：分片 `k` 覆盖 `[t[k], t[k+1])`。
   *
   * `xgplayer-dash` 把 `SegmentList` 当等长分片展开，而 B 站按关键帧切片、长度
   * 不等，偏差累积后插件会选错分片（seek 后永远 waiting）。播放器创建时把这份
   * 时间轴交给 `applyXgDashSegmentTimeline` 改写插件的分片表。仅音频模式不走
   * DASH，两条都为空。
   */
  video_segment_times: number[];
  /** 音频轨真实分片边界时刻（秒），同上。 */
  audio_segment_times: number[];
  session_ids: VideoSessionIds;
  /** 仅音频模式（听视频）：MPD 只含音轨，video_url 为空。 */
  audio_only: boolean;
};

/** play-info 请求参数，镜像 Rust `VideoPlayRequest`。 */
export type VideoPlayRequest = {
  /** UGC 必填。 */
  bvid?: string | null;
  /** 两条链路都必填。 */
  cid: number;
  /** 填了就走 PGC playurl。 */
  ep_id?: string | null;
  /** 期望画质；缺省取当前身份可用的最高档。 */
  qn?: number | null;
  /** 期望视频编码前缀，缺省 `avc1`。 */
  codec?: string | null;
  /** 仅音频模式：MPD 只含音轨（听视频省流）。 */
  audio_only?: boolean | null;
};

/** DLNA 投屏源：html5 playurl 的 MP4 直链 + 中继请求头。 */
export type VideoCastSource = {
  url: string;
  headers: Record<string, string>;
};

/** CC 字幕轨道（player v2 接口）。 */
export type VideoSubtitle = {
  /** 语言代码，AI 字幕以 `ai-` 开头。 */
  lan: string;
  /** 展示名，如「中文（自动生成）」。 */
  lan_doc: string;
  /** 字幕 JSON 地址。 */
  url: string;
};

/** 一条 VOD 弹幕。 */
export type VideoDanmakuItem = {
  /** 出现时间，毫秒（相对视频起点）。调度按这个字段。 */
  progress: number;
  /** 1/2/3 滚动、4 底部、5 顶部、6 逆向、7 高级、8 代码、9 BAS。 */
  mode: number;
  fontsize: number;
  /** RGB 十进制。 */
  color: number;
  content: string;
  /** 屏蔽等级，取值 [1,10]。 */
  weight: number;
  /** 0 普通、1 字幕、2 特殊。 */
  pool: number;
};

/** 一段（6 分钟）VOD 弹幕。 */
export type VideoDanmakuSegment = {
  /**
   * 是否还可能有下一段。上游用 **HTTP 304** 表示段号越界（后端已封装），
   * 这就是唯一的停止条件；空 body 不是（正常段也可能一条弹幕都没有）。
   */
  has_more: boolean;
  items: VideoDanmakuItem[];
};

/** UGC 分区条目：`[名称, rid]`，由 `video_zone_list` 提供以免前端硬编码。 */
export type VideoZone = [string, number];

/** 稿件详情（`x/web-interface/view`）。播放页右侧栏用它拿简介/统计与评论区的 aid。 */
/** UGC 合集分集条目（archive.ugc_season.episodes）。 */
export type VideoSeasonEpisode = {
  bvid: string;
  cid: number;
  /** 展示标题：long_title 空则用稿件标题。 */
  title: string;
  aid: string;
  duration: number;
  cover: string;
};

/** UGC 合集：各分区分集按顺序展平。 */
export type VideoUgcSeason = {
  title: string;
  episodes: VideoSeasonEpisode[];
};

/** 稿件的一个分 P（archive.pages）。 */
export type VideoArchivePage = {
  /** P 序号，从 1 开始。 */
  page: number;
  cid: number;
  /** 分 P 标题，空字符串时展示方回退到 P 序号。 */
  part: string;
  duration: number;
};

export type VideoArchive = {
  bvid: string;
  /** 见 `VideoItem.aid`：字符串传输，避免丢精度。 */
  aid: string;
  /** 首 P 的 cid；搜索/UP 主列表的条目没有 cid，播放页用它补齐取流键。 */
  cid: number;
  title: string;
  /** 稿件封面（上游 `pic`）。观看历史与投屏卡片用它，播放页自身不展示。 */
  cover: string;
  desc: string;
  author: string;
  author_face: string | null;
  /** UP 主的 mid（member ID），用于获取 UP 主的投稿列表。 */
  author_mid: string;
  view: number;
  danmaku: number;
  reply: number;
  pubdate: number;
  /** 多 P 稿件的分 P 列表：选集与连播沿它走；少于 2 个 P 为空数组。 */
  pages: VideoArchivePage[];
  /** UGC 合集：稿件属于合集时连播沿合集走，无合集为 null。 */
  ugc_season: VideoUgcSeason | null;
};

/** 评论内联表情（`[大哭]` 之类的占位符 → 图片 URL）。 */
export type VideoEmote = {
  /** 占位符原文，如 `[大哭]`。 */
  text: string;
  url: string;
};

/** 一条评论（或二级回复，两者同构）。 */
export type VideoComment = {
  rpid: number;
  /** 发布者 mid，原样透传。 */
  mid: string;
  uname: string;
  /** 头像可能缺失，需容错。 */
  avatar: string | null;
  /** 用户等级（0-6 级，0 表示缺失）。 */
  level: number;
  message: string;
  emotes: VideoEmote[];
  /** 图片评论的图片地址。 */
  pictures: string[];
  like: number;
  /** 发布时间，Unix 秒。 */
  ctime: number;
  /** 二级回复总数。 */
  rcount: number;
  /** 主接口附带的二级回复预览（前 2-3 条）。 */
  replies: VideoComment[];
};

/** 一页评论（游标翻页）。 */
export type VideoCommentPage = {
  /** 评论区总条数（一级评论数，不含二级回复）。 */
  all_count: number;
  /** 下一页游标；`has_more` 为 false 时不再有意义。 */
  next: number;
  has_more: boolean;
  items: VideoComment[];
};
