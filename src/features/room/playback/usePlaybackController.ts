import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invokeCmd } from "@/shared/api/tauri";
import type { LivePlayQuality, LiveRoomDetail, PlayUrl, SiteId } from "@/shared/types/live";
import type { PlayerEvent, QualityLevel } from "@/shared/types/player";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { clampIndex } from "@/lib/playUrl";
import { pickDefaultQualityIndex } from "./quality";
import { nextFailoverAction } from "./failover";
import { isXgPlayerDecodeError } from "../player/xgPlayer";
import {
  lineDiagnostics,
  nextRankedLineIndex,
  rankPlaybackSourceIndices,
  shouldAdoptProbeWinner,
  type PlaybackLineDiagnostic,
  type PlaybackSourceProbe,
} from "./sourceSelection";

const EMPTY_QUALITIES: LivePlayQuality[] = [];
const EMPTY_PLAY_URLS: PlayUrl[] = [];
const MAX_PLAYBACK_METADATA_RENEWALS = 3;
const STABLE_PLAYBACK_RESET_MS = 30_000;
const DUPLICATE_FAILURE_WINDOW_MS = 750;

type PlaybackFailureMarker = {
  epoch: number;
  generation: number;
  lineIndex: number;
  at: number;
};

function playbackQualitiesKey(qualities: LivePlayQuality[]): string {
  return qualities.length > 0
    ? JSON.stringify(qualities.map((quality) => [quality.quality, quality.data]))
    : "";
}

function playbackErrorMessage(error: unknown, fallback: string): string {
  if (!error || typeof error !== "object" || !("message" in error)) return fallback;
  const message = String(error.message ?? "").trim();
  return message || fallback;
}

export function playbackWasStable(
  startedAt: number | null,
  failedAt: number,
  thresholdMs = STABLE_PLAYBACK_RESET_MS,
): boolean {
  return startedAt != null && failedAt >= startedAt && failedAt - startedAt >= thresholdMs;
}

export function isDuplicatePlaybackFailure(
  previous: PlaybackFailureMarker | null,
  event: Pick<PlayerEvent, "epoch" | "generation">,
  lineIndex: number,
  now: number,
  windowMs = DUPLICATE_FAILURE_WINDOW_MS,
): boolean {
  if (!previous) return false;
  const elapsed = now - previous.at;
  return (
    previous.epoch === event.epoch &&
    previous.generation === event.generation &&
    previous.lineIndex === lineIndex &&
    elapsed >= 0 &&
    elapsed < windowMs
  );
}

/** FLV plugins already retry their network request internally before reporting failure. */
export function playerRebuildRetryLimit(siteId: SiteId | undefined): number {
  return siteId === "douyu" || siteId === "huya" ? 1 : 2;
}

export function matchingQualityIndex(
  qualities: Pick<LivePlayQuality, "quality">[],
  preferredQuality: string | undefined,
  fallbackIndex: number,
): number {
  const matchingIndex = qualities.findIndex((quality) => quality.quality === preferredQuality);
  return matchingIndex >= 0 ? matchingIndex : clampIndex(fallbackIndex, qualities.length);
}

/** Return the next Twitch video rendition after a browser decode failure. */
export function nextTwitchDecodeQualityIndex(
  qualities: Pick<LivePlayQuality, "quality">[],
  currentIndex: number,
): number | null {
  for (let index = Math.max(0, currentIndex) + 1; index < qualities.length; index += 1) {
    if (!/audio[ _-]?only/i.test(qualities[index]?.quality ?? "")) return index;
  }
  return null;
}

export type PlaybackController = {
  qualities: LivePlayQuality[];
  qualityIndex: number;
  lines: PlayUrl[];
  lineIndex: number;
  playUrl: PlayUrl | null;
  lineDiagnostics: PlaybackLineDiagnostic[];
  linesTesting: boolean;
  loading: boolean;
  error: unknown;
  loadError: string | null;
  setLoadError: (msg: string | null) => void;
  onQualityChange: (index: number) => void;
  onLineChange: (index: number) => void;
  retryPlay: () => void;
  /** Call when native player reports eof/error for the active session. */
  onPlayerMediaFailure: (event: PlayerEvent) => void;
  /** Notify that the current media has produced a playable frame. */
  onPlayerPlaying: () => void;
  /** Bump when we want the player to reload the same playUrl (retry). */
  reloadToken: number;
};

