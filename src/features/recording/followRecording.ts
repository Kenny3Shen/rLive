import { useCallback, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { notify } from "@/components/ui/toast";
import { pickDefaultQualityIndex } from "@/features/room/playback/quality";
import {
  playbackLinePreferenceRoomKey,
  readPlaybackLinePreference,
  resolvePlaybackLineIndex,
} from "@/features/room/playback/linePreference";
import { nextDanmakuConnectionEpoch } from "@/features/room/danmaku/connectionEpoch";
import { invokeCmd } from "@/shared/api/tauri";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import type { FollowUser, LivePlayQuality, LiveRoomDetail, PlayUrl } from "@/shared/types/live";
import type { QualityLevel } from "@/shared/types/player";
import {
  FOLLOW_LIST_QUERY_KEY,
  FOLLOW_STATUS_REFRESH_INTERVAL_MS,
} from "@/features/follow/followRefresh";
import {
  RECORDINGS_QUERY_KEY,
  recordingErrorMessage,
  recordingSupported,
  startRecording,
  useRecordings,
  type RecordingContext,
  type RecordingItem,
} from "./recording";

export type FollowRecordingTarget = Pick<FollowUser, "site_id" | "room_id">;

export const FOLLOW_AUTO_RECORD_QUERY_KEY = ["follows", "auto-record"] as const;

export function liveRecordingSourceKey(target: FollowRecordingTarget): string {
  return `live:${target.site_id}:${target.room_id.trim()}`;
}

export function followRecordingSessionKey(
  target: Pick<FollowUser, "site_id" | "room_id" | "live_started_at">,
): string {
  return `${target.site_id}\u0000${target.room_id.trim()}\u0000${target.live_started_at ?? "unknown"}`;
}

export function autoRecordableFollows(follows: readonly FollowUser[]): FollowUser[] {
  return follows.filter((follow) => follow.auto_record && follow.live_status === true);
}

export function activeRecordingForLiveRoom(
  items: readonly RecordingItem[] | undefined,
  target: FollowRecordingTarget,
): RecordingItem | null {
  const roomId = target.room_id.trim();
  const sourceKey = liveRecordingSourceKey(target);
  return (
    items?.find(
      (item) =>
        item.status === "recording" &&
        (item.source_key.trim() === sourceKey ||
          (item.source_kind === "live" &&
            item.site_id === target.site_id &&
            item.room_id?.trim() === roomId)),
    ) ?? null
  );
}

export function followRecordingContext(
  target: FollowRecordingTarget,
  detail: LiveRoomDetail,
  source: PlayUrl,
): RecordingContext {
  return {
    source,
    sourceKey: liveRecordingSourceKey(target),
    sourceKind: "live",
    siteId: detail.site_id,
    roomId: detail.room_id,
    title: detail.title || "直播间",
    userName: detail.user_name,
    cover: detail.cover || detail.user_avatar || "",
    userAvatar: detail.user_avatar || "",
  };
}

export async function resolveFollowRecordingContext(
  queryClient: QueryClient,
  target: FollowRecordingTarget,
  qualityLevel: QualityLevel,
): Promise<RecordingContext> {
  const detail = await queryClient.fetchQuery({
    queryKey: ["room_detail", target.site_id, target.room_id],
    staleTime: 0,
    queryFn: () =>
      invokeCmd<LiveRoomDetail>("site_get_room_detail", {
        siteId: target.site_id,
        roomId: target.room_id,
      }),
  });
  if (!detail.status) throw new Error("主播当前未开播");

  const qualities = await queryClient.fetchQuery({
    queryKey: ["play_qualities", target.site_id, target.room_id, detail.room_id],
    staleTime: 0,
    gcTime: 30_000,
    queryFn: () =>
      invokeCmd<LivePlayQuality[]>("site_get_play_qualities", {
        siteId: target.site_id,
        detail,
      }),
  });
  if (qualities.length === 0) throw new Error("平台未返回可用清晰度");

  const quality = qualities[pickDefaultQualityIndex(qualities.length, qualityLevel)];
  if (!quality) throw new Error("平台未返回可用清晰度");
  const lines = await queryClient.fetchQuery({
    queryKey: ["play_urls", target.site_id, target.room_id, quality.quality, quality.data],
    staleTime: 0,
    gcTime: 15_000,
    queryFn: () =>
      invokeCmd<PlayUrl[]>("site_get_play_urls", {
        siteId: target.site_id,
        detail,
        quality,
      }),
  });
  if (lines.length === 0) throw new Error("平台未返回可用播放地址");

  const roomKey = playbackLinePreferenceRoomKey(target.site_id, detail.room_id || target.room_id);
  const lineIndex = resolvePlaybackLineIndex(lines, readPlaybackLinePreference(roomKey));
  const source = lines[lineIndex];
  if (!source) throw new Error("平台未返回可用播放地址");
  return followRecordingContext(target, detail, source);
}

async function retainRecordingDanmaku(target: FollowRecordingTarget): Promise<void> {
  const connectionEpoch = nextDanmakuConnectionEpoch();
  try {
    await invokeCmd("danmaku_connect", {
      siteId: target.site_id,
      roomId: target.room_id,
      connectionEpoch,
    });
  } finally {
    // 复用这条连接的 generation。若导航已经安装了更新的房间，
    // 原生围栏会让这次 detach 变成无操作而不影响它。
    await invokeCmd("danmaku_disconnect", {
      connectionEpoch,
    });
  }
}

async function startFollowRecording(
  queryClient: QueryClient,
  target: FollowRecordingTarget,
  qualityLevel: QualityLevel,
  includeDanmaku: boolean,
): Promise<RecordingItem> {
  const context = await resolveFollowRecordingContext(queryClient, target, qualityLevel);
  const item = await startRecording(context, {
    includeDanmaku,
    // 关注录制的启动总是发生在所属播放器页之外。
    continueOnLeave: true,
  });
  queryClient.setQueryData<RecordingItem[]>(RECORDINGS_QUERY_KEY, (current) => [
    item,
    ...(current ?? []).filter((entry) => entry.id !== item.id),
  ]);
  if (item.include_danmaku) {
    void retainRecordingDanmaku(target).catch(() => {
      notify.info("弹幕连接失败", `${item.title}的媒体录制仍在继续。`);
    });
  }
  return item;
}

export function useFollowRecordingController() {
  const queryClient = useQueryClient();
  const recordings = useRecordings();
  const qualityLevel = useSettingsStore((state) => state.qualityLevel);
  const includeDanmaku = useSettingsStore((state) => state.recordingIncludeDanmaku);
  const supported = recordingSupported();
  const mutation = useMutation({
    mutationFn: async (target: FollowRecordingTarget) => {
      const item = await startFollowRecording(queryClient, target, qualityLevel, includeDanmaku);
      return { item, target };
    },
    onSuccess: ({ item }) => {
      notify.success("已开始录制", item.title);
    },
    onError: (error) => notify.error("开始录制失败", recordingErrorMessage(error)),
  });

  const activeFor = useCallback(
    (target: FollowRecordingTarget) => activeRecordingForLiveRoom(recordings.data, target),
    [recordings.data],
  );
  const start = useCallback(
    (target: FollowRecordingTarget) => {
      if (!supported || recordings.isPending || mutation.isPending || activeFor(target)) return;
      mutation.mutate(target);
    },
    [activeFor, mutation, recordings.isPending, supported],
  );
  return {
    activeFor,
    busy: recordings.isPending || mutation.isPending,
    pendingTarget: mutation.isPending ? mutation.variables : undefined,
    start,
    supported,
  };
}

/**
 * 让自动关注录制独立于当前路由存活。只轮询开启了各自自动录制开关的关注项。
 * 首次刷新立即执行；后续刷新使用共享的状态节奏。
 */
export function useFollowAutoRecording() {
  const queryClient = useQueryClient();
  const hydrated = useSettingsStore((state) => state.hydratedFromBackend);
  const qualityLevel = useSettingsStore((state) => state.qualityLevel);
  const includeDanmaku = useSettingsStore((state) => state.recordingIncludeDanmaku);
  const supported = recordingSupported();
  const enabled = hydrated && supported;
  const autoFollows = useQuery({
    queryKey: FOLLOW_AUTO_RECORD_QUERY_KEY,
    queryFn: () => invokeCmd<FollowUser[]>("follow_refresh_auto_record"),
    enabled,
    refetchInterval: FOLLOW_STATUS_REFRESH_INTERVAL_MS,
    retry: false,
  });
  const recordings = useRecordings(enabled && (autoFollows.data?.length ?? 0) > 0);
  const autoRunRef = useRef(false);
  const attemptedSessionsRef = useRef(new Set<string>());

  useEffect(() => {
    if (!enabled) {
      attemptedSessionsRef.current.clear();
      return;
    }
    const next = autoFollows.data;
    if (!next) return;
    const updates = new Map(next.map((follow) => [liveRecordingSourceKey(follow), follow]));
    queryClient.setQueryData<FollowUser[]>(FOLLOW_LIST_QUERY_KEY, (current) =>
      current?.map((follow) => updates.get(liveRecordingSourceKey(follow)) ?? follow),
    );
    const liveSessions = new Set(autoRecordableFollows(next).map(followRecordingSessionKey));
    for (const session of attemptedSessionsRef.current) {
      if (!liveSessions.has(session)) attemptedSessionsRef.current.delete(session);
    }
  }, [autoFollows.data, autoFollows.dataUpdatedAt, enabled, queryClient]);

  useEffect(() => {
    if (!enabled || !autoFollows.data || recordings.isPending || autoRunRef.current) {
      return;
    }
    const liveTargets = autoRecordableFollows(autoFollows.data);
    if (liveTargets.length === 0) return;

    autoRunRef.current = true;
    void (async () => {
      try {
        for (const target of liveTargets) {
          const cachedTarget = queryClient
            .getQueryData<FollowUser[]>(FOLLOW_LIST_QUERY_KEY)
            ?.find(
              (follow) => follow.site_id === target.site_id && follow.room_id === target.room_id,
            );
          if (cachedTarget && !cachedTarget.auto_record) continue;
          const sessionKey = followRecordingSessionKey(target);
          if (attemptedSessionsRef.current.has(sessionKey)) continue;
          attemptedSessionsRef.current.add(sessionKey);
          const current = queryClient.getQueryData<RecordingItem[]>(RECORDINGS_QUERY_KEY);
          if (activeRecordingForLiveRoom(current, target)) continue;
          try {
            const item = await startFollowRecording(
              queryClient,
              target,
              qualityLevel,
              includeDanmaku,
            );
            notify.success("已自动开始录制", item.title);
          } catch (error) {
            attemptedSessionsRef.current.delete(sessionKey);
            notify.error("自动录制失败", recordingErrorMessage(error));
          }
        }
      } finally {
        autoRunRef.current = false;
      }
    })();
  }, [
    autoFollows.data,
    autoFollows.dataUpdatedAt,
    enabled,
    includeDanmaku,
    qualityLevel,
    queryClient,
    recordings.isPending,
  ]);
}
