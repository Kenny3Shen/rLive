import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
import { invokeCmd } from "@/shared/api/tauri";
import { getClientPlatform } from "@/shared/clientPlatform";
import { isSiteId } from "@/shared/siteId";
import type { PlayUrl, PlaybackProtocol, SiteId } from "@/shared/types/live";
import { notify } from "@/components/ui/toast";
import { formatByteSize } from "@/lib/utils";
import type { RecordingView } from "./recordingRoute";

export type RecordingStatus = "recording" | "completed" | "interrupted" | "failed";

export type RecordingItem = {
  id: string;
  source_key: string;
  source_kind: string;
  site_id: string | null;
  room_id: string | null;
  title: string;
  user_name: string;
  cover: string;
  user_avatar: string;
  protocol: PlaybackProtocol;
  status: RecordingStatus;
  started_at: number;
  ended_at: number | null;
  duration_ms: number;
  size_bytes: number;
  include_danmaku: boolean;
  continue_on_leave: boolean;
  danmaku_count: number;
  danmaku_file: string | null;
  file_path: string;
  error: string | null;
};

export type RecordingStorageInfo = {
  path: string;
  default_path: string;
  is_default: boolean;
  available_bytes: number | null;
  minimum_free_bytes: number;
};

export type RecordingProgress = {
  recordingId: string;
  durationMs: number;
  sizeBytes: number;
  danmakuCount: number;
};

/**
 * 一段录制的回放观看进度（断点续播）。镜像 Rust
 * `db::recording_watch::RecordingWatchProgress`。
 *
 * 与上面的 `RecordingProgress` 不是一回事：那个是**录制中**的产出量（时长/体积/
 * 弹幕条数）随事件增长，这个是**看过多少**，只在回放时写入。
 */
export type RecordingWatchProgress = {
  /** 录制 id，与 `RecordingItem.id` 同一空间。 */
  id: string;
  /** 已观看位置，秒。 */
  progress: number;
  /** 录制总时长，秒；未知为 0。 */
  duration: number;
  /** 最后观看时间，Unix 毫秒。 */
  watched_at: number;
};

export type RecordingContext = {
  source: PlayUrl;
  sourceKey: string;
  sourceKind: "live" | "iptv";
  siteId?: string;
  roomId?: string;
  title: string;
  userName?: string;
  cover?: string;
  userAvatar?: string;
  /**
   * 仅为录制单独提供播放地址，在开始时替换 `source`。
   *
   * 凡 `source` 是屏幕上播放器正在拉取的 URL，都应设置此项。播放器经 Rust
   * `stream_proxy` 推流而录制直连上游，同一个地址意味着两条独立连接；
   * 按请求签名且每个签名只允许一个消费者的站点会掐断第二条，
   * 录制会在开始后不久失败。
   *
   * 已经拿到了无人共用的 URL 的调用方不必设置此项。
   */
  resolveRecordingSource?: () => Promise<PlayUrl>;
};

export const RECORDINGS_QUERY_KEY = ["recordings"] as const;
export const RECORDING_STORAGE_QUERY_KEY = ["recording-storage"] as const;
export const RECORDING_PLAYBACK_QUERY_KEY = "recording-playback";
/** 全部录制的观看进度（列表卡片画进度用）；上报后按它失效缓存。 */
export const RECORDING_WATCH_PROGRESS_QUERY_KEY = ["recording-watch-progress"] as const;
/**
 * 单段录制的续播位置。
 *
 * 刻意不挂在 `RECORDING_WATCH_PROGRESS_QUERY_KEY` 前缀下：上报会按那个前缀失效
 * 缓存，而这条查询的数据形状是单条记录而不是列表，混在同一前缀下会被写成数组。
 */
export const RECORDING_WATCH_PROGRESS_RESUME_KEY = "recording-watch-progress-resume";
const RECORDING_CHANGED_EVENT = "recording-changed";
const RECORDING_PROGRESS_EVENT = "recording-progress";

export type RecordingPlatformFilter = "all" | SiteId;

export function recordingPlatformFromSearch(value: string | null): RecordingPlatformFilter {
  return isSiteId(value) ? value : "all";
}

