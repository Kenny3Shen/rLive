import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
const MAX_TWITCH_PLAY_URL_RENEWALS = 3;

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
  const smartLineSelection = useSettingsStore((s) => s.playbackSmartLineSelection);

  const [qualityIndex, setQualityIndex] = useState(0);
  const [lineIndex, setLineIndex] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [sourceProbes, setSourceProbes] = useState<PlaybackSourceProbe[]>([]);
  const [linesTesting, setLinesTesting] = useState(false);
  const retryCountRef = useRef(0);
  const twitchPlayUrlRenewalCountRef = useRef(0);
  const failoverTimerRef = useRef<number | null>(null);
  const appliedQualitiesKeyRef = useRef<string | null>(null);
  const lineIndexRef = useRef(0);
  const lineCountRef = useRef(0);
  const rankedLineIndicesRef = useRef<number[]>([]);
  const exhaustedLineIndicesRef = useRef(new Set<number>());
  const hasPlayedRef = useRef(false);

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
    twitchPlayUrlRenewalCountRef.current = 0;
    exhaustedLineIndicesRef.current.clear();
    rankedLineIndicesRef.current = [];
    hasPlayedRef.current = false;
    setSourceProbes([]);
    setLinesTesting(false);
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
    twitchPlayUrlRenewalCountRef.current = 0;
    setLoadError(null);
  }, [qualitiesKey, qualities.length, qualityLevel]);

  const selectedQuality: LivePlayQuality | null = useMemo(() => {
    if (qualities.length === 0) return null;
    return qualities[clampIndex(qualityIndex, qualities.length)] ?? null;
  }, [qualities, qualityIndex]);

  useEffect(() => {
    setLineIndex(0);
    retryCountRef.current = 0;
    twitchPlayUrlRenewalCountRef.current = 0;
    exhaustedLineIndicesRef.current.clear();
    hasPlayedRef.current = false;
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
          twitchPlayUrlRenewalCountRef.current = 0;
          exhaustedLineIndicesRef.current.clear();
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
      retryCountRef.current = 0;
      twitchPlayUrlRenewalCountRef.current = 0;
      exhaustedLineIndicesRef.current.clear();
      hasPlayedRef.current = false;
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
      twitchPlayUrlRenewalCountRef.current = 0;
      exhaustedLineIndicesRef.current.clear();
      hasPlayedRef.current = false;
      setLoadError(null);
      setLineIndex(index);
    },
    [clearFailoverTimer],
  );

  const retryPlay = useCallback(() => {
    clearFailoverTimer();
    retryCountRef.current = 0;
    twitchPlayUrlRenewalCountRef.current = 0;
    exhaustedLineIndicesRef.current.clear();
    hasPlayedRef.current = false;
    setLoadError(null);
    // A metadata refetch alone does not recreate an already-attached MSE
    // player when the CDN returns the same URL. Bump the session token first
    // so the refresh control always rebuilds the active playback pipeline.
    setReloadToken((token) => token + 1);
    void qualitiesQuery.refetch().then(() => playUrlQuery.refetch());
  }, [clearFailoverTimer, qualitiesQuery, playUrlQuery]);

  const onPlayerPlaying = useCallback(() => {
    retryCountRef.current = 0;
    twitchPlayUrlRenewalCountRef.current = 0;
    exhaustedLineIndicesRef.current.clear();
    hasPlayedRef.current = true;
    setLoadError(null);
  }, []);

  const onPlayerMediaFailure = useCallback(
    (event: PlayerEvent) => {
      if (event.kind !== "error" && event.kind !== "eof") return;
      clearFailoverTimer();

      const message = event.message?.trim() ?? "";
      const isDecodeError = event.decodeError === true || isXgPlayerDecodeError(message);
      if (event.kind === "error" && siteId === "twitch" && isDecodeError) {
        const fallbackQualityIndex = nextTwitchDecodeQualityIndex(qualities, qualityIndex);
        if (fallbackQualityIndex != null) {
          retryCountRef.current = 0;
          twitchPlayUrlRenewalCountRef.current = 0;
          exhaustedLineIndicesRef.current.clear();
          hasPlayedRef.current = false;
          setLoadError(null);
          setQualityIndex(fallbackQualityIndex);
          setLineIndex(0);
          return;
        }
        setLoadError("当前 Twitch 清晰度无法解码，请手动选择较低画质");
        return;
      }

      if (event.refreshPlayUrl && siteId === "twitch") {
        if (twitchPlayUrlRenewalCountRef.current >= MAX_TWITCH_PLAY_URL_RENEWALS) {
          setLoadError("Twitch 播放地址多次更新失败，请点击刷新后重试");
          return;
        }

        const renewalAttempt = ++twitchPlayUrlRenewalCountRef.current;
        const requestedDelay =
          typeof event.retryAfterMs === "number" && Number.isFinite(event.retryAfterMs)
            ? Math.max(0, Math.min(event.retryAfterMs, 60_000))
            : 0;
        // Keep retries measured when Twitch is changing a playlist during a
        // normal commercial break, while avoiding a tight token-refresh loop.
        const delayMs = Math.max(requestedDelay, (renewalAttempt - 1) * 1_000);
        const renewPlayUrl = () => {
          failoverTimerRef.current = null;
          void playUrlQuery.refetch().then((result) => {
            if (result.isError) {
              const message =
                result.error && typeof result.error === "object" && "message" in result.error
                  ? String(result.error.message)
                  : "Twitch 播放地址更新失败，请点击刷新后重试";
              setLoadError(message);
              return;
            }
            // The newly issued Twitch URL normally changes the stream key.
            // Bump the token as well for the rare case where it is identical,
            // so a stuck HLS instance is still replaced.
            setReloadToken((token) => token + 1);
          });
        };

        if (delayMs > 0) {
          failoverTimerRef.current = window.setTimeout(renewPlayUrl, delayMs);
        } else {
          renewPlayUrl();
        }
        return;
      }

      let rankedReplacement: number | null | undefined;
      if (smartLineSelection && retryCountRef.current >= 2) {
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
        ...(smartLineSelection ? { nextLineIndex: rankedReplacement } : {}),
      });

      if (action.type === "fail") {
        setLoadError(message || action.message);
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
    [clearFailoverTimer, playUrlQuery, qualities, qualityIndex, siteId, smartLineSelection],
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
