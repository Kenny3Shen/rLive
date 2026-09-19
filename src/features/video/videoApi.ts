import { invokeCmd } from "@/shared/api/tauri";
import type {
  PgcListPage,
  VideoArchive,
  VideoCastSource,
  VideoCommentPage,
  VideoDanmakuSegment,
  VideoListPage,
  VideoPlayInfo,
  VideoPlayRequest,
  VideoSeason,
  VideoSessionIds,
  VideoStoryboard,
  VideoSubtitle,
  VideoZone,
  VideoUploaderStoryPage,
} from "@/shared/types/video";
import type { VideoSearchFilters } from "./videoRoute";

/**
 * B 站视频命令的薄封装。
 *
 * 只负责命令名与 camelCase 入参这两件事 —— 分页、榜单语义与画质选择全在 Rust 侧，
 * 前端不复制那部分业务逻辑。
 */

export function videoGetRecommend(page: number, pageSize?: number): Promise<VideoListPage> {
  return invokeCmd<VideoListPage>("video_get_recommend", { page, pageSize });
}

export function videoGetPopular(page: number, pageSize?: number): Promise<VideoListPage> {
  return invokeCmd<VideoListPage>("video_get_popular", { page, pageSize });
}

/**
 * 短视频流（B 站 story feed）。
 *
 * 上游无游标也不接页码：每次调用拉下一批轮换内容，因此没有参数。后端已做跨
 * 批去重，但跨**页**重复仍可能，调用方必须自行去重（见 `shortsFeedItems`）。
 * 返回的条目是混合画幅，竖屏判定靠 `dimension`。
 */
/**
 * 短视频流（story feed）。
 *
 * `more` 是「这次是补货还是首屏」的粗语义，不是批数：一次扣多少次上游接口的策略
 * （批数档位与夹取）全在后端，前端只告诉它这是首屏还是补货。
 *
 * `seedBvid` 是「以哪条为起点继续刷」：传当前正在看的那条，上游会把该条排在首位
 * 并换出一组与黏性头部不重叠的窗口（实测）。首屏还没条目时传 `null`，后端会回退到
 * 最近观看历史当种子。
 */
export function videoGetStory(more?: boolean, seedBvid?: string | null): Promise<VideoListPage> {
  return invokeCmd<VideoListPage>("video_get_story", { more, seedBvid: seedBvid ?? null });
}

/** UP 主 story 列表：初次包含当前 aid，后续使用后端返回的双向游标。 */
export function videoGetUploaderStory(
  mid: string,
  cursorAid?: string | null,
  direction: "initial" | "next" | "prev" = "initial",
): Promise<VideoUploaderStoryPage> {
  return invokeCmd<VideoUploaderStoryPage>("video_get_uploader_story", {
    mid,
    cursorAid: cursorAid ?? null,
    direction,
  });
}

/** UGC 分区榜。上游是榜单而非分页接口，返回的 `has_more` 恒为 false。 */
export function videoGetZone(rid: number): Promise<VideoListPage> {
  return invokeCmd<VideoListPage>("video_get_zone", { rid });
}

export function videoZoneList(): Promise<VideoZone[]> {
  return invokeCmd<VideoZone[]>("video_zone_list");
}

/** 番剧是 `(1, null)`，影视是 `(1, 102)`；两者都按 `page` 翻页。 */
export function videoGetPgcIndex(
  seasonType: number,
  indexType: number | null,
  page: number,
): Promise<PgcListPage> {
  return invokeCmd<PgcListPage>("video_get_pgc_index", { seasonType, indexType, page });
}

export function videoGetSeason(params: {
  seasonId?: string | undefined;
  epId?: string | undefined;
}): Promise<VideoSeason> {
  return invokeCmd<VideoSeason>("video_get_season", {
    seasonId: params.seasonId,
    epId: params.epId,
  });
}

export function videoGetPlayInfo(request: VideoPlayRequest): Promise<VideoPlayInfo> {
  return invokeCmd<VideoPlayInfo>("video_get_play_info", { request });
}