export function recordingsForPlatform(
  items: readonly RecordingItem[],
  platform: RecordingPlatformFilter,
): readonly RecordingItem[] {
  return platform === "all" ? items : items.filter((item) => item.site_id === platform);
}

/**
 * 按头部作用域拆分库。"已录制"覆盖所有已结束的任务，
 * 包括被打断和失败的：它们同样不再运行，
 * 且磁盘上仍有媒体。
 */
export function recordingsForView(
  items: readonly RecordingItem[],
  view: RecordingView,
): readonly RecordingItem[] {
  if (view === "all") return items;
  const recording = view === "recording";
  return items.filter((item) => (item.status === "recording") === recording);
}

export function activeRecordingCount(items: readonly RecordingItem[] | undefined): number {
  return items?.reduce((count, item) => count + (item.status === "recording" ? 1 : 0), 0) ?? 0;
}

export function recordingUserGroupKey(
  item: Pick<RecordingItem, "site_id" | "source_kind" | "user_name">,
): string {
  const source = item.site_id?.trim() || item.source_kind.trim() || "unknown";
  return `${source}::${item.user_name.trim()}`;
}

export type RecordingStartOptions = {
  includeDanmaku?: boolean;
  continueOnLeave?: boolean;
};

export type RecordingOptionDefaults = {
  includeDanmaku: boolean;
  continueOnLeave: boolean;
};

export function resolveRecordingControlOptions(
  defaults: RecordingOptionDefaults,
  overrides: RecordingStartOptions = {},
): RecordingOptionDefaults {
  return {
    includeDanmaku: overrides.includeDanmaku ?? defaults.includeDanmaku,
    continueOnLeave: overrides.continueOnLeave ?? defaults.continueOnLeave,
  };
}

export function recordingErrorMessage(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error ?? "未知错误");
}

export function recordingSupported(): boolean {
  return getClientPlatform() === "desktop" && isTauri();
}

export function formatRecordingDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) {
    return (
      hours + ":" + String(minutes).padStart(2, "0") + ":" + String(remainder).padStart(2, "0")
    );
  }
  return minutes + ":" + String(remainder).padStart(2, "0");
}

/** 把媒体进度限制在录制元数据暴露的时长之内。 */
export function clampRecordingPlaybackTime(currentTime: number, duration: number): number {
  const time = Number.isFinite(currentTime) ? Math.max(0, currentTime) : 0;
  if (!Number.isFinite(duration) || duration <= 0) return time;
  return Math.min(time, duration);
}

/** 把真实的 EOF 吸附到元数据时长，同时不掩盖更早发生的媒体停止。 */
export function recordingEndedPlaybackTime(
  currentTime: number,
  duration: number,
  toleranceSeconds: number,
): number {
  const bounded = clampRecordingPlaybackTime(currentTime, duration);
  if (!Number.isFinite(duration) || duration <= 0) return bounded;
  const tolerance = Number.isFinite(toleranceSeconds) ? Math.max(0, toleranceSeconds) : 0;
  return duration - bounded <= tolerance ? duration : bounded;
}

/** 只有明确瞄准结尾的 seek 才允许在 EOF 上完成。 */
export function recordingSeekReached(
  currentTime: number,
  target: number,
  duration: number,
  mediaEnded: boolean,
  toleranceSeconds: number,
): boolean {
  if (!Number.isFinite(target)) return false;
  const tolerance = Number.isFinite(toleranceSeconds) ? Math.max(0, toleranceSeconds) : 0;
  if (!mediaEnded) return Math.abs(currentTime - target) <= tolerance;
  return (
    Number.isFinite(duration) &&
    duration > 0 &&
    Math.abs(target - duration) <= tolerance &&
    Math.abs(recordingEndedPlaybackTime(currentTime, duration, tolerance) - target) <= tolerance
  );
}

export function formatRecordingSize(bytes: number): string {
  return formatByteSize(bytes);
}

