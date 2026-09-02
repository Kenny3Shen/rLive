import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { PlayerControls } from "@/shared/components/player/PlayerControls";
import { ErrorState } from "@/shared/components/ErrorState";
import { useCompactPlayerViewport } from "@/shared/hooks/usePlayerViewport";
import { useScreenWakeLock } from "@/shared/hooks/useScreenWakeLock";
import type { SiteId } from "@/shared/types/live";
import {
  createXgPlayer,
  getXgMpegtsCore,
  loadXgPlayerModules,
  xgPlayerErrorMessage,
  type XgPlaybackKind,
  type XgPlayerInstance,
} from "@/features/room/player/xgPlayer";
import { PlayerFullscreenHud, showPlayerFullscreenHud } from "@/features/room/PlayerFullscreenHud";
import {
  clampRecordingPlaybackTime,
  formatRecordingDuration,
  recordingEndedPlaybackTime,
  recordingSeekReached,
  recordingDanmakuUrl,
  type RecordingItem,
} from "./recording";
import { RecordedDanmakuCanvas } from "./RecordedDanmakuCanvas";
import { RecordingPlaybackSettings } from "./RecordingPlaybackSettings";
import { parseRecordedDanmakuSidecar, type RecordedDanmakuEntry } from "./recordedDanmaku";
import { useRecordingPlayerFullscreen } from "./useRecordingPlayerFullscreen";

function recordingPlaybackKind(protocol: RecordingItem["protocol"]): XgPlaybackKind {
  if (protocol === "hls") return "hls";
  if (protocol === "mpeg_ts") return "mpegts";
  if (protocol === "native") return "native";
  return "flv";
}

function finiteDuration(video: HTMLVideoElement): number {
  return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
}

function bufferedRangeEnd(video: HTMLVideoElement): number {
  let end = 0;
  for (let index = 0; index < video.buffered.length; index += 1) {
    end = Math.max(end, video.buffered.end(index));
  }
  return Number.isFinite(end) ? end : 0;
}

const RECORDING_SEEK_TIMEOUT_MS = 4_000;
const RECORDING_SEEK_TOLERANCE_SECONDS = 1.5;
const RECORDING_CONTROLS_HIDE_DELAY_MS = 2_600;
const RECORDING_SINGLE_CLICK_DELAY_MS = 220;
const RECORDING_MPEGTS_CONFIG = {
  enableWorker: false,
  enableStashBuffer: false,
  lazyLoad: true,
  autoCleanupSourceBuffer: false,
  seekType: "range",
  rangeLoadZeroStart: true,
  accurateSeek: false,
};

function isPlayerControlTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      'button, input, select, textarea, [role="button"], [role="slider"], [role="dialog"], [data-player-controls]',
    ),
  );
}

