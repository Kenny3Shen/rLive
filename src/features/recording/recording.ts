import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
import { invokeCmd } from "@/shared/api/tauri";
import { getClientPlatform } from "@/shared/clientPlatform";
import { isSiteId } from "@/shared/siteId";
import type { PlayUrl, PlaybackProtocol, SiteId } from "@/shared/types/live";
import { notify } from "@/components/ui/toast";

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
};

export const RECORDINGS_QUERY_KEY = ["recordings"] as const;
export const RECORDING_STORAGE_QUERY_KEY = ["recording-storage"] as const;
export const RECORDING_PLAYBACK_QUERY_KEY = "recording-playback";
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

/** Keep media progress inside the duration exposed by the recording metadata. */
export function clampRecordingPlaybackTime(currentTime: number, duration: number): number {
  const time = Number.isFinite(currentTime) ? Math.max(0, currentTime) : 0;
  if (!Number.isFinite(duration) || duration <= 0) return time;
  return Math.min(time, duration);
}

/** Snap a real EOF to metadata duration without hiding an earlier media stop. */
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

/** A seek may complete on EOF only when it was explicitly aimed at the end. */
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
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return (bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1) + " " + units[index];
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
      // Polling remains available even if native listener cleanup fails.
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
              // One query client must not prevent the others from refreshing.
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
          // A remount while the stale registration was pending needs a fresh
          // attempt. Otherwise the active-recording poll remains the fallback.
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

export function useRecordings() {
  const supported = recordingSupported();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!supported) return;
    return subscribeToRecordingChanges(queryClient);
  }, [queryClient, supported]);
  return useQuery({
    queryKey: RECORDINGS_QUERY_KEY,
    enabled: supported,
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
  { includeDanmaku = false, continueOnLeave = false }: RecordingStartOptions = {},
): Promise<RecordingItem> {
  return invokeCmd<RecordingItem>("recording_start", {
    input: {
      source: context.source,
      sourceKey: context.sourceKey,
      sourceKind: context.sourceKind,
      siteId: context.siteId ?? null,
      roomId: context.roomId ?? null,
      title: context.title,
      userName: context.userName ?? "",
      cover: context.cover ?? "",
      userAvatar: context.userAvatar ?? "",
      includeDanmaku,
      continueOnLeave,
    },
  });
}

export function useRecordingController(context: RecordingContext | null) {
  const queryClient = useQueryClient();
  const supported = recordingSupported();
  const query = useRecordings();
  const startMutation = useMutation({
    mutationFn: ({ includeDanmaku = false, continueOnLeave = false }: RecordingStartOptions) =>
      context
        ? startRecording(context, { includeDanmaku, continueOnLeave })
        : Promise.reject(new Error("缺少录制上下文")),
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

export async function stopRecording(id: string): Promise<RecordingItem> {
  return invokeCmd<RecordingItem>("recording_stop", { id });
}

export async function deleteRecording(id: string): Promise<void> {
  await invokeCmd<void>("recording_delete", { id });
}

export async function recordingStorageInfo(): Promise<RecordingStorageInfo> {
  return invokeCmd<RecordingStorageInfo>("recording_storage_info");
}

export async function setRecordingStoragePath(path: string | null): Promise<RecordingStorageInfo> {
  return invokeCmd<RecordingStorageInfo>("recording_set_storage_path", { path });
}

export async function recordingDanmakuUrl(id: string): Promise<string | null> {
  return invokeCmd<string | null>("recording_danmaku_url", { id });
}

/**
 * Writes an ASS subtitle next to the recorded media and resolves with its
 * absolute path. External players load it by the shared file name.
 */
export async function exportRecordingDanmakuAss(id: string): Promise<string> {
  return invokeCmd<string>("recording_danmaku_export_ass", { id });
}