export function formatRecordingDate(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function recordingProtocolLabel(protocol: PlaybackProtocol): string {
  switch (protocol) {
    case "hls":
      return "HLS";
    case "mpeg_ts":
      return "MPEG-TS";
    case "native":
      return "原生";
    default:
      return "FLV";
  }
}

type NativeRecordingChangeRegistration = (
  onChange: (progress?: RecordingProgress) => void,
) => Promise<() => void>;

function validatedRecordingProgress(payload: unknown): RecordingProgress | null {
  if (typeof payload !== "object" || payload === null) return null;
  const progress = payload as Partial<RecordingProgress>;
  const validCounter = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (
    typeof progress.recordingId !== "string" ||
    progress.recordingId.length === 0 ||
    !validCounter(progress.durationMs) ||
    !validCounter(progress.sizeBytes) ||
    !validCounter(progress.danmakuCount)
  ) {
    return null;
  }
  return progress as RecordingProgress;
}

export function applyRecordingProgress(
  items: RecordingItem[] | undefined,
  progress: RecordingProgress,
): RecordingItem[] | undefined {
  if (!items) return items;
  let changed = false;
  const next = items.map((item) => {
    if (item.id !== progress.recordingId || item.status !== "recording") return item;
    const durationMs = Math.max(item.duration_ms, progress.durationMs);
    const sizeBytes = Math.max(item.size_bytes, progress.sizeBytes);
    const danmakuCount = Math.max(item.danmaku_count, progress.danmakuCount);
    if (
      durationMs === item.duration_ms &&
      sizeBytes === item.size_bytes &&
      danmakuCount === item.danmaku_count
    ) {
      return item;
    }
    changed = true;
    return {
      ...item,
      duration_ms: durationMs,
      size_bytes: sizeBytes,
      danmaku_count: danmakuCount,
    };
  });
  return changed ? next : items;
}

export function createSharedRecordingChangeSubscription<T>(
  registerNative: NativeRecordingChangeRegistration,
  notifySubscriber: (subscriber: T, progress?: RecordingProgress) => void,
): (subscriber: T) => () => void {
  const subscriberCounts = new Map<T, number>();
  let nativeUnlisten: (() => void) | null = null;
  let listenerPromise: Promise<void> | null = null;
  let listenerGeneration = 0;

  function unlistenSafely(unlisten: (() => void) | null) {
    if (!unlisten) return;
    try {
      unlisten();
    } catch {
      // 即使原生监听器清理失败，轮询仍保持可用。
    }
  }

  function ensureNativeListener() {
    if (nativeUnlisten || listenerPromise || subscriberCounts.size === 0) return;
    const generation = ++listenerGeneration;
    listenerPromise = Promise.resolve()
      .then(() =>
        registerNative((progress) => {
          if (generation !== listenerGeneration) return;
          for (const subscriber of subscriberCounts.keys()) {
            try {
              notifySubscriber(subscriber, progress);
            } catch {
              // 一个查询客户端不得阻止其他客户端刷新。
            }
          }
        }),
      )
      .then(
        (cleanup) => {
          listenerPromise = null;
          if (subscriberCounts.size === 0 || generation !== listenerGeneration) {
            unlistenSafely(cleanup);
            ensureNativeListener();
            return;
          }
          nativeUnlisten = cleanup;
        },
        () => {
          listenerPromise = null;
          // 过期注册尚未完成时发生的重挂载需要一次全新尝试。
          // 否则活动录制轮询仍是兜底。
          if (subscriberCounts.size > 0 && generation !== listenerGeneration) {
            ensureNativeListener();
          }
        },
      );
  }

  function stopNativeListenerIfUnused() {
    if (subscriberCounts.size > 0) return;
    listenerGeneration += 1;
    const cleanup = nativeUnlisten;
    nativeUnlisten = null;
    unlistenSafely(cleanup);
  }

  return (subscriber: T) => {
    subscriberCounts.set(subscriber, (subscriberCounts.get(subscriber) ?? 0) + 1);
    ensureNativeListener();
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const count = subscriberCounts.get(subscriber) ?? 0;
      if (count <= 1) {
        subscriberCounts.delete(subscriber);
      } else {
        subscriberCounts.set(subscriber, count - 1);
      }
      stopNativeListenerIfUnused();
    };
  };
}

