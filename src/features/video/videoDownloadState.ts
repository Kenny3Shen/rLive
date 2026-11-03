import type { VideoDownloadItem, VideoDownloadStatus } from "./videoDownload";

/**
 * 下载任务在页面上的分组语义：除已完成外都属于未完成。
 *
 * 这与 Rust 侧的 `VideoDownloadStatus::is_active` 一致，暂停和失败仍留在
 * “下载任务”分组里，等待用户继续或重试。
 */
export function videoDownloadIsActive(status: VideoDownloadStatus): boolean {
  return status !== "completed";
}

/**
 * 只有无需用户操作就会继续推进的状态才需要兜底轮询。
 *
 * 暂停和失败不会自行恢复，持续轮询只会产生无意义的 IPC。
 */
export function videoDownloadNeedsPolling(status: VideoDownloadStatus): boolean {
  return status === "queued" || status === "downloading" || status === "merging";
}

/**
 * 与 Rust `sort_items` 保持同一契约：未完成优先，再按创建时间倒序。
 */
export function sortVideoDownloads(items: readonly VideoDownloadItem[]): VideoDownloadItem[] {
  return [...items].sort((left, right) => {
    const leftRank = videoDownloadIsActive(left.status) ? 0 : 1;
    const rightRank = videoDownloadIsActive(right.status) ? 0 : 1;
    return leftRank - rightRank || right.created_at - left.created_at;
  });
}

export function mergeVideoDownload(
  items: readonly VideoDownloadItem[],
  item: VideoDownloadItem,
): VideoDownloadItem[] {
  return sortVideoDownloads([...items.filter((entry) => entry.id !== item.id), item]);
}

export type VideoDownloadProgressPatch = Pick<
  VideoDownloadItem,
  "id" | "downloaded_bytes" | "total_bytes" | "status"
>;

export function applyVideoDownloadProgress(
  items: readonly VideoDownloadItem[],
  patch: VideoDownloadProgressPatch,
): VideoDownloadItem[] {
  return sortVideoDownloads(
    items.map((item) =>
      item.id === patch.id
        ? {
            ...item,
            downloaded_bytes: patch.downloaded_bytes,
            total_bytes: patch.total_bytes,
            status: patch.status,
          }
        : item,
    ),
  );
}
