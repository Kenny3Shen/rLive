import type { VideoArchive, VideoItem } from "@/shared/types/video";
import type { VideoDownloadInput } from "./videoDownload";

type VideoCardDownloadSource = Pick<
  VideoItem,
  "bvid" | "cid" | "title" | "cover" | "author" | "duration"
>;

/**
 * 把列表卡片转换成下载队列入参。
 *
 * 列表条目通常带首 P 的 cid；搜索与 UP 主投稿可能缺失，此时由 archive 补齐。
 * archive.pages 对单 P 稿件为空，所以还要回退 archive.cid，不能把空 pages
 * 直接当成不可下载。
 */
export function videoCardDownloadInput(
  item: VideoCardDownloadSource,
  archive?: VideoArchive,
): VideoDownloadInput {
  const archivePage = archive?.pages.find((page) => page.cid > 0);
  const cid = item.cid && item.cid > 0 ? item.cid : (archivePage?.cid ?? archive?.cid ?? 0);
  if (!Number.isFinite(cid) || cid <= 0) {
    throw new Error("无法确定这条视频的可下载分 P。");
  }

  const selectedPage = archive?.pages.find((page) => page.cid === cid);
  const archiveTitle = archive?.title.trim();
  return {
    bvid: item.bvid,
    cid,
    ep_id: null,
    title: archiveTitle || item.title,
    cover: archive?.cover || item.cover,
    author: archive?.author || item.author,
    duration: selectedPage?.duration || item.duration || 0,
  };
}

export function videoCardDownloadErrorText(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message?: unknown }).message);
  }
  return String(error);
}
