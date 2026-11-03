import { activeRecordingCount, useActiveRecordings } from "@/features/recording/recording";
import { useVideoDownloads, videoDownloadInProgressCount } from "@/features/video/videoDownload";

export type FollowTaskCounts = {
  recordings: number;
  downloads: number;
};

export function followTaskTotal(counts: FollowTaskCounts): number {
  return counts.recordings + counts.downloads;
}

export function followTaskCountLabel(counts: FollowTaskCounts): string | null {
  const parts: string[] = [];
  if (counts.recordings > 0) parts.push(`${counts.recordings} 项录制`);
  if (counts.downloads > 0) parts.push(`${counts.downloads} 项下载`);
  return parts.length > 0 ? `${parts.join("、")}正在进行` : null;
}

export function formatTaskBadgeCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/** Shell 常驻读取两类任务，徽标入口只消费计数，不重复注册监听。 */
export function useFollowTaskCounts(): FollowTaskCounts {
  const recordings = useActiveRecordings(true, activeRecordingCount);
  const downloads = useVideoDownloads(true, videoDownloadInProgressCount);
  return {
    recordings: recordings.data ?? 0,
    downloads: downloads.data ?? 0,
  };
}