const subscribeToRecordingChanges = createSharedRecordingChangeSubscription<QueryClient>(
  async (onChange) => {
    const unlistenChanged = await listen(RECORDING_CHANGED_EVENT, () => onChange());
    try {
      const unlistenProgress = await listen<RecordingProgress>(
        RECORDING_PROGRESS_EVENT,
        (event) => {
          const progress = validatedRecordingProgress(event.payload);
          if (progress) onChange(progress);
        },
      );
      return () => {
        unlistenProgress();
        unlistenChanged();
      };
    } catch (error) {
      unlistenChanged();
      throw error;
    }
  },
  (queryClient, progress) => {
    if (progress) {
      queryClient.setQueryData<RecordingItem[]>(RECORDINGS_QUERY_KEY, (items) =>
        applyRecordingProgress(items, progress),
      );
      return;
    }
    void queryClient.invalidateQueries({ queryKey: RECORDINGS_QUERY_KEY });
  },
);

export function useRecordings(enabled = true) {
  const supported = recordingSupported();
  const active = supported && enabled;
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!active) return;
    return subscribeToRecordingChanges(queryClient);
  }, [active, queryClient]);
  return useQuery({
    queryKey: RECORDINGS_QUERY_KEY,
    enabled: active,
    queryFn: () => invokeCmd<RecordingItem[]>("recording_list"),
    staleTime: 500,
    refetchInterval: (query) =>
      query.state.data?.some((item) => item.status === "recording") ? 15_000 : false,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });
}

export async function startRecording(
  context: RecordingContext,
  { includeDanmaku, continueOnLeave }: RecordingStartOptions = {},
): Promise<RecordingItem> {
  // 专用地址优先但绝非必需：如果站点无法再给一条线路，
  // 录制共享线路总比完全不录制好。
  let source = context.source;
  if (context.resolveRecordingSource) {
    try {
      source = await context.resolveRecordingSource();
    } catch {
      source = context.source;
    }
  }
  return invokeCmd<RecordingItem>("recording_start", {
    input: {
      source,
      sourceKey: context.sourceKey,
      sourceKind: context.sourceKind,
      siteId: context.siteId ?? null,
      roomId: context.roomId ?? null,
      title: context.title,
      userName: context.userName ?? "",
      cover: context.cover ?? "",
      userAvatar: context.userAvatar ?? "",
      ...(includeDanmaku === undefined ? {} : { includeDanmaku }),
      ...(continueOnLeave === undefined ? {} : { continueOnLeave }),
    },
  });
}

export function useRecordingController(context: RecordingContext | null) {
  const queryClient = useQueryClient();
  const supported = recordingSupported();
  const query = useRecordings();
  const startMutation = useMutation({
    mutationFn: (options: RecordingStartOptions = {}) =>
      context ? startRecording(context, options) : Promise.reject(new Error("缺少录制上下文")),
    onSuccess: (item) => {
      queryClient.setQueryData<RecordingItem[]>(RECORDINGS_QUERY_KEY, (current) => [
        item,
        ...(current ?? []).filter((entry) => entry.id !== item.id),
      ]);
      notify.success("已开始录制", item.title);
    },
    onError: (error) => notify.error("开始录制失败", recordingErrorMessage(error)),
  });
  const stopMutation = useMutation({
    mutationFn: (id: string) => invokeCmd<RecordingItem>("recording_stop", { id }),
    onSuccess: (item) => {
      void queryClient.invalidateQueries({ queryKey: RECORDINGS_QUERY_KEY });
      notify.success("录制已保存", item.title);
    },
    onError: (error) => notify.error("停止录制失败", recordingErrorMessage(error)),
  });

  const active = useMemo(
    () => activeRecordingForContext(query.data, context),
    [context, query.data],
  );

  const start = useCallback(
    (options: RecordingStartOptions = {}) => {
      if (!context || active || query.isPending || startMutation.isPending) return;
      startMutation.mutate(options);
    },
    [active, context, query.isPending, startMutation],
  );
  const stop = useCallback(() => {
    if (active && !stopMutation.isPending) stopMutation.mutate(active.id);
  }, [active, stopMutation]);
  const toggle = useCallback(() => {
    if (active) {
      stop();
    } else if (context) {
      start();
    }
  }, [active, context, start, stop]);

  return {
    ...query,
    active,
    busy: query.isPending || startMutation.isPending || stopMutation.isPending,
    start,
    stop,
    toggle,
    supported,
    error: startMutation.error ?? stopMutation.error ?? query.error,
  };
}

