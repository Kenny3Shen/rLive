import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { Captions, CaptionsOff, Check } from "lucide-react";
import { useCaptionsOptions } from "@videojs/react";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import { Button as MediaButton } from "@/components/videojs/ui/button";
import { ButtonTooltip } from "@/components/videojs/ui/button-tooltip";
import { mediaPopupTriggerOpenClass } from "@/components/videojs/lib/popup-surface";
import { useHoverOpen } from "@/components/videojs/lib/use-hover-open";
import {
  formatPlaybackRateLabel,
  PlayerControls,
  PlayerMenuRadioGroup,
  VOD_PLAYBACK_RATES,
} from "@/shared/components/player/PlayerControls";
import {
  glassOptionClass,
  glassOptionSelectedClass,
  glassPanelClass,
  glassTitleClass,
} from "@/shared/components/player/glassSurface";
import { PlayerLoadingBackButton } from "@/shared/components/player/PlayerLoadingBackButton";
import { usePlayerChromeIdle } from "@/shared/hooks/usePlayerChromeIdle";
import { useCompactPlayerViewport, usePortraitOrientation } from "@/shared/hooks/usePlayerViewport";
import { usePlayerStageTapGestures } from "@/shared/hooks/usePlayerStageTapGestures";
import { useScreenWakeLock } from "@/shared/hooks/useScreenWakeLock";
import {
  DEFAULT_PLAYER_VOLUME,
  readPlayerVolume,
  rememberPlayerVolume,
} from "@/shared/playerVolume";
import {
  isWatchProgressWorthKeeping,
  shouldReportWatchProgress,
  watchResumePosition,
} from "@/shared/watchProgress";
import { getClientPlatform } from "@/shared/clientPlatform";
import { useAndroidPlayerControls } from "@/features/room/player/androidPlayerControls";
import { runningOnAndroidTauri } from "@/features/room/player/androidImmersive";
import {
  createVideoJsPlayer,
  isInterruptedPlayRequest,
  loadVideoJsModules,
  videoJsPlayerErrorMessage,
  type VideoJsPlayerInstance,
} from "@/features/room/player/videoJsPlayer";
import {
  VideoJsContainer,
  VideoJsPlayerProvider,
  VideoJsVideo,
  useVideoJsPlaybackRate,
} from "@/features/room/player/videoJsControls";
import { PlayerFullscreenHud, showPlayerFullscreenHud } from "@/features/room/PlayerFullscreenHud";
import { applyWebPlayerAudio } from "@/features/room/player/useWebPlayer";
import { useRecordingPlayerFullscreen } from "@/features/recording/useRecordingPlayerFullscreen";
import {
  videoDownloadWatchProgressReport,
  type VideoDownloadItem,
  type VideoDownloadSubtitle,
} from "./videoDownload";
import { VideoDanmakuLayer } from "./VideoDanmakuLayer";
import type { VideoDanmakuEntry } from "./videoDanmaku";

function finiteDuration(video: HTMLVideoElement): number {
  return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
}

function isPlayerControlTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      'button, input, select, textarea, [role="button"], [role="slider"], [role="dialog"], [data-player-controls]',
    ),
  );
}

function DownloadRateSettings() {
  const playbackRate = useVideoJsPlaybackRate();
  if (!playbackRate) return null;
  const options = VOD_PLAYBACK_RATES.map((rate) => ({
    value: String(rate),
    label: formatPlaybackRateLabel(rate),
  }));
  const current = String(
    VOD_PLAYBACK_RATES.find((rate) => rate === playbackRate.playbackRate) ?? 1,
  );
  return (
    <div className="flex flex-col gap-1.5 px-1 py-1">
      <PlayerMenuRadioGroup
        label="倍数播放"
        value={current}
        options={options}
        columns={options.length}
        onValueChange={(nextValue) => playbackRate.setPlaybackRate(Number(nextValue))}
      />
    </div>
  );
}

