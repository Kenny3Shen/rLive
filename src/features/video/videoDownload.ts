import { isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { invokeCmd } from "@/shared/api/tauri";
import { getClientPlatform } from "@/shared/clientPlatform";
import {
  applyVideoDownloadProgress,
  mergeVideoDownload,
  videoDownloadNeedsPolling,
} from "./videoDownloadState";

export {
  videoDownloadIsActive,
  videoDownloadPrimaryAction,
  type VideoDownloadPrimaryAction,
} from "./videoDownloadState";

/**
 * B 站 VOD 下载的前端契约。
 *
 * 队列、断点续传与音视频合并都在 Rust 侧；这里只镜像跨 IPC 的条目形状、
 * 事件订阅与命令外壳。字段保持 snake_case，与 VOD 其余模型一致。
 */

export type VideoDownloadStatus =
  | "queued"
  | "downloading"
  | "paused"
  | "merging"
  | "completed"
  | "failed";

export type VideoDownloadItem = {
  id: string;
  bvid: string | null;
  cid: number;
  ep_id: string | null;
  title: string;
  cover: string;
  author: string;
  /** 秒。取流后由后端按 sidx 时间轴回填。 */
  duration: number;
  qn: number;
  quality_label: string;
  status: VideoDownloadStatus;
  downloaded_bytes: number;
  total_bytes: number;
  created_at: number;
  completed_at: number | null;
  file_path: string;
  error: string | null;
};

export type VideoDownloadInput = {
  bvid: string | null;
  cid: number;
  ep_id: string | null;
  title: string;
  cover?: string;
  author?: string;
  duration?: number;
  qn?: number;
};

export type VideoDownloadPlaybackInfo = {
  item: VideoDownloadItem;
  /** Rust 本地文件服务生成的 loopback 地址；前端不得自行拼接路径。 */
  url: string;
  /** 上次观看位置，秒。 */
  progress: number;
  /** 下载时随媒体一起缓存、可在离线状态直接加载的字幕轨。 */
  subtitles: VideoDownloadSubtitle[];
  /** 字幕未完整缓存时的原因；不应影响媒体播放。 */
  subtitle_error: string | null;
  /** 授权的本机弹幕快照地址；旧下载没有缓存时为 null。 */
  danmaku_url: string | null;
  danmaku_error: string | null;
};

export type VideoDownloadSubtitle = {
  id: string;
  lan: string;
  lan_doc: string;
  /** 本机回放服务签发的 VTT 地址。 */
  url: string;
};

export type VideoDownloadWatchProgressInput = {
  id: string;
  progress: number;
  duration: number;
};

export const VIDEO_DOWNLOADS_QUERY_KEY = ["video-downloads"] as const;
export const VIDEO_DOWNLOAD_PLAYBACK_QUERY_KEY = ["video-download-playback"] as const;
export const VIDEO_DOWNLOAD_VIEW_PARAM = "downloadView";

export type VideoDownloadView = "all" | "active" | "completed";

export const VIDEO_DOWNLOAD_VIEWS: readonly VideoDownloadView[] = ["all", "active", "completed"];

export function videoDownloadViewFromSearch(value: string | null | undefined): VideoDownloadView {
  return value === "active" || value === "completed" ? value : "all";
}

export function withVideoDownloadView(
  current: URLSearchParams,
  view: VideoDownloadView,
): URLSearchParams {
  const next = new URLSearchParams(current);
  if (view === "all") next.delete(VIDEO_DOWNLOAD_VIEW_PARAM);
  else next.set(VIDEO_DOWNLOAD_VIEW_PARAM, view);
  return next;
}
const VIDEO_DOWNLOAD_CHANGED_EVENT = "video-download-changed";
const VIDEO_DOWNLOAD_PROGRESS_EVENT = "video-download-progress";
/** 有活动任务时的兜底轮询间隔；正常进度靠事件推送。 */
const ACTIVE_POLL_INTERVAL_MS = 2_000;

type VideoDownloadChangedEvent = {
  id: string;
  item: VideoDownloadItem | null;
};

type VideoDownloadProgressEvent = {
  id: string;
  downloaded_bytes: number;
  total_bytes: number;
  status: VideoDownloadStatus;
};

/**
 * 下载依赖原生宿主的文件系统与媒体合并能力：桌面端用 FFmpeg，Android 用
 * `MediaMuxer`。浏览器预览没有 Tauri IPC，不提供下载。
 */
export function videoDownloadSupported(): boolean {
  return isTauri();
}

/** 桌面端可以定位文件；Android 只能交给系统播放器打开。 */
export function videoDownloadCanReveal(): boolean {
  return getClientPlatform() === "desktop";
}

export function videoDownloadStatusLabel(status: VideoDownloadStatus): string {
  switch (status) {
    case "queued":
      return "等待下载";
    case "downloading":
      return "下载中";
    case "paused":
      return "已暂停";
    case "merging":
      return "合并中";
    case "failed":
      return "下载失败";
    default:
      return "已完成";
  }
}

export function videoDownloadPercent(item: VideoDownloadItem): number {
  if (item.total_bytes <= 0) return 0;
  return Math.min(100, Math.max(0, (item.downloaded_bytes / item.total_bytes) * 100));
}

export function videoDownloadList(): Promise<VideoDownloadItem[]> {
  return invokeCmd<VideoDownloadItem[]>("video_download_list");
}

/** 由 Rust 侧打开下载根目录，避开 WebView 的 `openPath` 路径作用域限制。 */
export function videoDownloadOpenDirectory(): Promise<void> {
  return invokeCmd<void>("video_download_open_directory");
}

export function videoDownloadStart(input: VideoDownloadInput): Promise<VideoDownloadItem> {
  return invokeCmd<VideoDownloadItem>("video_download_start", { input });
}

export function videoDownloadPause(id: string): Promise<VideoDownloadItem> {
  return invokeCmd<VideoDownloadItem>("video_download_pause", { id });
}

export function videoDownloadResume(id: string): Promise<VideoDownloadItem> {
  return invokeCmd<VideoDownloadItem>("video_download_resume", { id });
}

export function videoDownloadDelete(id: string): Promise<void> {
  return invokeCmd<void>("video_download_delete", { id });
}

export function videoDownloadOpen(id: string): Promise<void> {
  return invokeCmd<void>("video_download_open", { id });
}

/** 每次进入播放页都重新取地址：本地服务的 token URL 在进程重启后失效。 */
export function videoDownloadPlaybackInfo(id: string): Promise<VideoDownloadPlaybackInfo> {
  return invokeCmd<VideoDownloadPlaybackInfo>("video_download_playback_info", { id });
}

export function videoDownloadWatchProgressReport(
  input: VideoDownloadWatchProgressInput,
): Promise<void> {
  return invokeCmd<void>("video_download_watch_progress_report", input);
}

export function upsertVideoDownloadInCache(
  queryClient: QueryClient,
  item: VideoDownloadItem,
): void {
  queryClient.setQueryData<VideoDownloadItem[]>(VIDEO_DOWNLOADS_QUERY_KEY, (items) => {
    if (!items) return items;
    return mergeVideoDownload(items, item);
  });
}

/**
 * 下载列表 + 事件订阅。
 *
 * 事件只在页面挂载期间订阅；离开页签后任务继续在后台跑，回来时会重新取一次
 * 全量列表。会自行推进的任务同时保留低频轮询，事件丢失（窗口重建、监听
 * 注册竞态）时进度仍能收敛；暂停和失败不会被无意义地轮询。
 */
export function useVideoDownloads(enabled = true) {
  const queryClient = useQueryClient();
  const supported = videoDownloadSupported();
  const query = useQuery({
    queryKey: VIDEO_DOWNLOADS_QUERY_KEY,
    queryFn: videoDownloadList,
    enabled: enabled && supported,
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.data?.some((item) => videoDownloadNeedsPolling(item.status))
        ? ACTIVE_POLL_INTERVAL_MS
        : false,
  });

  useEffect(() => {
    if (!enabled || !supported) return;
    let disposed = false;
    const unlisten: UnlistenFn[] = [];
    const register = <T>(event: string, handler: (payload: T) => void) => {
      void listen<T>(event, (received) => handler(received.payload))
        .then((stop) => {
          if (disposed) stop();
          else unlisten.push(stop);
        })
        .catch(() => undefined);
    };

    register<VideoDownloadChangedEvent>(VIDEO_DOWNLOAD_CHANGED_EVENT, (payload) => {
      queryClient.setQueryData<VideoDownloadItem[]>(VIDEO_DOWNLOADS_QUERY_KEY, (items) => {
        if (!payload.item) {
          return items?.filter((item) => item.id !== payload.id);
        }
        if (!items) return items;
        return mergeVideoDownload(items, payload.item);
      });
    });
    register<VideoDownloadProgressEvent>(VIDEO_DOWNLOAD_PROGRESS_EVENT, (payload) => {
      queryClient.setQueryData<VideoDownloadItem[]>(VIDEO_DOWNLOADS_QUERY_KEY, (items) =>
        items ? applyVideoDownloadProgress(items, payload) : items,
      );
    });

    return () => {
      disposed = true;
      for (const stop of unlisten) stop();
    };
  }, [enabled, queryClient, supported]);

  return query;
}
