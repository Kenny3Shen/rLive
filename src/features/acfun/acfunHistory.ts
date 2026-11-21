import { useEffect, useMemo, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  isWatchProgressWorthKeeping,
  shouldReportWatchProgress,
  watchResumePosition,
} from "@/shared/watchProgress";
import type { VideoHistoryItem } from "@/shared/types/video";
import { VIDEO_HISTORY_QUERY_KEY, videoHistoryAdd } from "@/features/video/videoHistory";
import type { AcfunVideoDetail, AcfunVideoPart } from "./acfunTypes";

function acfunPart(detail: AcfunVideoDetail, partId: string | null): AcfunVideoPart | null {
  if (!partId) return null;
  return detail.parts.find((part) => part.id === partId) ?? null;
}

function acfunPartTitle(part: AcfunVideoPart): string {
  return part.title.trim() || `P${part.index}`;
}

/**
 * 从 URL 显式分 P、历史分 P 和稿件首 P 中选出本次应播放的分 P。
 * 历史分 P 已不在当前稿件中时视为过期，避免把播放器引向已删除的分 P。
 */
export function acfunResumePartId(
  record: VideoHistoryItem | null | undefined,
  detail: AcfunVideoDetail,
  explicitPartId?: string | null,
): string | null {
  const explicit = explicitPartId?.trim();
  if (explicit) return explicit;
  const recorded = record?.kind === "acfun" ? record.part_id.trim() : "";
  if (recorded && detail.parts.some((part) => part.id === recorded)) return recorded;
  return detail.parts[0]?.id ?? null;
}

/** 仅同一分 P 的未看完记录才续播；换 P、看完或进度过短都从头播放。 */
export function acfunResumePosition(
  record: VideoHistoryItem | null | undefined,
  currentPartId: string | null,
): number {
  if (!record || record.kind !== "acfun" || !currentPartId) return 0;
  if (record.part_id !== currentPartId) return 0;
  return watchResumePosition(record.progress, record.duration);
}

export function acfunWatchHistoryEntry(
  detail: AcfunVideoDetail,
  partId: string,
): VideoHistoryItem | null {
  const part = acfunPart(detail, partId);
  if (!part) return null;
  return {
    kind: "acfun",
    oid: detail.item.id,
    title: detail.item.title,
    cover: detail.item.cover,
    author: detail.item.author,
    part_title: acfunPartTitle(part),
    bvid: "",
    cid: 0,
    ep_id: "",
    aid: "",
    part_id: part.id,
    progress: 0,
    duration: part.duration_sec,
    watched_at: 0,
  };
}

export type AcfunWatchProgressOptions = {
  videoRef: RefObject<HTMLVideoElement | null>;
  detail: AcfunVideoDetail;
  partId: string | null;
  enabled?: boolean;
};

/**
 * 把当前 AcFun 分 P 的播放位置写入共享视频历史。
 * 与 B 站点播使用相同的三秒门槛、五秒节流和收尾强制写盘规则。
 */
export function useAcfunWatchProgress({
  videoRef,
  detail,
  partId,
  enabled = true,
}: AcfunWatchProgressOptions): void {
  const queryClient = useQueryClient();
  const entry = useMemo(
    () => (partId ? acfunWatchHistoryEntry(detail, partId) : null),
    [detail, partId],
  );

  useEffect(() => {
    const video = videoRef.current;
    if (!enabled || !video || !entry) return;
    let reportedAt: number | null = null;
    let lastPosition = Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : 0;
    let lastDuration = Number.isFinite(video.duration) ? Math.max(0, video.duration) : 0;

    const report = (force: boolean, closing = false) => {
      if (Number.isFinite(video.currentTime) && (!closing || video.currentTime > 0)) {
        lastPosition = Math.max(0, video.currentTime);
      }
      if (Number.isFinite(video.duration) && video.duration > 0) {
        lastDuration = video.duration;
      }
      const now = Date.now();
      if (force) {
        if (!isWatchProgressWorthKeeping(lastPosition)) return;
      } else if (!shouldReportWatchProgress(lastPosition, reportedAt, now)) {
        return;
      }
      reportedAt = now;
      void videoHistoryAdd({
        ...entry,
        progress: lastPosition,
        duration: lastDuration > 0 ? lastDuration : entry.duration,
        watched_at: now,
      })
        .then(() => queryClient.invalidateQueries({ queryKey: VIDEO_HISTORY_QUERY_KEY }))
        .catch(() => undefined);
    };

    const onTimeUpdate = () => report(false);
    const onSeeked = () => report(false);
    const onPause = () => report(true);
    const onEnded = () => report(true);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);
    report(false);

    return () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnded);
      report(true, true);
    };
  }, [enabled, entry, queryClient, videoRef]);
}
