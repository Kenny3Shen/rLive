import { isTauri } from "@tauri-apps/api/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { invokeCmd } from "@/shared/api/tauri";
import { getClientPlatform } from "@/shared/clientPlatform";
import type { PlayUrl, PlaybackProtocol } from "@/shared/types/live";
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
};

export const RECORDINGS_QUERY_KEY = ["recordings"] as const;

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

export function useRecordings() {
  const supported = recordingSupported();
  return useQuery({
    queryKey: RECORDINGS_QUERY_KEY,
    enabled: supported,
    queryFn: () => invokeCmd<RecordingItem[]>("recording_list"),
    staleTime: 500,
    refetchInterval: (query) =>
      query.state.data?.some((item) => item.status === "recording") ? 1000 : false,
  });
}

export function useRecordingController(context: RecordingContext | null) {
  const queryClient = useQueryClient();
  const supported = recordingSupported();
  const query = useRecordings();
  const startMutation = useMutation({
    mutationFn: ({ includeDanmaku = false, continueOnLeave = false }: RecordingStartOptions) =>
      invokeCmd<RecordingItem>("recording_start", {
        input: {
          source: context?.source,
          sourceKey: context?.sourceKey,
          sourceKind: context?.sourceKind,
          siteId: context?.siteId ?? null,
          roomId: context?.roomId ?? null,
          title: context?.title ?? "",
          userName: context?.userName ?? "",
          cover: context?.cover ?? "",
          includeDanmaku,
          continueOnLeave,
        },
      }),
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
      if (!context || active || startMutation.isPending) return;
      startMutation.mutate(options);
    },
    [active, context, startMutation],
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
    busy: startMutation.isPending || stopMutation.isPending,
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
  return (
    items?.find(
      (item) =>
        item.status === "recording" &&
        (item.source_key === context.sourceKey ||
          (context.sourceKind === "live" &&
            item.source_kind === "live" &&
            item.site_id === (context.siteId ?? null) &&
            item.room_id === (context.roomId ?? null))),
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

export async function recordingStoragePath(): Promise<string> {
  return invokeCmd<string>("recording_storage_path");
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
