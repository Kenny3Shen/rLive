import { invokeCmd } from "@/shared/api/tauri";
import type {
  PgcListPage,
  VideoArchive,
  VideoCommentPage,
  VideoDanmakuSegment,
  VideoListPage,
  VideoPlayInfo,
  VideoPlayRequest,
  VideoSeason,
  VideoSessionIds,
  VideoZone,
} from "@/shared/types/video";

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

/**
 * PGC 排行榜。同样是榜单，`has_more` 恒为 false。
 *
 * 番剧 / 影视两个页签当前走的是可翻页的 `pgc_index`，因此这个榜单尚未接入界面。
 * 保留封装是因为后端命令已存在且已验证，将来加「榜单」视图时不必再推导一次参数。
 */
export function videoGetPgcZone(seasonType: number): Promise<PgcListPage> {
  return invokeCmd<PgcListPage>("video_get_pgc_zone", { seasonType });
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
): Promise<VideoCommentPage> {
  return invokeCmd<VideoCommentPage>("video_get_comment_replies", { aid, root, page });
}
