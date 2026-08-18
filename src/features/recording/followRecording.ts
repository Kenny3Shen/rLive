import { useCallback } from "react";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
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
  RECORDINGS_QUERY_KEY,
  recordingErrorMessage,
  recordingSupported,
  startRecording,
  useRecordings,
  type RecordingContext,
  type RecordingItem,
} from "./recording";

export type FollowRecordingTarget = Pick<FollowUser, "site_id" | "room_id">;

export function liveRecordingSourceKey(target: FollowRecordingTarget): string {
  return `live:${target.site_id}:${target.room_id.trim()}`;
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
    // Reuse this connection's generation. If navigation has already installed a
    // newer room, the native fence makes this detach a no-op instead of touching it.
    await invokeCmd("danmaku_disconnect", {
      connectionEpoch,
    });
  }
}

export function useFollowRecordingController() {
  const queryClient = useQueryClient();
  const recordings = useRecordings();
  const qualityLevel = useSettingsStore((state) => state.qualityLevel);
  const includeDanmaku = useSettingsStore((state) => state.recordingIncludeDanmaku);
  const supported = recordingSupported();
  const mutation = useMutation({
    mutationFn: async (target: FollowRecordingTarget) => {
      const context = await resolveFollowRecordingContext(queryClient, target, qualityLevel);
      const item = await startRecording(context, {
        includeDanmaku,
        // This action starts outside a room page, so it is always a background task.
        continueOnLeave: true,
      });
      return { item, target };
    },
    onSuccess: ({ item, target }) => {
      queryClient.setQueryData<RecordingItem[]>(RECORDINGS_QUERY_KEY, (current) => [
        item,
        ...(current ?? []).filter((entry) => entry.id !== item.id),
      ]);
      notify.success("已开始录制", item.title);
      if (item.include_danmaku) {
        void retainRecordingDanmaku(target).catch(() => {
          notify.info("弹幕连接失败", `${item.title}的媒体录制仍在继续。`);
        });
      }
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