export function activeRecordingForContext(
  items: readonly RecordingItem[] | undefined,
  context: RecordingContext | null,
): RecordingItem | null {
  if (!context) return null;
  const sourceKey = context.sourceKey.trim();
  const liveSiteId = context.siteId?.trim() || null;
  const liveRoomId = context.roomId?.trim() || null;
  const hasLiveIdentity =
    context.sourceKind === "live" && liveSiteId !== null && liveRoomId !== null;
  return (
    items?.find(
      (item) =>
        item.status === "recording" &&
        ((sourceKey.length > 0 && item.source_key.trim() === sourceKey) ||
          (hasLiveIdentity &&
            item.source_kind === "live" &&
            item.site_id === liveSiteId &&
            item.room_id === liveRoomId)),
    ) ?? null
  );
}

export async function recordingPlaybackUrl(id: string): Promise<string> {
  return invokeCmd<string>("recording_playback_url", { id });
}

/** 全部录制的观看进度。行数由后端保留上限封顶，可以一次取回。 */
export async function recordingWatchProgressList(): Promise<RecordingWatchProgress[]> {
  return invokeCmd<RecordingWatchProgress[]>("recording_watch_progress_list");
}

/** 取单段录制的观看进度；从未看过返回 null。续播位置由它提供。 */
export async function recordingWatchProgressFind(
  id: string,
): Promise<RecordingWatchProgress | null> {
  return invokeCmd<RecordingWatchProgress | null>("recording_watch_progress_find", { id });
}

export async function recordingWatchProgressReport(item: RecordingWatchProgress): Promise<void> {
  await invokeCmd<void>("recording_watch_progress_report", { item });
}

export async function stopRecording(id: string): Promise<RecordingItem> {
  return invokeCmd<RecordingItem>("recording_stop", { id });
}

/** 在其播放器页关闭后保持进行中的录制继续存活。 */
export async function setRecordingContinueOnLeave(
  id: string,
  continueOnLeave: boolean,
): Promise<RecordingItem> {
  return invokeCmd<RecordingItem>("recording_set_continue_on_leave", {
    id,
    continueOnLeave,
  });
}

export async function deleteRecording(id: string): Promise<void> {
  await invokeCmd<void>("recording_delete", { id });
}

export async function recordingStorageInfo(): Promise<RecordingStorageInfo> {
  return invokeCmd<RecordingStorageInfo>("recording_storage_info");
}

/**
 * 后端当前正在采集的录制数量。
 *
 * 库查询是事件驱动、背后带慢速轮询的，其缓存列表可能落后于刚开始或刚结束的
 * 任务。退出对话框改为直接询问后端，
 * 因为它要决定是否向用户提问。
 */
export async function fetchActiveRecordingCount(): Promise<number> {
  return await invokeCmd<number>("recording_active_count");
}

/**
 * 停止所有录制并退出应用。
 *
 * 窗口关闭处理器阻止了自己的关闭并向用户提问，这里是确认后的回答。
 * 它成功时永不 resolve：应答送达之前进程已经消失。
 */
export async function confirmAppExit(): Promise<void> {
  await invokeCmd<void>("app_confirm_exit");
}

export async function setRecordingStoragePath(path: string | null): Promise<RecordingStorageInfo> {
  return invokeCmd<RecordingStorageInfo>("recording_set_storage_path", { path });
}

export async function recordingDanmakuUrl(id: string): Promise<string | null> {
  return invokeCmd<string | null>("recording_danmaku_url", { id });
}

/**
 * 在录制的媒体旁写出 ASS 字幕并以绝对路径 resolve。
 * 外部播放器按共享文件名加载它。
 */
export async function exportRecordingDanmakuAss(id: string): Promise<string> {
  return invokeCmd<string>("recording_danmaku_export_ass", { id });
}