function DownloadCaptions({
  subtitles,
  compact,
  stageRef,
  onOpenChange,
}: {
  subtitles: readonly VideoDownloadSubtitle[];
  compact: boolean;
  stageRef: RefObject<HTMLDivElement | null>;
  onOpenChange: (open: boolean) => void;
}) {
  const captions = useCaptionsOptions();
  const portrait = usePortraitOrientation();
  const [open, setOpen] = useState(false);
  const hover = useHoverOpen(open, setOpen);
  const available = subtitles.length > 0 && captions?.state.availability === "available";
  const active = captions?.state.subtitlesShowing ?? false;
  const menuOpen = available && open;

  useEffect(() => {
    onOpenChange(menuOpen);
  }, [menuOpen, onOpenChange]);

  useEffect(
    () => () => {
      onOpenChange(false);
    },
    [onOpenChange],
  );

  if (!available || !captions) {
    return (
      <ButtonTooltip label="当前下载没有缓存字幕" side="top">
        <MediaButton
          aria-label="字幕"
          aria-disabled
          disabled
          className="r-live-media-extension-button"
        >
          <CaptionsOff className="size-6" aria-hidden />
        </MediaButton>
      </ButtonTooltip>
    );
  }

  const trigger = (
    <MediaButton
      aria-label="字幕来源"
      aria-pressed={active}
      aria-expanded={compact ? menuOpen : undefined}
      onClick={compact ? () => setOpen((current) => !current) : undefined}
      className={cn(
        "r-live-media-extension-button",
        menuOpen && mediaPopupTriggerOpenClass,
        active && glassOptionSelectedClass(),
      )}
    >
      {active ? (
        <Captions className="size-6" aria-hidden />
      ) : (
        <CaptionsOff className="size-6" aria-hidden />
      )}
    </MediaButton>
  );
  const body = captions.options.map((option) => {
    const selected = option.value === captions.value;
    const label = option.value === "off" ? "关闭字幕" : option.label;
    return (
      <Button
        key={option.value}
        variant="ghost"
        className={cn(
          "w-full justify-between max-md:h-10",
          glassOptionClass(),
          selected && glassOptionSelectedClass(),
        )}
        aria-pressed={selected}
        onClick={() => {
          captions.setValue(option.value);
          setOpen(false);
        }}
      >
        <span className="truncate">{label}</span>
        {selected && <Check data-icon="inline-end" aria-hidden />}
      </Button>
    );
  });

  if (compact) {
    return (
      <>
        {trigger}
        <Drawer open={menuOpen} onOpenChange={setOpen}>
          <DrawerContent
            side={portrait ? "bottom" : "right"}
            container={stageRef}
            glass
            className={cn(
              "flex flex-col gap-0",
              glassPanelClass({ overlay: true }),
              "whitespace-nowrap [&_*]:whitespace-nowrap",
            )}
          >
            <DrawerTitle className={glassTitleClass({ overlay: true })}>字幕</DrawerTitle>
            {body}
          </DrawerContent>
        </Drawer>
      </>
    );
  }

  return (
    <Popover open={menuOpen} onOpenChange={hover.onOpenChange}>
      <PopoverTrigger {...hover.trigger} render={trigger} />
      <PopoverContent
        container={stageRef}
        side="top"
        align="end"
        collisionBoundary={document.documentElement}
        collisionPadding={{ top: 24, right: 12, bottom: 12, left: 12 }}
        sticky
        glass
        className={cn(
          "flex w-72 flex-col gap-0 overflow-y-auto p-1.5 whitespace-nowrap [&_*]:whitespace-nowrap",
          glassPanelClass({ overlay: true }),
        )}
        {...hover.popup}
      >
        {body}
      </PopoverContent>
    </Popover>
  );
}

type LocalDownloadPlayerProps = {
  item: VideoDownloadItem;
  url: string;
  progress: number;
  subtitles: VideoDownloadSubtitle[];
  danmakuEntries: readonly VideoDanmakuEntry[];
  danmakuAvailable: boolean;
  onNavigateBack: () => void;
  fill?: boolean;
};

/**
 * 已完成下载的本地点播表面。
 *
 * 下载文件固定为 MP4，因此不使用录制回放的 FLV/TS/HLS 协议恢复逻辑，也不加载
 * 在线详情。弹幕只读取本机快照；播放控件、全屏、手势与续播判定复用公共实现。
 */
export function LocalDownloadPlayer(props: LocalDownloadPlayerProps) {
  return (
    <VideoJsPlayerProvider key={props.item.id}>
      <LocalDownloadPlayerContent {...props} />
    </VideoJsPlayerProvider>
  );
}

