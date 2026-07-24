import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { invokeCmd } from "@/shared/api/tauri";
import type { LivePlayQuality, LiveRoomDetail, PlayUrl, SiteId } from "@/shared/types/live";
import type { PlayerEvent, QualityLevel } from "@/shared/types/player";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { clampIndex } from "@/lib/playUrl";
import { pickDefaultQualityIndex } from "./quality";
import { nextFailoverAction } from "./failover";

const EMPTY_QUALITIES: LivePlayQuality[] = [];
const EMPTY_PLAY_URLS: PlayUrl[] = [];

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
  /** Call when native player reports eof/error for the active session. */
  onPlayerMediaFailure: (event: PlayerEvent) => void;
  /** Notify that the current media is healthy (playing). */
  onPlayerPlaying: () => void;
  /** Bump when we want the player to reload the same playUrl (retry). */
  reloadToken: number;
};

export function usePlaybackController(opts: {
  siteId: SiteId | undefined;
  roomId: string | undefined;
  detail: LiveRoomDetail | undefined;
  /** When true, apply default quality preference once per qualities payload. */
  enabled?: boolean;
}): PlaybackController {
  const { siteId, roomId, detail, enabled = true } = opts;
  const qualityLevel = useSettingsStore((s) => s.qualityLevel) as QualityLevel;

  const [qualityIndex, setQualityIndex] = useState(0);
  const [lineIndex, setLineIndex] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const retryCountRef = useRef(0);
  const failoverTimerRef = useRef<number | null>(null);
  const appliedQualitiesKeyRef = useRef<string | null>(null);
  const lineIndexRef = useRef(0);
  const lineCountRef = useRef(0);

  useEffect(() => {
    lineIndexRef.current = lineIndex;
  }, [lineIndex]);

  const clearFailoverTimer = useCallback(() => {
    if (failoverTimerRef.current != null) {
      window.clearTimeout(failoverTimerRef.current);
      failoverTimerRef.current = null;
    }
  }, []);

  // A direct route change reuses this hook instance. Reset local choices even
  // when two rooms expose identically named qualities, otherwise a stale line
  // index or the previous quality cache key can carry into the new stream.
  useEffect(() => {
    clearFailoverTimer();
    appliedQualitiesKeyRef.current = null;
    retryCountRef.current = 0;
    setQualityIndex(0);
    setLineIndex(0);
    setLoadError(null);
  }, [siteId, roomId, detail?.room_id, clearFailoverTimer]);

  const qualitiesQuery = useQuery({
    queryKey: ["play_qualities", siteId, roomId, detail?.room_id],
    enabled: enabled && !!detail,
    // Live play metadata expires quickly; always refresh when re-entering a room.
    staleTime: 0,
    gcTime: 30_000,
    refetchOnMount: "always",
    queryFn: () =>
      invokeCmd<LivePlayQuality[]>("site_get_play_qualities", {
        siteId,
        detail,
      }),
  });

  const qualities = qualitiesQuery.data ?? EMPTY_QUALITIES;
  const qualitiesKey = useMemo(() => {
    if (!qualities.length) return "";
    return qualities.map((q) => `${q.quality}:${String(q.data)}`).join("|");
  }, [qualities]);

  // Apply Simple Live default quality once per qualities payload.
  useEffect(() => {
    if (!qualitiesKey || qualities.length === 0) return;
    if (appliedQualitiesKeyRef.current === qualitiesKey) return;
    appliedQualitiesKeyRef.current = qualitiesKey;
    const idx = pickDefaultQualityIndex(qualities.length, qualityLevel);
    setQualityIndex(idx);
    setLineIndex(0);
    retryCountRef.current = 0;
    setLoadError(null);
  }, [qualitiesKey, qualities.length, qualityLevel]);

  const selectedQuality: LivePlayQuality | null = useMemo(() => {
    if (qualities.length === 0) return null;
    return qualities[clampIndex(qualityIndex, qualities.length)] ?? null;
  }, [qualities, qualityIndex]);

  useEffect(() => {
    setLineIndex(0);
    retryCountRef.current = 0;
  }, [selectedQuality?.quality, selectedQuality?.data]);

  const playUrlQuery = useQuery({
    queryKey: ["play_urls", siteId, roomId, selectedQuality?.quality, selectedQuality?.data],
    enabled: enabled && !!detail && !!selectedQuality,
    // CDN play URLs (esp. FLV/HLS tokens) go stale within minutes. Re-enter
    // must not reuse the previous visit's cached list — that caused black
    // screen until the user manually switched quality/line.
    staleTime: 0,
    gcTime: 15_000,
    refetchOnMount: "always",
    queryFn: () =>
      invokeCmd<PlayUrl[]>("site_get_play_urls", {
        siteId,
        detail,
        quality: selectedQuality,
      }),
  });

  const lines = playUrlQuery.data ?? EMPTY_PLAY_URLS;
  lineCountRef.current = lines.length;
  const playUrl = lines[clampIndex(lineIndex, lines.length)] ?? null;

  useEffect(() => () => clearFailoverTimer(), [clearFailoverTimer]);

  const onQualityChange = useCallback(
    (index: number) => {
      clearFailoverTimer();
      retryCountRef.current = 0;
      setLoadError(null);
      setQualityIndex(index);
      setLineIndex(0);
    },
    [clearFailoverTimer],
  );

  const onLineChange = useCallback(
    (index: number) => {
      clearFailoverTimer();
      retryCountRef.current = 0;
      setLoadError(null);
      setLineIndex(index);
    },
    [clearFailoverTimer],
  );

  const retryPlay = useCallback(() => {
    clearFailoverTimer();
    retryCountRef.current = 0;
    setLoadError(null);
    // A metadata refetch alone does not recreate an already-attached MSE
    // player when the CDN returns the same URL. Bump the session token first
    // so the refresh control always rebuilds the active playback pipeline.
    setReloadToken((token) => token + 1);
    void qualitiesQuery.refetch().then(() => playUrlQuery.refetch());
  }, [clearFailoverTimer, qualitiesQuery, playUrlQuery]);

  const onPlayerPlaying = useCallback(() => {
    retryCountRef.current = 0;
    setLoadError(null);
  }, []);

  const onPlayerMediaFailure = useCallback(
    (event: PlayerEvent) => {
      if (event.kind !== "error" && event.kind !== "eof") return;
      clearFailoverTimer();
      const action = nextFailoverAction({
        retryCount: retryCountRef.current,
        lineIndex: lineIndexRef.current,
        lineCount: lineCountRef.current,
      });

      if (action.type === "fail") {
        setLoadError(event.message?.trim() || action.message);
        return;
      }

      const apply = () => {
        retryCountRef.current = action.retryCount;
        if (action.type === "next_line") {
          setLineIndex(action.lineIndex);
        } else {
          // Same line: force player session to re-load via token bump.
          setReloadToken((t) => t + 1);
        }
      };

      if (action.delayMs > 0) {
        failoverTimerRef.current = window.setTimeout(apply, action.delayMs);
      } else {
        apply();
      }
    },
    [clearFailoverTimer],
  );

  const loading = qualitiesQuery.isLoading || (qualitiesQuery.isSuccess && playUrlQuery.isLoading);

  const error = qualitiesQuery.isError
    ? qualitiesQuery.error
    : playUrlQuery.isError
      ? playUrlQuery.error
      : qualitiesQuery.isSuccess && playUrlQuery.isSuccess && !playUrl
        ? {
            code: "no_play_url",
            message: "当前清晰度没有可用播放地址",
            site: siteId ?? null,
            retryable: true,
          }
        : undefined;

  return {
    qualities,
    qualityIndex: clampIndex(qualityIndex, Math.max(qualities.length, 1)),
    lines,
    lineIndex: clampIndex(lineIndex, Math.max(lines.length, 1)),
    playUrl,
    loading,
    error,
    loadError,
    setLoadError,
    onQualityChange,
    onLineChange,
    retryPlay,
    onPlayerMediaFailure,
    onPlayerPlaying,
    reloadToken,
  };
}
