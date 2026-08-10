import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { invokeCmd } from "@/shared/api/tauri";
import type { LivePlayQuality, LiveRoomDetail, PlayUrl, SiteId } from "@/shared/types/live";
import type { PlayerEvent, QualityLevel } from "@/shared/types/player";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import {
  createPlaybackRecoverySession,
  type PlaybackRecoveryMetadataAdapter,
} from "./playbackRecoverySession";

export {
  isDuplicatePlaybackFailure,
  matchingQualityIndex,
  nextTwitchDecodeQualityIndex,
  playbackWasStable,
  playerRebuildRetryLimit,
} from "./playbackRecoverySession";

export type PlaybackController = {
  qualities: LivePlayQuality[];
  qualityIndex: number;
  lines: PlayUrl[];
  lineIndex: number;
  playUrl: PlayUrl | null;
  loading: boolean;
  error: unknown;
  loadError: string | null;
  setLoadError: (msg: string | null) => void;
  onQualityChange: (index: number) => void;
  onLineChange: (index: number) => void;
  retryPlay: () => void;
  onPlayerMediaFailure: (event: PlayerEvent) => void;
  onPlayerPlaying: () => void;
  reloadToken: number;
};

export function usePlaybackController(opts: {
  siteId: SiteId | undefined;
  roomId: string | undefined;
  detail: LiveRoomDetail | undefined;
  refreshDetail?: () => Promise<LiveRoomDetail | undefined>;
  enabled?: boolean;
}): PlaybackController {
  const { siteId, roomId, detail, refreshDetail, enabled = true } = opts;
  const queryClient = useQueryClient();
  const qualityLevel = useSettingsStore((state) => state.qualityLevel) as QualityLevel;

  const metadata = useMemo<PlaybackRecoveryMetadataAdapter>(
    () => ({
      fetchQualities: (input) =>
        queryClient.fetchQuery({
          queryKey: ["play_qualities", input.siteId, input.roomId, input.detail.room_id],
          staleTime: 0,
          gcTime: 30_000,
          queryFn: () =>
            invokeCmd<LivePlayQuality[]>("site_get_play_qualities", {
              siteId: input.siteId,
              detail: input.detail,
            }),
        }),
      fetchLines: (input) =>
        queryClient.fetchQuery({
          queryKey: [
            "play_urls",
            input.siteId,
            input.roomId,
            input.quality.quality,
            input.quality.data,
          ],
          staleTime: 0,
          gcTime: 15_000,
          queryFn: () =>
            invokeCmd<PlayUrl[]>("site_get_play_urls", {
              siteId: input.siteId,
              detail: input.detail,
              quality: input.quality,
            }),
        }),
      cacheQualities: (input, qualities) => {
        queryClient.setQueryData(
          ["play_qualities", input.siteId, input.roomId, input.detail.room_id],
          qualities,
        );
      },
      cacheLines: (input, lines) => {
        queryClient.setQueryData(
          ["play_urls", input.siteId, input.roomId, input.quality.quality, input.quality.data],
          lines,
        );
      },
    }),
    [queryClient],
  );

  const detailRoomId = detail?.room_id;
  const session = useMemo(
    () =>
      createPlaybackRecoverySession(
        {
          siteId,
          roomId: detailRoomId ?? roomId,
          detail: undefined,
          qualityLevel: "high",
          enabled: false,
        },
        { metadata },
      ),
    // A route change creates a new isolated recovery session. Detail refreshes
    // for the same canonical room update the existing session below.
    [detailRoomId, metadata, roomId, siteId],
  );

  useEffect(() => {
    session.updateConfig({
      siteId,
      roomId,
      detail,
      refreshDetail,
      qualityLevel,
      enabled,
    });
  }, [detail, enabled, qualityLevel, refreshDetail, roomId, session, siteId]);

  const mountedSessionRef = useRef<typeof session | null>(null);
  useEffect(() => {
    mountedSessionRef.current = session;
    return () => {
      if (mountedSessionRef.current === session) mountedSessionRef.current = null;
      // Strict Mode immediately remounts effects for the same session. Wait
      // until that probe finishes before deciding whether this instance left.
      queueMicrotask(() => {
        if (mountedSessionRef.current !== session) session.dispose();
      });
    };
  }, [session]);

  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );

  const setLoadError = useCallback(
    (message: string | null) => session.setLoadError(message),
    [session],
  );
  const onQualityChange = useCallback((index: number) => session.selectQuality(index), [session]);
  const onLineChange = useCallback((index: number) => session.selectLine(index), [session]);
  const retryPlay = useCallback(() => session.refresh(), [session]);
  const onPlayerMediaFailure = useCallback(
    (event: PlayerEvent) => session.acceptTransportFact(event),
    [session],
  );
  const onPlayerPlaying = useCallback(
    () => session.acceptTransportFact({ epoch: 0, generation: 0, kind: "playing" }),
    [session],
  );

  return {
    ...snapshot,
    setLoadError,
    onQualityChange,
    onLineChange,
    retryPlay,
    onPlayerMediaFailure,
    onPlayerPlaying,
  };
}