export function RecordingPlayer({
  item,
  url,
  fill = false,
}: {
  item: RecordingItem;
  url: string;
  fill?: boolean;
}) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerRef = useRef<XgPlayerInstance | null>(null);
  const volumeRef = useRef(80);
  const mutedRef = useRef(false);
  const previousVolumeRef = useRef(80);
  const playbackRateRef = useRef(1);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const hudRef = useRef<HTMLDivElement | null>(null);
  const controlsHideTimerRef = useRef<number | null>(null);
  const clickTimerRef = useRef<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(true);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(80);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedTime, setBufferedTime] = useState(0);
  const [danmakuEntries, setDanmakuEntries] = useState<RecordedDanmakuEntry[]>([]);
  const [danmakuVisible, setDanmakuVisible] = useState(true);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [overlayInteractionOpen, setOverlayInteractionOpen] = useState(false);
  const [playerRevision, setPlayerRevision] = useState(0);
  const sliderTargetRef = useRef<number | null>(null);
  const seekTargetRef = useRef<number | null>(null);
  const endedRef = useRef(false);
  const recoverySeekRef = useRef<number | null>(null);
  const seekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seekRequestRef = useRef(0);
  const playbackKind = recordingPlaybackKind(item.protocol);
  const recordedDuration = Math.max(0, item.duration_ms / 1000);
  const compact = useCompactPlayerViewport();
  const fullscreen = useRecordingPlayerFullscreen(stageRef);
  playbackRateRef.current = playbackRate;
  useScreenWakeLock(!paused && !loading && !error);

  const danmakuUrlQuery = useQuery({
    queryKey: ["recording-danmaku", item.id],
    enabled: Boolean(item.include_danmaku),
    queryFn: () => recordingDanmakuUrl(item.id),
    staleTime: Number.POSITIVE_INFINITY,
  });

  useEffect(() => {
    playbackRateRef.current = 1;
    setPlaybackRate(1);
    setDanmakuVisible(true);
  }, [item.id]);

  useEffect(() => {
    const url = danmakuUrlQuery.data;
    if (!item.include_danmaku || !url) {
      setDanmakuEntries([]);
      return;
    }
    const controller = new AbortController();
    void fetch(url, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("弹幕轨读取失败");
        return response.text();
      })
      .then((text) => {
        if (!controller.signal.aborted) setDanmakuEntries(parseRecordedDanmakuSidecar(text));
      })
      .catch(() => {
        if (!controller.signal.aborted) setDanmakuEntries([]);
      });
    return () => controller.abort();
  }, [danmakuUrlQuery.data, item.include_danmaku]);

  const clearSeekTimer = useCallback(() => {
    if (seekTimerRef.current !== null) {
      clearTimeout(seekTimerRef.current);
      seekTimerRef.current = null;
    }
  }, []);

  const completeSeek = useCallback(() => {
    seekTargetRef.current = null;
    clearSeekTimer();
    setWaiting(false);
  }, [clearSeekTimer]);

  const seekTo = useCallback(
    (requestedTarget: number, allowRecovery = true) => {
      const media = videoRef.current;
      if (!media || !Number.isFinite(requestedTarget)) return;

      const availableDuration = recordedDuration > 0 ? recordedDuration : duration;
      const target = Math.max(
        0,
        Math.min(requestedTarget, availableDuration > 0 ? availableDuration : requestedTarget),
      );
      const request = ++seekRequestRef.current;
      endedRef.current = false;
      sliderTargetRef.current = null;
      seekTargetRef.current = target;
      clearSeekTimer();
      setCurrentTime(target);
      setError(null);
      setWaiting(true);

      // 进度条可能在 mpegts.js 挂载 seek 处理器之前就被使用。
      // 保留该目标直到协议播放器就绪。
      if (!playerRef.current && playbackKind !== "native") {
        recoverySeekRef.current = target;
        return;
      }

      try {
        const protocolSeek =
          playbackKind === "flv" || playbackKind === "mpegts"
            ? getXgMpegtsCore(playerRef.current!)?.seek?.(target)
            : false;
        if (!protocolSeek) media.currentTime = target;
      } catch {
        seekTargetRef.current = null;
        setWaiting(false);
        setError("跳转失败，请重试");
        return;
      }

      seekTimerRef.current = setTimeout(() => {
        if (seekRequestRef.current !== request) return;
        const failedTarget = seekTargetRef.current;
        seekTargetRef.current = null;
        seekTimerRef.current = null;
        setWaiting(false);
        if (allowRecovery && failedTarget !== null && playbackKind !== "native") {
          recoverySeekRef.current = failedTarget;
          setLoading(true);
          setPlayerRevision((revision) => revision + 1);
        } else {
          setError("跳转失败，请重试");
        }
      }, RECORDING_SEEK_TIMEOUT_MS);
    },
    [clearSeekTimer, duration, playbackKind, recordedDuration],
  );

  const seekToRef = useRef(seekTo);
  seekToRef.current = seekTo;

  useEffect(() => {
    let cancelled = false;
    const video = videoRef.current;
    const root = rootRef.current;
    if (!video || !root) return;
    const media = video;

    setLoading(true);
    setWaiting(false);
    setError(null);
    setPaused(true);
    setCurrentTime(0);
    setDuration(recordedDuration);
    setBufferedTime(0);
    endedRef.current = false;
    const kind = playbackKind;

    function syncTime() {
      if (cancelled) return;
      const actualTime = Number.isFinite(media.currentTime) ? Math.max(0, media.currentTime) : 0;
      // 录制元数据具有权威性。FLV MediaSource 在重建缓冲期间可能短暂暴露 0 或 1 秒
      // 的时长。
      const nextDuration = recordedDuration > 0 ? recordedDuration : finiteDuration(media);
      setCurrentTime((previousTime) =>
        clampRecordingPlaybackTime(
          sliderTargetRef.current !== null || endedRef.current ? previousTime : actualTime,
          nextDuration,
        ),
      );
      setDuration((previousDuration) =>
        endedRef.current && nextDuration <= 0 ? previousDuration : nextDuration,
      );
      const target = seekTargetRef.current;
      if (
        target !== null &&
        recordingSeekReached(
          actualTime,
          target,
          nextDuration,
          media.ended,
          RECORDING_SEEK_TOLERANCE_SECONDS,
        )
      ) {
        completeSeek();
      }
    }
    function syncBufferedTime() {
      if (cancelled) return;
      setBufferedTime(
        clampRecordingPlaybackTime(
          bufferedRangeEnd(media),
          recordedDuration || finiteDuration(media),
        ),
      );
    }
    function onPlay() {
      if (cancelled) return;
      endedRef.current = false;
      setPaused(false);
      setWaiting(false);
      setLoading(false);
    }
    function onPause() {
      if (cancelled) return;
      setPaused(true);
    }
    function onReady() {
      if (cancelled) return;
      media.playbackRate = playbackRateRef.current;
      setLoading(false);
      if (seekTargetRef.current === null) setWaiting(false);
      syncTime();
      syncBufferedTime();
      const pendingTarget = recoverySeekRef.current;
      if (pendingTarget !== null) {
        recoverySeekRef.current = null;
        setTimeout(() => {
          if (!cancelled) seekToRef.current(pendingTarget, false);
        }, 0);
      }
    }
    function onWaiting() {
      if (cancelled || endedRef.current || media.ended) return;
      setWaiting(true);
    }
    function onEnded() {
      // 排队中的 `ended` 事件可能在重播或 seek 已经清除媒体终态之后才到达。
      // 忽略那个过期事件。
      if (cancelled || !media.ended) return;
      const endDuration =
        recordedDuration > 0
          ? recordedDuration
          : finiteDuration(media) || clampRecordingPlaybackTime(media.currentTime, 0);
      const endedTime = recordingEndedPlaybackTime(
        media.currentTime,
        endDuration,
        RECORDING_SEEK_TOLERANCE_SECONDS,
      );
      const target = seekTargetRef.current;
      // 非终态 seek 尚未到达目标时报告的媒体空洞，
      // 继续沿用现有的 seek 超时/重建路径。
      if (
        target !== null &&
        !recordingSeekReached(
          media.currentTime,
          target,
          endDuration,
          true,
          RECORDING_SEEK_TOLERANCE_SECONDS,
        )
      ) {
        return;
      }
      endedRef.current = true;
      setDuration(endDuration);
      setCurrentTime(endedTime);
      setPaused(true);
      if (seekTargetRef.current === null) setWaiting(false);
      else completeSeek();
    }
    function onSeeking() {
      if (cancelled) return;
      if (seekTargetRef.current !== null) setWaiting(true);
    }
    function onSeeked() {
      if (!cancelled && seekTargetRef.current !== null) syncTime();
    }
    function onNativeError() {
      if (cancelled) return;
      if (!media.error) return;
      seekTargetRef.current = null;
      clearSeekTimer();
      setError(media.error.message || "录制回放失败");
      setLoading(false);
      setWaiting(false);
    }

    video.volume = volumeRef.current / 100;
    video.muted = mutedRef.current;
    video.playbackRate = playbackRateRef.current;
    video.addEventListener("timeupdate", syncTime);
    video.addEventListener("durationchange", syncTime);
    video.addEventListener("progress", syncBufferedTime);
    video.addEventListener("loadedmetadata", onReady);
    video.addEventListener("canplay", onReady);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("ended", onEnded);
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onNativeError);

    void loadXgPlayerModules(kind)
      .then((modules) => {
        if (cancelled) return;
        const player = createXgPlayer(modules, {
          root,
          video,
          url,
          kind,
          isLive: false,
          hls: {
            hlsOpts: {
              lowLatencyMode: false,
              backBufferLength: 90,
              maxBufferLength: 90,
              manifestLoadingMaxRetry: 2,
              levelLoadingMaxRetry: 2,
              fragLoadingMaxRetry: 2,
            },
          },
          flv: {
            mediaDataSource: {
              type: "flv",
              isLive: false,
              hasAudio: true,
              hasVideo: true,
              duration: item.duration_ms || undefined,
            },
            mpegtsConfig: {
              ...RECORDING_MPEGTS_CONFIG,
            },
          },
          mpegts: {
            mediaDataSource: {
              type: "mpegts",
              isLive: false,
              hasAudio: true,
              hasVideo: true,
              duration: item.duration_ms || undefined,
            },
            mpegtsConfig: {
              ...RECORDING_MPEGTS_CONFIG,
            },
          },
        });
        playerRef.current = player;
        player.on("error", (cause) => {
          if (cancelled) return;
          seekTargetRef.current = null;
          clearSeekTimer();
          setError(xgPlayerErrorMessage(cause, "录制回放失败"));
          setLoading(false);
          setWaiting(false);
        });
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(xgPlayerErrorMessage(cause, "无法初始化录制播放器"));
        setLoading(false);
      });

    return () => {
      cancelled = true;
      video.removeEventListener("timeupdate", syncTime);
      video.removeEventListener("durationchange", syncTime);
      video.removeEventListener("progress", syncBufferedTime);
      video.removeEventListener("loadedmetadata", onReady);
      video.removeEventListener("canplay", onReady);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onNativeError);
      seekRequestRef.current += 1;
      clearSeekTimer();
      seekTargetRef.current = null;
      sliderTargetRef.current = null;
      endedRef.current = false;
      const player = playerRef.current;
      playerRef.current = null;
      try {
        player?.pause();
        player?.destroy();
      } catch {
        // 协议插件可能已经释放了它的 MediaSource。
      }
    };
  }, [
    clearSeekTimer,
    completeSeek,
    item.duration_ms,
    item.id,
    playbackKind,
    playerRevision,
    recordedDuration,
    url,
  ]);

  useEffect(() => {
    const video = videoRef.current;
    if (video) video.playbackRate = playbackRate;
  }, [playbackRate]);

  const togglePlayback = useCallback(() => {
    const player = playerRef.current;
    const video = videoRef.current;
    if (!player || !video) return;
    if (video.paused) {
      void Promise.resolve(player.play()).catch((cause) => {
        setError(xgPlayerErrorMessage(cause, "播放录制失败"));
      });
    } else {
      player.pause();
    }
  }, []);

  const setPlayerVolume = useCallback((nextVolume: number) => {
    const video = videoRef.current;
    const clamped = Math.max(0, Math.min(100, nextVolume));
    volumeRef.current = clamped;
    mutedRef.current = clamped === 0;
    if (clamped > 0) previousVolumeRef.current = clamped;
    setVolume(clamped);
    setMuted(clamped === 0);
    if (video) {
      video.volume = clamped / 100;
      video.muted = clamped === 0;
    }
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (mutedRef.current || volumeRef.current === 0) {
      const restoredVolume = previousVolumeRef.current || 80;
      volumeRef.current = restoredVolume;
      mutedRef.current = false;
      setVolume(restoredVolume);
      setMuted(false);
      if (video) {
        video.volume = restoredVolume / 100;
        video.muted = false;
      }
      return;
    }

    previousVolumeRef.current = volumeRef.current;
    mutedRef.current = true;
    setMuted(true);
    if (video) video.muted = true;
  }, []);

  const changePlaybackRate = useCallback((nextRate: number) => {
    if (!Number.isFinite(nextRate) || nextRate <= 0) return;
    playbackRateRef.current = nextRate;
    setPlaybackRate(nextRate);
    if (videoRef.current) videoRef.current.playbackRate = nextRate;
  }, []);

  const retryPlayback = useCallback(() => {
    const target = clampRecordingPlaybackTime(currentTime, duration || recordedDuration);
    recoverySeekRef.current = target;
    setError(null);
    setWaiting(false);
    setLoading(true);
    setPlayerRevision((revision) => revision + 1);
  }, [currentTime, duration, recordedDuration]);

  const clearControlsHideTimer = useCallback(() => {
    if (controlsHideTimerRef.current === null) return;
    window.clearTimeout(controlsHideTimerRef.current);
    controlsHideTimerRef.current = null;
  }, []);

  const setChromeVisible = useCallback((visible: boolean) => {
    const value = visible ? "true" : "false";
    for (const layer of [controlsRef.current, hudRef.current]) {
      if (!layer) continue;
      layer.dataset.visible = value;
      layer.setAttribute("aria-hidden", String(!visible));
    }
  }, []);

  const scheduleControlsHide = useCallback(() => {
    clearControlsHideTimer();
    if (paused || loading || error || overlayInteractionOpen) {
      setChromeVisible(true);
      return;
    }
    controlsHideTimerRef.current = window.setTimeout(() => {
      controlsHideTimerRef.current = null;
      setChromeVisible(false);
    }, RECORDING_CONTROLS_HIDE_DELAY_MS);
  }, [clearControlsHideTimer, error, loading, overlayInteractionOpen, paused, setChromeVisible]);

  const revealControls = useCallback(() => {
    setChromeVisible(true);
    scheduleControlsHide();
  }, [scheduleControlsHide, setChromeVisible]);

  const holdControlsVisible = useCallback(() => {
    clearControlsHideTimer();
    setChromeVisible(true);
  }, [clearControlsHideTimer, setChromeVisible]);

  const handleStagePointerActivity = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (isPlayerControlTarget(event.target)) holdControlsVisible();
      else revealControls();
    },
    [holdControlsVisible, revealControls],
  );

  useEffect(() => {
    revealControls();
  }, [fullscreen.fullscreen, revealControls]);

  useEffect(
    () => () => {
      clearControlsHideTimer();
      if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
    },
    [clearControlsHideTimer],
  );

  const handleSurfaceClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.detail !== 1 || isPlayerControlTarget(event.target)) return;
      if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = window.setTimeout(() => {
        clickTimerRef.current = null;
        togglePlayback();
      }, RECORDING_SINGLE_CLICK_DELAY_MS);
    },
    [togglePlayback],
  );

  const handleSurfaceDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (isPlayerControlTarget(event.target)) return;
      if (clickTimerRef.current !== null) {
        window.clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }
      void fullscreen.toggle();
    },
    [fullscreen],
  );

  const handleStageKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (isPlayerControlTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === " " || key === "k") {
        event.preventDefault();
        togglePlayback();
      } else if (key === "m") {
        event.preventDefault();
        toggleMute();
      } else if (key === "f" && !event.repeat) {
        event.preventDefault();
        void fullscreen.toggle();
      } else if (key === "arrowleft") {
        event.preventDefault();
        seekTo(currentTime - 5);
      } else if (key === "arrowright") {
        event.preventDefault();
        seekTo(currentTime + 5);
      } else {
        return;
      }
      revealControls();
    },
    [currentTime, fullscreen, revealControls, seekTo, toggleMute, togglePlayback],
  );

  const timeline = (
    <div className="flex min-w-0 items-center gap-2 py-0.5 text-white/85">
      <Slider
        value={currentTime}
        min={0}
        max={duration || 1}
        step={0.1}
        variant="player"
        buffered={duration > 0 ? (bufferedTime / duration) * 100 : 0}
        disabled={!duration}
        aria-label="播放进度"
        aria-valuetext={`${formatRecordingDuration(currentTime * 1_000)} / ${formatRecordingDuration(duration * 1_000)}`}
        className="min-w-0 flex-1"
        onValueChange={(value) => {
          const next = Number(Array.isArray(value) ? value[0] : value);
          if (!Number.isFinite(next)) return;
          sliderTargetRef.current = next;
          setCurrentTime(next);
        }}
        onValueCommitted={(value) => {
          const next = Number(Array.isArray(value) ? value[0] : value);
          if (Number.isFinite(next)) seekTo(next);
        }}
      />
      <span className="shrink-0 font-mono text-[11px] tabular-nums text-white/80">
        {formatRecordingDuration(currentTime * 1_000)}
        <span className="px-1 text-white/45" aria-hidden>
          /
        </span>
        {formatRecordingDuration(duration * 1_000)}
      </span>
    </div>
  );

  const showFullscreenHud = showPlayerFullscreenHud({
    fullscreen: fullscreen.fullscreen,
    hasRoomIdentity: Boolean(item.title.trim() || item.user_name.trim()),
    hasActions: false,
  });

  return (
    <section
      ref={stageRef}
      data-player-stage
      data-recording-player
      data-fullscreen={fullscreen.fullscreen && fullscreen.nativeLayer ? "true" : undefined}
      className={cn(
        "relative flex min-w-0 flex-col overflow-hidden bg-black data-[fullscreen=true]:rounded-none data-[fullscreen=true]:border-0",
        fill
          ? "size-full min-h-0 rounded-none border-0 shadow-none"
          : "aspect-video rounded-xl border border-border-subtle shadow-sm",
      )}
      aria-label={`${item.title} 录制回放；按空格或 K 播放或暂停，左右方向键快退或快进，M 静音，F 全屏`}
      aria-keyshortcuts="Space K ArrowLeft ArrowRight M F"
      onPointerEnter={handleStagePointerActivity}
      onPointerMove={handleStagePointerActivity}
      onPointerLeave={scheduleControlsHide}
      onKeyDown={handleStageKeyDown}
      tabIndex={0}
    >
      <div
        data-player-video-surface
        className="relative min-h-0 flex-1 overflow-hidden bg-black"
        onClick={handleSurfaceClick}
        onDoubleClick={handleSurfaceDoubleClick}
      >
        <div
          ref={rootRef}
          data-player-engine-root
          className="absolute inset-0 size-full overflow-hidden bg-black"
        >
          <video
            ref={videoRef}
            data-player-video
            playsInline
            preload="metadata"
            controls={false}
            className="absolute inset-0 size-full bg-black object-contain"
          />
        </div>
        {danmakuEntries.length > 0 && (
          <RecordedDanmakuCanvas
            videoRef={videoRef}
            entries={danmakuEntries}
            active={danmakuVisible}
          />
        )}
        {(loading || waiting) && !error && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-black/25">
            <Spinner className="text-white" aria-label={loading ? "正在加载录制" : "正在缓冲"} />
          </div>
        )}
        {error && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/65 p-6">
            <ErrorState
              error={error}
              title="录制回放失败"
              onRetry={retryPlayback}
              className="w-full max-w-md bg-card shadow-2xl shadow-black/50"
            />
          </div>
        )}
      </div>

      {showFullscreenHud && (
        <div
          ref={hudRef}
          data-player-hud
          data-visible="true"
          aria-hidden="false"
          className="absolute inset-x-0 top-0 z-30 transition-opacity duration-150 ease-out motion-reduced:transition-none data-[visible=false]:pointer-events-none data-[visible=false]:opacity-0"
          onPointerEnter={holdControlsVisible}
          onPointerLeave={scheduleControlsHide}
          onFocusCapture={holdControlsVisible}
          onBlurCapture={scheduleControlsHide}
        >
          <PlayerFullscreenHud
            onBack={() => void fullscreen.exit()}
            siteId={(item.site_id as SiteId | null) ?? undefined}
            roomId={item.room_id ?? undefined}
            roomTitle={item.title}
            roomUserName={item.user_name || "本地录制"}
            compact={compact}
            portalContainer={stageRef}
            onExitFullscreen={fullscreen.exit}
          />
        </div>
      )}

      <div
        ref={controlsRef}
        data-player-controls
        data-visible="true"
        aria-hidden="false"
        className="absolute inset-x-0 bottom-0 z-30 transition-opacity duration-150 ease-out motion-reduced:transition-none data-[visible=false]:pointer-events-none data-[visible=false]:opacity-0"
        onPointerEnter={holdControlsVisible}
        onPointerLeave={scheduleControlsHide}
        onFocusCapture={holdControlsVisible}
        onBlurCapture={scheduleControlsHide}
      >
        <PlayerControls
          paused={paused}
          volume={volume}
          muted={muted}
          osdOn={danmakuVisible}
          fullscreen={fullscreen.fullscreen}
          disabled={loading}
          refreshDisabled={loading}
          loadError={fullscreen.error}
          stackedBelowPlayer={fill ? compact : true}
          compact={compact}
          portalContainer={stageRef}
          timeline={timeline}
          playbackSettingsTitle="回放设置"
          playbackSettingsLabel="回放设置"
          playbackSettingsDisabled={false}
          playbackSettings={
            <RecordingPlaybackSettings
              playbackRate={playbackRate}
              onPlaybackRateChange={changePlaybackRate}
              hasDanmaku={Boolean(item.include_danmaku)}
            />
          }
          onOverlayInteractionChange={setOverlayInteractionOpen}
          onRefresh={retryPlayback}
          onTogglePause={togglePlayback}
          onVolume={setPlayerVolume}
          onToggleMute={toggleMute}
          onToggleOsd={
            item.include_danmaku && danmakuUrlQuery.data
              ? () => setDanmakuVisible((visible) => !visible)
              : undefined
          }
          onToggleFullscreen={() => void fullscreen.toggle()}
        />
      </div>
    </section>
  );
}