function LocalDownloadPlayerContent({
  item,
  url,
  progress,
  subtitles,
  danmakuEntries,
  danmakuAvailable,
  onNavigateBack,
  fill = false,
}: LocalDownloadPlayerProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const hudRef = useRef<HTMLDivElement | null>(null);
  const lockRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerRef = useRef<VideoJsPlayerInstance | null>(null);
  const [initialProgress] = useState(progress);
  const [initialDuration] = useState(Math.max(0, item.duration));
  const currentTimeRef = useRef(0);
  const durationRef = useRef(initialDuration);
  const reportedAtRef = useRef<number | null>(null);
  const [initialAudio] = useState(() =>
    runningOnAndroidTauri() ? { volume: 100, muted: false } : readPlayerVolume(),
  );
  const volumeRef = useRef(initialAudio.volume);
  const mutedRef = useRef(initialAudio.muted);
  const previousVolumeRef = useRef(initialAudio.volume);
  const [volume, setVolume] = useState(initialAudio.volume);
  const [muted, setMuted] = useState(initialAudio.muted);
  const [loading, setLoading] = useState(true);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(true);
  const [overlayInteractionOpen, setOverlayInteractionOpen] = useState(false);
  const [captionsMenuOpen, setCaptionsMenuOpen] = useState(false);
  const [danmakuVisible, setDanmakuVisible] = useState(true);
  const [playerRevision, setPlayerRevision] = useState(0);
  const compact = useCompactPlayerViewport();
  const fullscreen = useRecordingPlayerFullscreen(stageRef);
  const clientPlatform = getClientPlatform();
  const androidPlayerControls = useAndroidPlayerControls(clientPlatform === "android", item.id);
  const nativePlayerControlsActive = androidPlayerControls.supported;
  const playerControlVolume = androidPlayerControls.state?.mediaVolume ?? volume;
  const playerControlMuted = androidPlayerControls.state
    ? muted || androidPlayerControls.state.mediaVolume <= 0
    : muted;
  const { revealControls, holdControlsVisible, scheduleControlsHide, dismissControls } =
    usePlayerChromeIdle({
      controlsRef,
      hudRef,
      lockRef,
      fullscreenLocked: false,
      keepVisible:
        paused ||
        loading ||
        waiting ||
        error !== null ||
        overlayInteractionOpen ||
        captionsMenuOpen,
    });
  useScreenWakeLock(!paused && !loading && !error);

  const reportWatchProgress = useCallback(
    (position: number, force: boolean) => {
      const now = Date.now();
      if (force) {
        if (!isWatchProgressWorthKeeping(position)) return;
      } else if (!shouldReportWatchProgress(position, reportedAtRef.current, now)) {
        return;
      }
      reportedAtRef.current = now;
      void videoDownloadWatchProgressReport({
        id: item.id,
        progress: position,
        duration: durationRef.current || initialDuration,
      }).catch(() => undefined);
    },
    [initialDuration, item.id],
  );

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const media = video;
    const restartAt = playerRevision === 0 ? initialProgress : currentTimeRef.current;
    let resumeApplied = false;
    let cancelled = false;
    reportedAtRef.current = null;

    setLoading(true);
    setWaiting(false);
    setError(null);
    setPaused(true);

    const syncTime = () => {
      if (cancelled) return;
      const nextDuration = finiteDuration(media);
      if (nextDuration > 0) durationRef.current = nextDuration;
      currentTimeRef.current = Number.isFinite(media.currentTime)
        ? Math.max(0, media.currentTime)
        : 0;
      reportWatchProgress(currentTimeRef.current, false);
    };
    const applyResume = () => {
      if (resumeApplied) return;
      resumeApplied = true;
      const measuredDuration = finiteDuration(media);
      if (measuredDuration > 0) durationRef.current = measuredDuration;
      const target = watchResumePosition(restartAt, durationRef.current);
      if (target <= 0) return;
      currentTimeRef.current = target;
      try {
        media.currentTime = target;
        setWaiting(true);
      } catch {
        // 原生 MP4 不支持随机访问时仍从头播放，不阻断整个文件。
      }
    };
    const onLoadedMetadata = () => {
      if (!cancelled) applyResume();
    };
    const onReady = () => {
      if (cancelled) return;
      applyResume();
      setLoading(false);
      setWaiting(false);
      setPaused(media.paused);
      syncTime();
    };
    const onPlay = () => {
      if (cancelled) return;
      setPaused(false);
      setWaiting(false);
      setLoading(false);
    };
    const onPause = () => {
      if (cancelled) return;
      setPaused(true);
      reportWatchProgress(Math.max(0, media.currentTime), true);
    };
    const onWaiting = () => {
      if (!cancelled && !media.ended) setWaiting(true);
    };
    const onSeeking = () => {
      if (!cancelled) setWaiting(true);
    };
    const onSeeked = () => {
      if (!cancelled) {
        syncTime();
        setWaiting(false);
      }
    };
    const onEnded = () => {
      if (cancelled) return;
      const endedAt = finiteDuration(media) || durationRef.current || media.currentTime;
      currentTimeRef.current = endedAt;
      reportWatchProgress(endedAt, true);
      setPaused(true);
      setWaiting(false);
    };
    const onMediaError = () => {
      if (cancelled) return;
      setError(videoJsPlayerErrorMessage(media.error, "本地视频播放失败"));
      setLoading(false);
      setWaiting(false);
    };
    const syncAudio = () => {
      if (cancelled) return;
      const nextVolume = Math.round(media.volume * 100);
      const nextMuted = media.muted || nextVolume === 0;
      volumeRef.current = nextVolume;
      mutedRef.current = nextMuted;
      if (nextVolume > 0) previousVolumeRef.current = nextVolume;
      setVolume(nextVolume);
      setMuted(nextMuted);
    };

    media.volume = volumeRef.current / 100;
    media.muted = mutedRef.current;
    media.addEventListener("loadedmetadata", onLoadedMetadata);
    media.addEventListener("loadeddata", onReady);
    media.addEventListener("canplay", onReady);
    media.addEventListener("timeupdate", syncTime);
    media.addEventListener("durationchange", syncTime);
    media.addEventListener("play", onPlay);
    media.addEventListener("playing", onReady);
    media.addEventListener("pause", onPause);
    media.addEventListener("waiting", onWaiting);
    media.addEventListener("seeking", onSeeking);
    media.addEventListener("seeked", onSeeked);
    media.addEventListener("ended", onEnded);
    media.addEventListener("error", onMediaError);
    media.addEventListener("volumechange", syncAudio);

    void loadVideoJsModules("native")
      .then((modules) => {
        if (cancelled) return;
        const player = createVideoJsPlayer(modules, {
          video: media,
          url,
          kind: "native",
          isLive: false,
        });
        playerRef.current = player;
        player.on("error", (cause) => {
          if (cancelled) return;
          setError(videoJsPlayerErrorMessage(cause, "本地视频播放失败"));
          setLoading(false);
          setWaiting(false);
        });
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(videoJsPlayerErrorMessage(cause, "无法初始化本地播放器"));
        setLoading(false);
      });

    return () => {
      cancelled = true;
      reportWatchProgress(Math.max(0, media.currentTime), true);
      media.removeEventListener("loadedmetadata", onLoadedMetadata);
      media.removeEventListener("loadeddata", onReady);
      media.removeEventListener("canplay", onReady);
      media.removeEventListener("timeupdate", syncTime);
      media.removeEventListener("durationchange", syncTime);
      media.removeEventListener("play", onPlay);
      media.removeEventListener("playing", onReady);
      media.removeEventListener("pause", onPause);
      media.removeEventListener("waiting", onWaiting);
      media.removeEventListener("seeking", onSeeking);
      media.removeEventListener("seeked", onSeeked);
      media.removeEventListener("ended", onEnded);
      media.removeEventListener("error", onMediaError);
      media.removeEventListener("volumechange", syncAudio);
      const player = playerRef.current;
      playerRef.current = null;
      try {
        player?.pause();
        player?.destroy();
      } catch {
        // 原生媒体可能已经在路由卸载时释放。
      }
    };
  }, [initialProgress, item.id, playerRevision, reportWatchProgress, url]);

  const seekTo = useCallback((requestedTarget: number) => {
    const media = videoRef.current;
    if (!media || !Number.isFinite(requestedTarget)) return;
    const maximum = durationRef.current || finiteDuration(media) || requestedTarget;
    const target = Math.max(0, Math.min(requestedTarget, maximum));
    currentTimeRef.current = target;
    setError(null);
    setWaiting(true);
    try {
      media.currentTime = target;
    } catch {
      setWaiting(false);
      setError("无法跳转到该位置");
    }
  }, []);

  const togglePlayback = useCallback(() => {
    const player = playerRef.current;
    const media = videoRef.current;
    if (!player || !media) return;
    if (media.paused) {
      void Promise.resolve(player.play()).catch((cause) => {
        if (isInterruptedPlayRequest(cause)) return;
        setError(videoJsPlayerErrorMessage(cause, "本地视频播放失败"));
      });
    } else {
      player.pause();
    }
  }, []);

  const commitVolume = useCallback((nextVolume: number, nextMuted: boolean) => {
    const normalizedVolume = Math.max(0, Math.min(100, nextVolume));
    const normalizedMuted = nextMuted || normalizedVolume === 0;
    volumeRef.current = normalizedVolume;
    mutedRef.current = normalizedMuted;
    if (normalizedVolume > 0) previousVolumeRef.current = normalizedVolume;
    const media = videoRef.current;
    if (media) applyWebPlayerAudio(media, normalizedVolume, normalizedMuted);
    setVolume(normalizedVolume);
    setMuted(normalizedMuted);
  }, []);

  const setPlayerVolume = useCallback(
    (nextVolume: number) => {
      if (nativePlayerControlsActive && androidPlayerControls.setMediaVolume(nextVolume)) {
        commitVolume(100, false);
        return;
      }
      commitVolume(nextVolume, nextVolume === 0);
    },
    [androidPlayerControls, commitVolume, nativePlayerControlsActive],
  );

  const toggleMute = useCallback(() => {
    if (nativePlayerControlsActive && androidPlayerControls.toggleMediaMute()) {
      commitVolume(100, false);
      return;
    }
    const media = videoRef.current;
    if (mutedRef.current || volumeRef.current === 0) {
      const restoredVolume = previousVolumeRef.current || DEFAULT_PLAYER_VOLUME;
      commitVolume(restoredVolume, false);
      return;
    }
    previousVolumeRef.current = volumeRef.current;
    if (media) media.muted = true;
    mutedRef.current = true;
    setMuted(true);
  }, [androidPlayerControls, commitVolume, nativePlayerControlsActive]);

  useEffect(() => {
    if (!runningOnAndroidTauri()) rememberPlayerVolume(volume, muted);
  }, [muted, volume]);

  useEffect(() => {
    revealControls();
  }, [fullscreen.fullscreen, revealControls]);

  const retryPlayback = useCallback(() => {
    setError(null);
    setLoading(true);
    setWaiting(false);
    setPlayerRevision((revision) => revision + 1);
  }, []);

  const handleStagePointerActivity = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (isPlayerControlTarget(event.target)) holdControlsVisible();
      else revealControls();
    },
    [holdControlsVisible, revealControls],
  );

  const handleStagePointerLeave = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType === "mouse") dismissControls();
      else scheduleControlsHide();
    },
    [dismissControls, scheduleControlsHide],
  );

  const handleStageKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.defaultPrevented || isPlayerControlTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === " " || key === "k") {
        event.preventDefault();
        togglePlayback();
      } else if (key === "arrowleft") {
        event.preventDefault();
        seekTo(currentTimeRef.current - 5);
      } else if (key === "arrowright") {
        event.preventDefault();
        seekTo(currentTimeRef.current + 5);
      } else if (key === "m") {
        event.preventDefault();
        toggleMute();
      } else if (key === "f" && !event.repeat) {
        event.preventDefault();
        void fullscreen.toggle();
      } else {
        return;
      }
      revealControls();
    },
    [fullscreen, revealControls, seekTo, toggleMute, togglePlayback],
  );

  usePlayerStageTapGestures({
    target: stageRef,
    enabled: !loading && !error,
    onTap: togglePlayback,
    onDoubleTap: () => void fullscreen.toggle(),
    shouldIgnore: (event) => isPlayerControlTarget(event.target),
  });

  const showPlayerHud = showPlayerFullscreenHud({
    // 下载播放页没有流内顶栏，画面内 HUD 在普通窗口和全屏都承担导航。
    fullscreen: true,
    hasRoomIdentity: Boolean(item.title.trim() || item.author.trim()),
    // 返回按钮本身也是动作，即使下载元数据缺少标题与作者也必须可离开。
    hasActions: true,
  });
  const backLabel = fullscreen.fullscreen ? "退出全屏" : "返回下载列表";
  const handlePlayerBack = () => {
    if (fullscreen.fullscreen) void fullscreen.exit();
    else onNavigateBack();
  };

  return (
    <VideoJsContainer
      variant="vod"
      ref={stageRef}
      errorDialog={{ error, title: "本地视频播放失败", onRetry: retryPlayback }}
      data-player-stage
      data-download-player
      data-fullscreen={fullscreen.fullscreen && fullscreen.nativeLayer ? "true" : undefined}
      className={cn(
        "relative flex min-w-0 flex-col overflow-hidden bg-black data-[fullscreen=true]:rounded-none data-[fullscreen=true]:border-0",
        fill
          ? "size-full min-h-0 rounded-none border-0 shadow-none"
          : "aspect-video border border-border-subtle shadow-sm",
      )}
      aria-label={`${item.title} 本地下载；按空格或 K 播放或暂停，左右方向键快退或快进，M 静音，F 全屏`}
      aria-keyshortcuts="Space K ArrowLeft ArrowRight M F"
      onPointerEnter={handleStagePointerActivity}
      onPointerMove={handleStagePointerActivity}
      onPointerLeave={handleStagePointerLeave}
      onKeyDown={handleStageKeyDown}
      onTogglePause={togglePlayback}
      tabIndex={0}
      controls={
        !loading &&
        !error && (
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
            externalAudioControls={
              nativePlayerControlsActive
                ? {
                    volume: playerControlVolume,
                    muted: playerControlMuted,
                    onVolumeChange: setPlayerVolume,
                    onToggleMute: toggleMute,
                  }
                : undefined
            }
            fullscreen={fullscreen.fullscreen}
            osdOn={danmakuVisible}
            onToggleOsd={
              danmakuAvailable ? () => setDanmakuVisible((visible) => !visible) : undefined
            }
            nativeFullscreen={!fullscreen.nativeLayer}
            disabled={loading}
            refreshDisabled={loading}
            loadError={fullscreen.error}
            stackedBelowPlayer={fill ? compact : true}
            compact={compact}
            portalContainer={stageRef}
            playbackSettingsTitle="倍数播放"
            playbackSettingsLabel="倍数播放"
            playbackSettings={<DownloadRateSettings />}
            captionsSlot={
              <DownloadCaptions
                subtitles={subtitles}
                compact={compact}
                stageRef={stageRef}
                onOpenChange={setCaptionsMenuOpen}
              />
            }
            onOverlayInteractionChange={setOverlayInteractionOpen}
            onRefresh={retryPlayback}
            onTogglePause={togglePlayback}
            onToggleFullscreen={fullscreen.nativeLayer ? () => void fullscreen.toggle() : undefined}
          />
        )
      }
    >
      <div data-player-video-surface className="relative min-h-0 flex-1 overflow-hidden bg-black">
        <div
          data-player-engine-root
          className="absolute inset-0 size-full overflow-hidden bg-black"
        >
          <VideoJsVideo
            ref={videoRef}
            data-player-video
            playsInline
            preload="metadata"
            controls={false}
            // 缓存 VTT 与媒体不在同一源；有字幕时让媒体与 track 共用 CORS 模式。
            crossOrigin={subtitles.length > 0 ? "anonymous" : undefined}
            className="absolute inset-0 size-full bg-black object-contain"
          >
            {subtitles.map((subtitle) => (
              <track
                key={subtitle.id}
                id={subtitle.id}
                kind="subtitles"
                src={subtitle.url}
                srcLang={subtitle.lan}
                label={subtitle.lan_doc}
              />
            ))}
          </VideoJsVideo>
        </div>
        {danmakuEntries.length > 0 && (
          <VideoDanmakuLayer
            videoRef={videoRef}
            entries={danmakuEntries}
            active={danmakuVisible}
            interactive={false}
          />
        )}
        {(loading || waiting) && !error && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-black/20">
            <Spinner
              className="text-white"
              aria-label={loading ? "正在加载本地视频" : "正在缓冲本地视频"}
            />
          </div>
        )}
      </div>

      {(loading || error) && (
        <PlayerLoadingBackButton label={backLabel} onClick={handlePlayerBack} />
      )}
      {!loading && !error && showPlayerHud && (
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
            onBack={handlePlayerBack}
            backLabel={backLabel}
            roomTitle={item.title.trim() || "本地下载"}
            roomUserName={item.author.trim() || "本地下载"}
            roomUserAvatar={item.cover}
            compact={compact}
            portalContainer={stageRef}
            onExitFullscreen={fullscreen.exit}
          />
        </div>
      )}
    </VideoJsContainer>
  );
}