/** DLNA 投屏源：html5 playurl 的 MP4 直链 + 中继请求头（电视经中继可直连）。 */
export function videoGetCastUrl(request: VideoPlayRequest): Promise<VideoCastSource> {
  return invokeCmd<VideoCastSource>("video_get_cast_url", { request });
}

/** CC 字幕轨道列表（player v2）。 */
export function videoGetSubtitles(request: VideoPlayRequest): Promise<VideoSubtitle[]> {
  return invokeCmd<VideoSubtitle[]>("video_get_subtitles", { request });
}

/** 视频缩略图（storyboard）快照元数据。无快照时返回 null。 */
export function videoGetStoryboard(request: VideoPlayRequest): Promise<VideoStoryboard | null> {
  return invokeCmd<VideoStoryboard | null>("video_get_storyboard", { request });
}

/** 字幕 JSON 原文（字幕主机无 CORS 头，由本端代拉）。 */
export function videoGetSubtitle(url: string): Promise<string> {
  return invokeCmd<string>("video_get_subtitle", { url });
}

/** 取一段 VOD 弹幕。段号 6 分钟一段，见 `videoDanmakuSegmentIndex`。 */
export function videoGetDanmaku(cid: number, segmentIndex: number): Promise<VideoDanmakuSegment> {
  return invokeCmd<VideoDanmakuSegment>("video_get_danmaku", { cid, segmentIndex });
}

/**
 * 停掉一次播放占用的三个代理会话。
 *
 * 离开播放页必须调用，否则三条本机监听器与其上游连接都会泄漏。刻意吞掉失败：
 * 它跑在卸载路径上，此时没有可呈现失败态的界面，而重试也救不回已经离开的页面。
 */
export function videoStopPlay(sessionIds: VideoSessionIds): Promise<void> {
  return invokeCmd<void>("video_stop_play", { sessionIds }).catch(() => undefined);
}

/** 相关视频（UGC）。一次返回全部，无分页。 */
export function videoGetRelated(bvid: string): Promise<VideoListPage> {
  return invokeCmd<VideoListPage>("video_get_related", { bvid });
}

/** 搜索视频。关键词搜索，支持分页与可选筛选（排序 / 时长 / 分区 / 发布时间）。 */
export function videoSearch(
  keyword: string,
  page: number,
  filters: VideoSearchFilters,
): Promise<VideoListPage> {
  return invokeCmd<VideoListPage>("video_search", {
    keyword,
    page,
    order: filters.order || null,
    duration: filters.duration || null,
    tids: filters.zone || null,
    pubTime: filters.pubTime || null,
  });
}

/** 搜索筛选的分区表（tid）。与 `videoZoneList` 的分区榜 rid 是两套 ID。 */
export function videoSearchZoneList(): Promise<VideoZone[]> {
  return invokeCmd<VideoZone[]>("video_search_zone_list");
}

/** UP 主空间视频列表的排序方式。 */
export type VideoUploaderOrder = "pubdate" | "click";

/** UP 主空间视频列表。获取指定 UP 主的投稿视频，支持分页与排序。 */
export function videoUploaderVideos(
  mid: string,
  page: number,
  order: VideoUploaderOrder = "pubdate",
): Promise<VideoListPage> {
  return invokeCmd<VideoListPage>("video_uploader_videos", { mid, page, order });
}

/** 稿件详情：右侧栏的简介/统计，以及 URL 直入时补齐评论区的 aid。 */
export function videoGetArchive(bvid: string): Promise<VideoArchive> {
  return invokeCmd<VideoArchive>("video_get_archive", { bvid });
}

/** 评论首页（游标翻页）。mode：2 按时间、3 按热度；next 首次传 0。 */
export function videoGetComments(
  aid: string,
  mode: number,
  next: number,
): Promise<VideoCommentPage> {
  return invokeCmd<VideoCommentPage>("video_get_comments", { aid, mode, next });
}

/** 二级回复（pn 翻页，首传 page = 1）。 */
export function videoGetCommentReplies(
  aid: string,
  root: number,
  page: number,
  pageSize?: number,
): Promise<VideoCommentPage> {
  return invokeCmd<VideoCommentPage>("video_get_comment_replies", {
    aid,
    root,
    page,
    pageSize,
  });
}
