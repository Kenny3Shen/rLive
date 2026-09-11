import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type Mpegts from "mpegts.js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import { PlayerControls } from "@/shared/components/player/PlayerControls";
import { ErrorState } from "@/shared/components/ErrorState";
import { useCompactPlayerViewport } from "@/shared/hooks/usePlayerViewport";
import { usePlayerStageTapGestures } from "@/shared/hooks/usePlayerStageTapGestures";
import { useScreenWakeLock } from "@/shared/hooks/useScreenWakeLock";
import {
  DEFAULT_PLAYER_VOLUME,
  readPlayerVolume,
  rememberPlayerVolume,
} from "@/shared/playerVolume";
import type { SiteId } from "@/shared/types/live";
import {
  createVideoJsPlayer,
  getVideoJsMpegtsCore,
  isInterruptedPlayRequest,
  loadVideoJsModules,
  videoJsPlayerErrorMessage,
  type VideoJsPlaybackKind,
  type VideoJsPlayerInstance,
} from "@/features/room/player/videoJsPlayer";
import {
  VideoJsContainer,
  VideoJsPlayerProvider,
  VideoJsVideo,
} from "@/features/room/player/videoJsControls";
import { PlayerFullscreenHud, showPlayerFullscreenHud } from "@/features/room/PlayerFullscreenHud";
import {
  isWatchProgressWorthKeeping,
  shouldReportWatchProgress,
  watchResumePosition,
} from "@/shared/watchProgress";
import {
  clampRecordingPlaybackTime,
  recordingDanmakuUrl,
  recordingEndedPlaybackTime,
  recordingSeekReached,
  recordingWatchProgressFind,
  recordingWatchProgressReport,
  RECORDING_WATCH_PROGRESS_QUERY_KEY,
  RECORDING_WATCH_PROGRESS_RESUME_KEY,
  type RecordingItem,
} from "./recording";
import { RecordedDanmakuCanvas } from "./RecordedDanmakuCanvas";
import { RecordingPlaybackSettings } from "./RecordingPlaybackSettings";
import { parseRecordedDanmakuSidecar, type RecordedDanmakuEntry } from "./recordedDanmaku";
import { useRecordingPlayerFullscreen } from "./useRecordingPlayerFullscreen";

function recordingPlaybackKind(protocol: RecordingItem["protocol"]): VideoJsPlaybackKind {
  if (protocol === "hls") return "hls";
  if (protocol === "mpeg_ts") return "mpegts";
  if (protocol === "native") return "native";
  return "flv";
}

function finiteDuration(video: HTMLVideoElement): number {
  return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
}

