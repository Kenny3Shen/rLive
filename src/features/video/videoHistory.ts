/**
 * 视频观看历史：IPC 封装、续播判定与上报节流的纯逻辑。
 *
 * 历史按**作品**去重（`(kind, oid)`，见 `VideoHistoryItem`），行内的
 * `bvid/cid/ep_id/aid` 始终是最后观看的那一集，因此「继续观看」直接沿用它们
 * 就能落回正确的分 P / 分集。判定逻辑全部是纯函数：播放页只负责在
 * `timeupdate` 里调它们，节流与「值不值得记」的语义留在这里可测。
 */

import { invokeCmd } from "@/shared/api/tauri";
import { videoPlayPath } from "./videoRoute";
import type { VideoHistoryItem, VideoHistoryKind } from "@/shared/types/video";

/** 观看历史的 react-query key 前缀；上报后按它失效缓存。 */
export const VIDEO_HISTORY_QUERY_KEY = ["video-history"] as const;

/** 最近观看列表。后端按 `watched_at` 倒序，已截断到 200 条。 */
export function videoHistoryList(): Promise<VideoHistoryItem[]> {
  return invokeCmd<VideoHistoryItem[]>("video_history_list");
}

/** 取单个作品的历史；从未看过返回 null。续播位置由它提供。 */
export function videoHistoryFind(
  kind: VideoHistoryKind,
  oid: string,
): Promise<VideoHistoryItem | null> {
  return invokeCmd<VideoHistoryItem | null>("video_history_find", { kind, oid });
}

export function videoHistoryAdd(item: VideoHistoryItem): Promise<void> {
  return invokeCmd<void>("video_history_add", { item });
}

export function videoHistoryRemove(kind: VideoHistoryKind, oid: string): Promise<void> {
  return invokeCmd<void>("video_history_remove", { kind, oid });
}

export function videoHistoryClear(): Promise<void> {
  return invokeCmd<void>("video_history_clear");
}

/**
 * 低于此秒数不记历史：点开就退、误触与拖动预览不该污染历史列表。
 * 与 PiliPlus 的「进度太小视为未看」同一意图。
 */
export const VIDEO_HISTORY_MIN_PROGRESS_SECONDS = 3;

/** 两次上报之间的最小间隔。timeupdate 约 250ms 一次，不节流会写穿 SQLite。 */
export const VIDEO_HISTORY_REPORT_INTERVAL_MS = 5_000;

/**
 * 距片尾这个秒数以内视为看完：续播时从头播，而不是卡在最后一帧反复触发 ended。
 */
export const VIDEO_HISTORY_FINISHED_TAIL_SECONDS = 5;

/**
 * 是否该把当前进度写盘。
 *
 * `lastReportedAt` 为 null 表示这一集还没上报过 —— 只要越过最小进度就立刻记一次，
 * 让「打开过」这件事尽早落盘（用户可能马上就退出）。
 */
export function shouldReportVideoProgress(
  position: number,
  lastReportedAt: number | null,
  now: number,
): boolean {
  if (!Number.isFinite(position) || position < VIDEO_HISTORY_MIN_PROGRESS_SECONDS) return false;
  if (lastReportedAt === null) return true;
  return now - lastReportedAt >= VIDEO_HISTORY_REPORT_INTERVAL_MS;
}

/**
 * 历史记录该续播到的秒数；不该续播时返回 0。
 *
 * 三种情况从头播：① 没有历史；② 历史停在**别的**分集（用户这次点的是另一集，
 * 沿用旧进度会跳到错误的位置）；③ 已经看到片尾。
 * 分集比对以 `cid` 为准（取流键，UGC/PGC 都有），`cid` 未知时退回 `ep_id`。
 */
export function videoResumePosition(
  record: VideoHistoryItem | null | undefined,
  current: { cid: number; epId: string | null },
): number {
  if (!record) return 0;
  const samePart =
    current.cid > 0 && record.cid > 0
      ? record.cid === current.cid
      : record.ep_id === (current.epId ?? "");
  if (!samePart) return 0;
  const progress = record.progress;
  if (!Number.isFinite(progress) || progress < VIDEO_HISTORY_MIN_PROGRESS_SECONDS) return 0;
  if (record.duration > 0 && progress >= record.duration - VIDEO_HISTORY_FINISHED_TAIL_SECONDS) {
    return 0;
  }
  return progress;
}

/** 历史条目的续播链接：带上最后观看那一集的取流键。 */
export function videoHistoryPlayPath(item: VideoHistoryItem): string {
  return videoPlayPath({
    bvid: item.bvid || null,
    cid: item.cid,
    epId: item.ep_id || null,
    title: item.title,
    aid: item.aid || null,
  });
}

/** `mm:ss` / `h:mm:ss`。进度覆层与时长标签共用。 */
export function formatVideoDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const secs = total % 60;
  const paddedSecs = String(secs).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${paddedSecs}`
    : `${minutes}:${paddedSecs}`;
}