export function usePlaybackController(opts: {
  siteId: SiteId | undefined;
  roomId: string | undefined;
  detail: LiveRoomDetail | undefined;
  /** Re-fetch room-scoped signing data before renewing short-lived playback URLs. */
  refreshDetail?: () => Promise<LiveRoomDetail | undefined>;
  /** When true, apply default quality preference once per qualities payload. */
  enabled?: boolean;
}): PlaybackController {
  const { siteId, roomId, detail, refreshDetail, enabled = true } = opts;
  const queryClient = useQueryClient();
  const qualityLevel = useSettingsStore((s) => s.qualityLevel) as QualityLevel;
  const smartLineSelection = useSettingsStore((s) => s.playbackSmartLineSelection);

  const [qualityIndex, setQualityIndex] = useState(0);
  const [lineIndex, setLineIndex] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [sourceProbes, setSourceProbes] = useState<PlaybackSourceProbe[]>([]);
  const [linesTesting, setLinesTesting] = useState(false);
  const retryCountRef = useRef(0);
  const playUrlRenewalCountRef = useRef(0);
  const failoverTimerRef = useRef<number | null>(null);
  const appliedQualitiesKeyRef = useRef<string | null>(null);
  const lineIndexRef = useRef(0);
  const lineCountRef = useRef(0);
  const rankedLineIndicesRef = useRef<number[]>([]);
  const exhaustedLineIndicesRef = useRef(new Set<number>());
  const hasPlayedRef = useRef(false);
  const playingStartedAtRef = useRef<number | null>(null);
  const lastFailureRef = useRef<PlaybackFailureMarker | null>(null);
  const metadataRenewalInFlightRef = useRef(false);
  const metadataRenewalSequenceRef = useRef(0);

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
    playUrlRenewalCountRef.current = 0;
    exhaustedLineIndicesRef.current.clear();
    rankedLineIndicesRef.current = [];
    hasPlayedRef.current = false;
    playingStartedAtRef.current = null;
    lastFailureRef.current = null;
    metadataRenewalInFlightRef.current = false;
    metadataRenewalSequenceRef.current += 1;
    setSourceProbes([]);
    setLinesTesting(false);
    setQualityIndex(0);
    setLineIndex(0);
    setLoadError(null);
  }, [siteId, roomId, detail?.room_id, clearFailoverTimer]);

  const qualitiesQueryKey = useMemo(
    () => ["play_qualities", siteId, roomId, detail?.room_id] as const,
    [detail?.room_id, roomId, siteId],
  );
  const qualitiesQuery = useQuery({
    queryKey: qualitiesQueryKey,
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
  const qualitiesKey = useMemo(() => playbackQualitiesKey(qualities), [qualities]);

  // Apply Simple Live default quality once per qualities payload.
  useEffect(() => {
    if (!qualitiesKey || qualities.length === 0) return;
    if (appliedQualitiesKeyRef.current === qualitiesKey) return;
    appliedQualitiesKeyRef.current = qualitiesKey;
    const idx = pickDefaultQualityIndex(qualities.length, qualityLevel);
    setQualityIndex(idx);
    setLineIndex(0);
    retryCountRef.current = 0;
    playUrlRenewalCountRef.current = 0;
    playingStartedAtRef.current = null;
    lastFailureRef.current = null;
    setLoadError(null);
  }, [qualitiesKey, qualities.length, qualityLevel]);

  const selectedQuality: LivePlayQuality | null = useMemo(() => {
    if (qualities.length === 0) return null;
    return qualities[clampIndex(qualityIndex, qualities.length)] ?? null;
  }, [qualities, qualityIndex]);

  useEffect(() => {
    setLineIndex(0);
    retryCountRef.current = 0;
    playUrlRenewalCountRef.current = 0;
    exhaustedLineIndicesRef.current.clear();
    hasPlayedRef.current = false;
    playingStartedAtRef.current = null;
    lastFailureRef.current = null;
  }, [selectedQuality?.quality]);

  const playUrlQueryKey = useMemo(
    () => ["play_urls", siteId, roomId, selectedQuality?.quality, selectedQuality?.data] as const,
    [roomId, selectedQuality?.data, selectedQuality?.quality, siteId],
  );
  const playUrlQuery = useQuery({
    queryKey: playUrlQueryKey,
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
  const sourceProbeKey = useMemo(
    () => lines.map((line, index) => `${line.source_id ?? index}:${line.url}`).join("|"),
    [lines],
  );

  useEffect(() => {
    rankedLineIndicesRef.current = lines.map((_, index) => index);
    exhaustedLineIndicesRef.current.clear();
    if (!smartLineSelection || lines.length <= 1) {
      setSourceProbes([]);
      setLinesTesting(false);
      return;
    }

    let cancelled = false;
    setSourceProbes([]);
    setLinesTesting(true);
    void invokeCmd<PlaybackSourceProbe[]>("stream_proxy_probe_sources", { sources: lines })
      .then((probes) => {
        if (cancelled) return;
        setSourceProbes(probes);
        const rankedIndices = rankPlaybackSourceIndices(lines, probes);
        rankedLineIndicesRef.current = rankedIndices;
        const winnerIndex = rankedIndices[0];
        const currentIndex = clampIndex(lineIndexRef.current, lines.length);
        if (
          winnerIndex != null &&
          shouldAdoptProbeWinner({
            currentIndex,
            winnerIndex,
            hasPlayed: hasPlayedRef.current,
            probes,
            sources: lines,
          })
        ) {
          retryCountRef.current = 0;
          playUrlRenewalCountRef.current = 0;
          exhaustedLineIndicesRef.current.clear();
          playingStartedAtRef.current = null;
          lastFailureRef.current = null;
          setLoadError(null);
          setLineIndex(winnerIndex);
        }
      })
      .catch(() => {
        // Playback remains on the platform order when diagnostics are not
        // available (for example vite-only development or a transient proxy).
      })
      .finally(() => {
        if (!cancelled) setLinesTesting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lines, smartLineSelection, sourceProbeKey]);

  const resolvedLineDiagnostics = useMemo(
    () =>
      smartLineSelection && (sourceProbes.length > 0 || linesTesting)
        ? lineDiagnostics(lines, sourceProbes, linesTesting)
        : [],
    [lines, linesTesting, smartLineSelection, sourceProbes],
  );

  useEffect(() => () => clearFailoverTimer(), [clearFailoverTimer]);

  const onQualityChange = useCallback(
    (index: number) => {
      clearFailoverTimer();
      metadataRenewalInFlightRef.current = false;
      metadataRenewalSequenceRef.current += 1;
      retryCountRef.current = 0;
      playUrlRenewalCountRef.current = 0;
      exhaustedLineIndicesRef.current.clear();
      hasPlayedRef.current = false;
      playingStartedAtRef.current = null;
      lastFailureRef.current = null;
      setLoadError(null);
      setQualityIndex(index);
      setLineIndex(0);
    },
    [clearFailoverTimer],
  );

  const onLineChange = useCallback(
    (index: number) => {
      clearFailoverTimer();
      metadataRenewalInFlightRef.current = false;
      metadataRenewalSequenceRef.current += 1;
      retryCountRef.current = 0;
      playUrlRenewalCountRef.current = 0;
      exhaustedLineIndicesRef.current.clear();
      hasPlayedRef.current = false;
      playingStartedAtRef.current = null;
      lastFailureRef.current = null;
      setLoadError(null);
      setLineIndex(index);
    },
    [clearFailoverTimer],
  );

  const refreshPlaybackMetadata = useCallback(
    async (renewalSequence: number) => {
      if (!siteId || !detail) throw new Error("缺少播放元数据");
      const preferredQuality = selectedQuality?.quality;
      const preferredSourceId = playUrl?.source_id;
      const fallbackLineIndex = lineIndexRef.current;
      const refreshedDetail = (await refreshDetail?.()) ?? detail;
      if (metadataRenewalSequenceRef.current !== renewalSequence) return false;
      const refreshedQualities = await invokeCmd<LivePlayQuality[]>("site_get_play_qualities", {
        siteId,
        detail: refreshedDetail,
      });
      if (metadataRenewalSequenceRef.current !== renewalSequence) return false;
      if (refreshedQualities.length === 0) throw new Error("平台未返回可用清晰度");

      const refreshedQualityIndex = matchingQualityIndex(
        refreshedQualities,
        preferredQuality,
        qualityIndex,
      );
      const refreshedQuality = refreshedQualities[refreshedQualityIndex];
      const refreshedLines = await invokeCmd<PlayUrl[]>("site_get_play_urls", {
        siteId,
        detail: refreshedDetail,
        quality: refreshedQuality,
      });
      if (metadataRenewalSequenceRef.current !== renewalSequence) return false;
      if (refreshedLines.length === 0) throw new Error("平台未返回可用播放地址");

      const matchingLineIndex = preferredSourceId
        ? refreshedLines.findIndex((line) => line.source_id === preferredSourceId)
        : -1;
      const refreshedLineIndex =
        matchingLineIndex >= 0
          ? matchingLineIndex
          : clampIndex(fallbackLineIndex, refreshedLines.length);
      const refreshedPlayUrlQueryKey = [
        "play_urls",
        siteId,
        roomId,
        refreshedQuality.quality,
        refreshedQuality.data,
      ] as const;

      // Mark this payload as already selected so a renewed sign does not reset
      // the user's quality choice or the bounded recovery budget.
      appliedQualitiesKeyRef.current = playbackQualitiesKey(refreshedQualities);
      queryClient.setQueryData(qualitiesQueryKey, refreshedQualities);
      queryClient.setQueryData(refreshedPlayUrlQueryKey, refreshedLines);
      setQualityIndex(refreshedQualityIndex);
      setLineIndex(refreshedLineIndex);
      return true;
    },
    [
      detail,
      playUrl?.source_id,
      qualityIndex,
      qualitiesQueryKey,
      queryClient,
      refreshDetail,
      roomId,
      selectedQuality?.quality,
      siteId,
    ],
  );

  const retryPlay = useCallback(() => {
    clearFailoverTimer();
    metadataRenewalSequenceRef.current += 1;
    const renewalSequence = metadataRenewalSequenceRef.current;
    retryCountRef.current = 0;
    playUrlRenewalCountRef.current = 0;
    exhaustedLineIndicesRef.current.clear();
    hasPlayedRef.current = false;
    playingStartedAtRef.current = null;
    lastFailureRef.current = null;
    setLoadError(null);
    metadataRenewalInFlightRef.current = true;
    void refreshPlaybackMetadata(renewalSequence)
      .then((refreshed) => {
        if (!refreshed) return;
        // A refreshed endpoint can occasionally equal the previous URL. The
        // token still guarantees a clean MSE and proxy session.
        setReloadToken((token) => token + 1);
      })
      .catch((error) => {
        if (metadataRenewalSequenceRef.current !== renewalSequence) return;
        setLoadError(playbackErrorMessage(error, "播放地址刷新失败，请重试"));
      })
      .finally(() => {
        if (metadataRenewalSequenceRef.current === renewalSequence) {
          metadataRenewalInFlightRef.current = false;
        }
      });
  }, [clearFailoverTimer, refreshPlaybackMetadata]);

  const onPlayerPlaying = useCallback(() => {
    if (playingStartedAtRef.current == null) playingStartedAtRef.current = Date.now();
    hasPlayedRef.current = true;
    setLoadError(null);
  }, []);

  const onPlayerMediaFailure = useCallback(
    (event: PlayerEvent) => {
      if (event.kind !== "error" && event.kind !== "eof") return;
      if (metadataRenewalInFlightRef.current) return;
      const failureAt = Date.now();
      const activeLineIndex = lineIndexRef.current;
      if (isDuplicatePlaybackFailure(lastFailureRef.current, event, activeLineIndex, failureAt)) {
        return;
      }
      lastFailureRef.current = {
        epoch: event.epoch,
        generation: event.generation,
        lineIndex: activeLineIndex,
        at: failureAt,
      };
      clearFailoverTimer();

      if (playbackWasStable(playingStartedAtRef.current, failureAt)) {
        retryCountRef.current = 0;
        playUrlRenewalCountRef.current = 0;
        exhaustedLineIndicesRef.current.clear();
      }
      playingStartedAtRef.current = null;

      const message = event.message?.trim() ?? "";
      const isDecodeError = event.decodeError === true || isXgPlayerDecodeError(message);
      if (event.kind === "error" && siteId === "twitch" && isDecodeError) {
        const fallbackQualityIndex = nextTwitchDecodeQualityIndex(qualities, qualityIndex);
        if (fallbackQualityIndex != null) {
          retryCountRef.current = 0;
          playUrlRenewalCountRef.current = 0;
          exhaustedLineIndicesRef.current.clear();
          hasPlayedRef.current = false;
          lastFailureRef.current = null;
          setLoadError(null);
          setQualityIndex(fallbackQualityIndex);
          setLineIndex(0);
          return;
        }
        setLoadError("当前 Twitch 清晰度无法解码，请手动选择较低画质");
        return;
      }

      if (event.refreshPlayUrl) {
        if (metadataRenewalInFlightRef.current) return;
        if (playUrlRenewalCountRef.current >= MAX_PLAYBACK_METADATA_RENEWALS) {
          setLoadError("播放地址多次更新失败，请点击刷新后重试");
          return;
        }

        const renewalAttempt = ++playUrlRenewalCountRef.current;
        const requestedDelay =
          typeof event.retryAfterMs === "number" && Number.isFinite(event.retryAfterMs)
            ? Math.max(0, Math.min(event.retryAfterMs, 60_000))
            : 0;
        // Keep retries measured during a temporary platform interruption and
        // avoid a tight loop when a newly issued URL also fails immediately.
        const delayMs = Math.max(requestedDelay, (renewalAttempt - 1) * 1_000);
        metadataRenewalSequenceRef.current += 1;
        const renewalSequence = metadataRenewalSequenceRef.current;
        metadataRenewalInFlightRef.current = true;
        const renewPlayback = () => {
          failoverTimerRef.current = null;
          void refreshPlaybackMetadata(renewalSequence)
            .then((refreshed) => {
              if (!refreshed) return;
              setReloadToken((token) => token + 1);
            })
            .catch((error) => {
              if (metadataRenewalSequenceRef.current !== renewalSequence) return;
              setLoadError(playbackErrorMessage(error, "播放地址更新失败，请点击刷新后重试"));
            })
            .finally(() => {
              if (metadataRenewalSequenceRef.current === renewalSequence) {
                metadataRenewalInFlightRef.current = false;
              }
            });
        };

        if (delayMs > 0) {
          failoverTimerRef.current = window.setTimeout(renewPlayback, delayMs);
        } else {
          renewPlayback();
        }
        return;
      }

      const maxRetries = playerRebuildRetryLimit(siteId);
      let rankedReplacement: number | null | undefined;
      if (smartLineSelection && retryCountRef.current >= maxRetries) {
        exhaustedLineIndicesRef.current.add(lineIndexRef.current);
        rankedReplacement = nextRankedLineIndex({
          currentIndex: lineIndexRef.current,
          rankedIndices: rankedLineIndicesRef.current,
          exhaustedIndices: exhaustedLineIndicesRef.current,
        });
      }
      const action = nextFailoverAction({
        retryCount: retryCountRef.current,
        lineIndex: lineIndexRef.current,
        lineCount: lineCountRef.current,
        maxRetries,
        ...(smartLineSelection ? { nextLineIndex: rankedReplacement } : {}),
      });

      if (action.type === "fail") {
        setLoadError(message || action.message);
        return;
      }

      const apply = () => {
        retryCountRef.current = action.retryCount;
        playingStartedAtRef.current = null;
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
    [
      clearFailoverTimer,
      qualities,
      qualityIndex,
      refreshPlaybackMetadata,
      siteId,
      smartLineSelection,
    ],
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
    lineDiagnostics: resolvedLineDiagnostics,
    linesTesting,
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