const RECORDING_SEEK_TIMEOUT_MS = 4_000;
const RECORDING_SEEK_TOLERANCE_SECONDS = 1.5;
/** 派生空轨的稳定身份，避免每帧新数组使弹幕画布失效。 */
const EMPTY_DANMAKU: RecordedDanmakuEntry[] = [];
const RECORDING_CONTROLS_HIDE_DELAY_MS = 2_000;
const RECORDING_MPEGTS_CONFIG: Mpegts.Config = {
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

type RecordingPlayerProps = {
  item: RecordingItem;
  url: string;
  fill?: boolean;
};

export function RecordingPlayer(props: RecordingPlayerProps) {
  return (
    <VideoJsPlayerProvider key={props.item.id}>
      <RecordingPlayerContent {...props} />
    </VideoJsPlayerProvider>
  );
}

function RecordingPlayerContent({ item, url, fill = false }: RecordingPlayerProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerRef = useRef<VideoJsPlayerInstance | null>(null);
  const [initialAudio] = useState(readPlayerVolume);
  const volumeRef = useRef(initialAudio.volume);
  const mutedRef = useRef(initialAudio.muted);
  const previousVolumeRef = useRef(initialAudio.volume);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const hudRef = useRef<HTMLDivElement | null>(null);
  const controlsHideTimerRef = useRef<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(true);
  const [muted, setMuted] = useState(initialAudio.muted);
  const [volume, setVolume] = useState(initialAudio.volume);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [danmakuVisible, setDanmakuVisible] = useState(true);
  const [overlayInteractionOpen, setOverlayInteractionOpen] = useState(false);
  const [playerRevision, setPlayerRevision] = useState(0);
  const seekTargetRef = useRef<number | null>(null);
  const endedRef = useRef(false);
  const recoverySeekRef = useRef<number | null>(null);
  const seekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seekRequestRef = useRef(0);
  const playbackKind = recordingPlaybackKind(item.protocol);
  const recordedDuration = Math.max(0, item.duration_ms / 1000);
  const compact = useCompactPlayerViewport();
  const fullscreen = useRecordingPlayerFullscreen(stageRef);
  useScreenWakeLock(!paused && !loading && !error);

  const danmakuUrlQuery = useQuery({
    queryKey: ["recording-danmaku", item.id],
    enabled: Boolean(item.include_danmaku),
    queryFn: () => recordingDanmakuUrl(item.id),
    staleTime: Number.POSITIVE_INFINITY,
  });

  const queryClient = useQueryClient();
  /**
   * 这段录制上次看到第几秒。本地 SQLite 查询，通常早于播放地址（IPC + 文件探测）
   * 就位；未落定时不建播放器（见下方主 effect），避免先从 0 播再跳的闪帧。
   */
  const resumeQuery = useQuery({
    queryKey: [RECORDING_WATCH_PROGRESS_RESUME_KEY, item.id],
    queryFn: () => recordingWatchProgressFind(item.id),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
  const resumePending = resumeQuery.isPending;
  /**
   * 续播位置经渲染期 ref 供给播放器 effect：写进依赖会让上报后的缓存变化重建
   * 播放器，回放于是从头开始。录制元数据的时长权威（见 `recordedDuration`），
   * 用它判断「是否已看完」而不是历史里记下的那份。
   */
  const resumeAtRef = useRef(0);
  // latest-ref：提交后同步，主播放器 effect（useEffect）总在其后运行，读到最新值。
  useLayoutEffect(() => {
    resumeAtRef.current = watchResumePosition(resumeQuery.data?.progress ?? 0, recordedDuration);
  });
  /** 已注入过续播位置的录制 id：同一段录制只跳一次。 */
  const resumeAppliedRef = useRef<string | null>(null);
  const reportedAtRef = useRef<number | null>(null);

  /**
   * 把当前位置写进 `recording_watch_progress`。
   *
   * `force` 用于暂停/播完/离开这三个「最后一次」的时机，绕过节流窗口。
   * 失败只吞掉——进度是本地记账，不该让它的故障打断回放。
   */
  const reportWatchProgress = useCallback(
    (position: number, force: boolean) => {
      const now = Date.now();
      if (force) {
        if (!isWatchProgressWorthKeeping(position)) return;
      } else if (!shouldReportWatchProgress(position, reportedAtRef.current, now)) {
        return;
      }
      reportedAtRef.current = now;
      void recordingWatchProgressReport({
        id: item.id,
        progress: position,
        duration: recordedDuration,
        watched_at: now,
      })
        .then(() => queryClient.invalidateQueries({ queryKey: RECORDING_WATCH_PROGRESS_QUERY_KEY }))
        .catch(() => undefined);
    },
    [item.id, queryClient, recordedDuration],
  );

  // 换一段录制时重置弹幕显示；Video.js Provider 以 item.id 为 key，倍速随播放器重置。
  const [prevItemId, setPrevItemId] = useState(item.id);
  if (item.id !== prevItemId) {
    setPrevItemId(item.id);
    setDanmakuVisible(true);
  }

  const danmakuUrl = danmakuUrlQuery.data;
  const danmakuEntriesQuery = useQuery({
    queryKey: ["recording-danmaku-entries", item.id, danmakuUrl ?? ""],
    enabled: Boolean(item.include_danmaku && danmakuUrl),
    queryFn: async ({ signal }) => {
      const response = await fetch(danmakuUrl!, { signal });
      if (!response.ok) throw new Error("弹幕轨读取失败");
      return parseRecordedDanmakuSidecar(await response.text());
    },
    gcTime: 0,
    retry: false,
  });
  const danmakuEntries =
    item.include_danmaku && danmakuUrl && !danmakuEntriesQuery.isError
      ? (danmakuEntriesQuery.data ?? EMPTY_DANMAKU)
      : EMPTY_DANMAKU;

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
            ? getVideoJsMpegtsCore(playerRef.current!)?.seek?.(target)
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
  // latest-ref：提交后同步，读者在效果/定时器里。
  useLayoutEffect(() => {
    seekToRef.current = seekTo;
  });

  useEffect(() => {
    if (resumePending) return;
    let cancelled = false;
    const video = videoRef.current;
    if (!video) return;
    const media = video;
    // 节流窗口按播放器实例重置：重建后的第一笔进度应当立刻落盘。
    reportedAtRef.current = null;
    // 续播只在这段录制第一次建播放器时注入。seek 失败重建与错误重试都走
    // recoverySeekRef，不能再把用户拉回上次退出的位置。
    if (resumeAppliedRef.current !== item.id) {
      resumeAppliedRef.current = item.id;
      if (resumeAtRef.current > 0) recoverySeekRef.current = resumeAtRef.current;
    }

    setLoading(true);
    setWaiting(false);
    setError(null);
    setPaused(true);
    setCurrentTime(0);
    setDuration(recordedDuration);
    endedRef.current = false;
    const kind = playbackKind;

    function syncTime() {
      if (cancelled) return;
      const actualTime = Number.isFinite(media.currentTime) ? Math.max(0, media.currentTime) : 0;
      // 录制元数据具有权威性。FLV MediaSource 在重建缓冲期间可能短暂暴露 0 或 1 秒
      // 的时长。
      const nextDuration = recordedDuration > 0 ? recordedDuration : finiteDuration(media);
      setCurrentTime(clampRecordingPlaybackTime(actualTime, nextDuration));
      setDuration((previousDuration) =>
        endedRef.current && nextDuration <= 0 ? previousDuration : nextDuration,
      );
      reportWatchProgress(actualTime, false);
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
      reportWatchProgress(clampRecordingPlaybackTime(media.currentTime, recordedDuration), true);
    }
    function onReady() {
      if (cancelled) return;
      setLoading(false);
      if (seekTargetRef.current === null) setWaiting(false);
      syncTime();
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
      // 记满时长而不是媒体真正停下的位置：被打断的录制可能比元数据短，
      // 记实际停止点会让下次进来又跳到尾部立刻结束，等于播不了。
      reportWatchProgress(endDuration, true);
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
    function syncAudio() {
      if (cancelled) return;
      const nextVolume = Math.round(media.volume * 100);
      const nextMuted = media.muted || nextVolume === 0;
      volumeRef.current = nextVolume;
      mutedRef.current = nextMuted;
      if (nextVolume > 0) previousVolumeRef.current = nextVolume;
      setVolume(nextVolume);
      setMuted(nextMuted);
    }

    video.volume = volumeRef.current / 100;
    video.muted = mutedRef.current;
    video.addEventListener("timeupdate", syncTime);
    video.addEventListener("durationchange", syncTime);
    video.addEventListener("loadedmetadata", onReady);
    video.addEventListener("canplay", onReady);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("ended", onEnded);
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("volumechange", syncAudio);

    void loadVideoJsModules(kind)
      .then((modules) => {
        if (cancelled) return;
        const player = createVideoJsPlayer(modules, {
          video,
          url,
          kind,
          isLive: false,
          // 录制回放非直播：关低延迟并放宽前后向缓冲，重试上限保持紧凑。
          hls: {
            lowLatencyMode: false,
            backBufferLength: 90,
            maxBufferLength: 90,
            manifestLoadingMaxRetry: 2,
            levelLoadingMaxRetry: 2,
            fragLoadingMaxRetry: 2,
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
          setError(videoJsPlayerErrorMessage(cause, "录制回放失败"));
          setLoading(false);
          setWaiting(false);
        });
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(videoJsPlayerErrorMessage(cause, "无法初始化录制播放器"));
        setLoading(false);
      });

    return () => {
      cancelled = true;
      // 离开播放页与协议重建都走这里：最后一段进度必须立刻落盘，
      // 否则节流窗口内看的那几秒全丢。
      reportWatchProgress(clampRecordingPlaybackTime(media.currentTime, recordedDuration), true);
      video.removeEventListener("timeupdate", syncTime);
      video.removeEventListener("durationchange", syncTime);
      video.removeEventListener("loadedmetadata", onReady);
      video.removeEventListener("canplay", onReady);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("volumechange", syncAudio);
      seekRequestRef.current += 1;
      clearSeekTimer();
      seekTargetRef.current = null;
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
    reportWatchProgress,
    resumePending,
    url,
  ]);

  const togglePlayback = useCallback(() => {
    const player = playerRef.current;
    const video = videoRef.current;
    if (!player || !video) return;
    if (video.paused) {
      void Promise.resolve(player.play()).catch((cause) => {
        if (isInterruptedPlayRequest(cause)) return;
        setError(videoJsPlayerErrorMessage(cause, "播放录制失败"));
      });
    } else {
      player.pause();
    }
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (mutedRef.current || volumeRef.current === 0) {
      const restoredVolume = previousVolumeRef.current || DEFAULT_PLAYER_VOLUME;
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

  // 音量记忆共享给所有播放表面：录制页的音量变化也写回同一份持久记忆。
  useEffect(() => {
    rememberPlayerVolume(volume, muted);
  }, [muted, volume]);

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

  /**
   * 鼠标离开播放器区域：HUD 与控制条立即收起，不等空闲倒计时。触摸指针
   * 抬手同样触发 pointerleave，仍走原空闲节奏，避免吞掉单击唤醒的 chrome。
   */
  const handleStagePointerLeave = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType !== "mouse") {
        scheduleControlsHide();
        return;
      }
      if (paused || loading || error || overlayInteractionOpen) return;
      clearControlsHideTimer();
      setChromeVisible(false);
    },
    [
      clearControlsHideTimer,
      error,
      loading,
      overlayInteractionOpen,
      paused,
      scheduleControlsHide,
      setChromeVisible,
    ],
  );

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

  useEffect(() => clearControlsHideTimer, [clearControlsHideTimer]);

  // 点按暂停、双击全屏：识别器与判定窗口来自 Video.js 官方钩子，动作仍是本页的
  // togglePlayback / 三路径全屏适配器。
  usePlayerStageTapGestures({
    target: stageRef,
    onTap: togglePlayback,
    onDoubleTap: () => void fullscreen.toggle(),
    shouldIgnore: (event) => isPlayerControlTarget(event.target),
  });

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

  const showFullscreenHud = showPlayerFullscreenHud({
    fullscreen: fullscreen.fullscreen,
    hasRoomIdentity: Boolean(item.title.trim() || item.user_name.trim()),
    hasActions: false,
  });

  return (
    <VideoJsContainer
      variant="vod"
      ref={stageRef}
      data-player-stage
      data-recording-player
      data-fullscreen={fullscreen.fullscreen && fullscreen.nativeLayer ? "true" : undefined}
      className={cn(
        "relative flex min-w-0 flex-col overflow-hidden bg-black data-[fullscreen=true]:rounded-none data-[fullscreen=true]:border-0",
        fill
          ? "size-full min-h-0 rounded-none border-0 shadow-none"
          : "aspect-video border border-border-subtle shadow-sm",
      )}
      aria-label={`${item.title} 录制回放；按空格或 K 播放或暂停，左右方向键快退或快进，M 静音，F 全屏`}
      aria-keyshortcuts="Space K ArrowLeft ArrowRight M F"
      onPointerEnter={handleStagePointerActivity}
      onPointerMove={handleStagePointerActivity}
      onPointerLeave={handleStagePointerLeave}
      onKeyDown={handleStageKeyDown}
      tabIndex={0}
      controls={
        <PlayerControls
          chrome={{
            ref: controlsRef,
            "data-player-controls": true,
            "data-visible": "true",
            "aria-hidden": "false",
            className:
              "absolute inset-x-0 bottom-0 z-30 transition-opacity duration-150 ease-out motion-reduced:transition-none data-[visible=false]:pointer-events-none data-[visible=false]:opacity-0",
            onPointerEnter: holdControlsVisible,
            onPointerLeave: scheduleControlsHide,
            onFocusCapture: holdControlsVisible,
            onBlurCapture: scheduleControlsHide,
          }}
          osdOn={danmakuVisible}
          fullscreen={fullscreen.fullscreen}
          nativeFullscreen={!fullscreen.nativeLayer}
          disabled={loading}
          refreshDisabled={loading}
          loadError={fullscreen.error}
          stackedBelowPlayer={fill ? compact : true}
          compact={compact}
          portalContainer={stageRef}
          playbackSettingsTitle="回放设置"
          playbackSettingsLabel="回放设置"
          playbackSettings={item.include_danmaku ? <RecordingPlaybackSettings /> : undefined}
          onOverlayInteractionChange={setOverlayInteractionOpen}
          onRefresh={retryPlayback}
          onToggleOsd={
            item.include_danmaku && danmakuUrlQuery.data
              ? () => setDanmakuVisible((visible) => !visible)
              : undefined
          }
          onToggleFullscreen={fullscreen.nativeLayer ? () => void fullscreen.toggle() : undefined}
        />
      }
    >
      <div
        data-player-video-surface
        className="relative min-h-0 flex-1 overflow-hidden bg-black"
      >
        <div
          ref={rootRef}
          data-player-engine-root
          className="absolute inset-0 size-full overflow-hidden bg-black"
        >
          <VideoJsVideo
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
    </VideoJsContainer>
  );
}
