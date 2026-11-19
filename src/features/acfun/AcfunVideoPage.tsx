import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ExternalLink,
  Home,
  Link2,
  MessageCircle,
  Play,
} from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { notify } from "@/components/ui/toast";
import { Button as MediaButton } from "@/components/videojs/ui/button";
import { ErrorState } from "@/shared/components/ErrorState";
import {
  PLAYER_HUD_BUTTON_CLASS,
  PLAYER_HUD_ICON_CLASS,
  PLAYER_HUD_TITLE_CLASS,
  PlayerControls,
} from "@/shared/components/player/PlayerControls";
import { PlayerHudOverflowMenu, PlayerToolTile } from "@/shared/components/player/PlayerHudMenu";
import { PlayerLoadingBackButton } from "@/shared/components/player/PlayerLoadingBackButton";
import { PlayerStageSkeleton } from "@/shared/components/player/PlayerStageSkeleton";
import {
  PLAYER_HUD_SURFACE_POSITION_CLASS,
  PLAYER_HUD_SURFACE_TOP_CLASS,
} from "@/shared/components/player/playerBackGeometry";
import { canResizeVideoDetails } from "@/shared/gestures/detailsResize";
import { isMobileClient } from "@/shared/clientPlatform";
import { canNavigateBackInApp } from "@/shared/appHistory";
import { copyText } from "@/shared/clipboard";
import { useDetailsResize } from "@/shared/hooks/useDetailsResize";
import { usePlayerChromeIdle } from "@/shared/hooks/usePlayerChromeIdle";
import {
  useCompactPlayerViewport,
  usePortraitOrientation,
  useStackedDetailsViewport,
} from "@/shared/hooks/usePlayerViewport";
import { usePlayerStageTapGestures } from "@/shared/hooks/usePlayerStageTapGestures";
import { usePlayerStartupGate } from "@/shared/hooks/usePlayerStartupGate";
import { useScreenWakeLock } from "@/shared/hooks/useScreenWakeLock";
import {
  DEFAULT_PLAYER_VOLUME,
  readPlayerVolume,
  rememberPlayerVolume,
} from "@/shared/playerVolume";
import { openExternalUrl } from "@/shared/externalUrl";
import { cn, formatOnline, normalizeImageUrl } from "@/lib/utils";
import { useRecordingPlayerFullscreen } from "@/features/recording/useRecordingPlayerFullscreen";
import { requestPlayerAutoplay } from "@/features/room/player/autoplay";
import {
  createVideoJsPlayer,
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
import { applyWebPlayerAudio } from "@/features/room/player/useWebPlayer";
import {
  VIDEO_DETAILS_INFO_CARD_CLASS,
  VIDEO_DETAILS_SIDEBAR_CARD_CLASS,
  VIDEO_DETAILS_SIDEBAR_STACK_CLASS,
} from "@/shared/components/videoDetailsSidebar";
import {
  VideoSelectionRow,
  VideoSelectionSection,
} from "@/shared/components/VideoSelectionSection";
import { formatDateTime, formatVideoDuration } from "@/features/video/videoHistory";
import { videoSelectionCount } from "@/features/video/videoSelectionCount";
import { videoSelectionDefaultOpen } from "@/features/video/videoSelectionDefaults";
import { acfunVideoGetDetail, acfunVideoGetPlayInfo, acfunVideoStopPlay } from "./acfunApi";
import { AcfunPlaybackSessions } from "./acfunPlaybackLifecycle";
import { acfunHomePath } from "./acfunRoute";
import type { AcfunVideoDetail, AcfunVideoPart, AcfunVideoPlayInfo } from "./acfunTypes";
import { AcfunVideoComments } from "./AcfunVideoComments";

function playbackKind(info: AcfunVideoPlayInfo): VideoJsPlaybackKind {
  if (info.protocol === "hls") return "hls";
  if (info.protocol === "native") return "native";
  if (info.protocol === "mpeg_ts") return "mpegts";
  const path = info.url.toLowerCase();
  if (path.includes(".m3u8")) return "hls";
  if (path.includes(".flv")) return "flv";
  if (path.includes(".ts")) return "mpegts";
  return "native";
}

function isPlayerControlTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'button, a, input, select, textarea, [role="button"], [role="slider"], [role="dialog"], [data-player-controls], [data-player-hud]',
    ),
  );
}

function partLabel(part: AcfunVideoPart): string {
  return part.title.trim() || `第 ${part.index} P`;
}

function copyAcfunOriginalUrl(originalUrl: string): void {
  if (!originalUrl) return;
  void copyText(originalUrl).then((copied) => {
    if (copied) notify.success("已复制视频链接");
    else notify.error("复制失败", "请手动选择并复制。");
  });
}

function openAcfunOriginalUrl(originalUrl: string): void {
  if (!originalUrl) return;
  void openExternalUrl(originalUrl).then((opened) => {
    if (opened) notify.success("已在浏览器中打开");
    else notify.error("无法在浏览器中打开", "请稍后重试。");
  });
}

function AcfunPlayerSurface({
  detail,
  info,
  originalUrl,
  retainedError,
  onBack,
  onHome,
  onRetry,
  onQualityChange,
  onStartupReady,
  onAspectRatioChange,
  onFullscreenChange,
  initialPosition,
  initialAutoplay,
}: {
  detail: AcfunVideoDetail;
  info: AcfunVideoPlayInfo;
  originalUrl: string;
  retainedError: unknown | null;
  onBack: () => void;
  onHome: () => void;
  onRetry: () => void;
  onQualityChange: (quality: string, playback: { time: number; autoplay: boolean }) => void;
  onStartupReady: () => void;
  onAspectRatioChange: (aspectRatio: number) => void;
  onFullscreenChange: (fullscreen: boolean) => void;
  initialPosition: number;
  initialAutoplay: boolean;
}) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const hudRef = useRef<HTMLDivElement | null>(null);
  const lockRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerRef = useRef<VideoJsPlayerInstance | null>(null);
  const playerId = useId();
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [waiting, setWaiting] = useState(false);
  const [paused, setPaused] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hudMenuOpen, setHudMenuOpen] = useState(false);
  const [initialAudio] = useState(() => readPlayerVolume());
  const volumeRef = useRef(initialAudio.volume);
  const mutedRef = useRef(initialAudio.muted);
  const previousVolumeRef = useRef(initialAudio.volume);
  const desiredAutoplayRef = useRef(initialAutoplay);
  const initialPositionRef = useRef(initialPosition);
  const initialAutoplayRef = useRef(initialAutoplay);
  const [volume, setVolume] = useState(initialAudio.volume);
  const [muted, setMuted] = useState(initialAudio.muted);
  const compact = useCompactPlayerViewport();
  const portrait = usePortraitOrientation();
  const mobileClient = isMobileClient();
  const fullscreen = useRecordingPlayerFullscreen(stageRef);
  const kind = playbackKind(info);
  const qualityIndex = Math.max(
    0,
    info.accept_qualities.findIndex((quality) => quality.id === info.quality),
  );

  const resetPlayback = useCallback(() => {
    setError(null);
    setLoading(true);
    setWaiting(false);
    setRevision((value) => value + 1);
  }, []);

  const { revealControls, holdControlsVisible, scheduleControlsHide, dismissControls } =
    usePlayerChromeIdle({
      controlsRef,
      hudRef,
      lockRef,
      fullscreenLocked: false,
      keepVisible: paused || loading || waiting || error !== null || hudMenuOpen,
    });
  useScreenWakeLock(!paused && !loading && !error);

  useEffect(() => {
    if (loading && !error) return;
    onStartupReady();
  }, [error, loading, onStartupReady]);

  useEffect(() => {
    onFullscreenChange(fullscreen.fullscreen);
    return () => onFullscreenChange(false);
  }, [fullscreen.fullscreen, onFullscreenChange]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const reportAspectRatio = () => {
      if (video.videoWidth <= 0 || video.videoHeight <= 0) return;
      const ratio = video.videoWidth / video.videoHeight;
      if (Number.isFinite(ratio) && ratio > 0) onAspectRatioChange(ratio);
    };
    video.addEventListener("loadedmetadata", reportAspectRatio);
    video.addEventListener("resize", reportAspectRatio);
    reportAspectRatio();
    return () => {
      video.removeEventListener("loadedmetadata", reportAspectRatio);
      video.removeEventListener("resize", reportAspectRatio);
    };
  }, [onAspectRatioChange]);

  useLayoutEffect(() => {
    // 新地址可能晚于画质交接状态到达；先用 ref 暂存，避免位置变化重建旧播放器。
    initialPositionRef.current = initialPosition;
    initialAutoplayRef.current = initialAutoplay;
  }, [initialAutoplay, initialPosition]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const resumePosition = initialPositionRef.current;
    let cancelled = false;
    setLoading(true);
    setWaiting(false);
    setError(null);
    setPaused(true);
    desiredAutoplayRef.current = initialAutoplayRef.current;
    let resumeApplied = false;

    const applyResume = () => {
      if (resumeApplied) return;
      resumeApplied = true;
      if (resumePosition <= 0) return;
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      const target = duration > 0 ? Math.min(resumePosition, duration) : resumePosition;
      try {
        video.currentTime = Math.max(0, target);
      } catch {
        // 个别分片容器在 metadata 到达前不允许 seek；保留从头播放。
      }
    };

    const ready = () => {
      if (cancelled) return;
      applyResume();
      setLoading(false);
      setWaiting(false);
      setPaused(video.paused);
    };
    const onPlay = () => {
      if (!cancelled) {
        setPaused(false);
        setLoading(false);
        desiredAutoplayRef.current = true;
      }
    };
    const onPause = () => {
      if (!cancelled) setPaused(true);
    };
    const onWaiting = () => {
      if (!cancelled && !video.ended) setWaiting(true);
    };
    const onSeeked = () => {
      if (!cancelled) setWaiting(false);
    };
    const onMediaError = () => {
      if (cancelled) return;
      setError(videoJsPlayerErrorMessage(video.error, "AcFun 视频播放失败"));
      setLoading(false);
      setWaiting(false);
    };
    const syncAudio = () => {
      if (cancelled) return;
      const nextVolume = Math.round(video.volume * 100);
      const nextMuted = video.muted || nextVolume === 0;
      volumeRef.current = nextVolume;
      mutedRef.current = nextMuted;
      if (nextVolume > 0) previousVolumeRef.current = nextVolume;
      setVolume(nextVolume);
      setMuted(nextMuted);
    };

    video.volume = volumeRef.current / 100;
    video.muted = mutedRef.current;
    video.addEventListener("loadeddata", ready);
    video.addEventListener("loadedmetadata", applyResume);
    video.addEventListener("canplay", ready);
    video.addEventListener("playing", ready);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("seeking", onWaiting);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onMediaError);
    video.addEventListener("volumechange", syncAudio);

    void loadVideoJsModules(kind)
      .then((modules) => {
        if (cancelled) return;
        const player = createVideoJsPlayer(modules, {
          video,
          url: info.url,
          kind,
          isLive: false,
        });
        playerRef.current = player;
        player.on("error", (cause) => {
          if (cancelled) return;
          setError(videoJsPlayerErrorMessage(cause, "AcFun 视频播放失败"));
          setLoading(false);
          setWaiting(false);
        });
        applyResume();
        if (desiredAutoplayRef.current) {
          requestPlayerAutoplay(
            player,
            video,
            () => !cancelled && playerRef.current === player && desiredAutoplayRef.current,
            () => {
              mutedRef.current = true;
              setMuted(true);
            },
          );
        }
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(videoJsPlayerErrorMessage(cause, "无法初始化 AcFun 播放器"));
        setLoading(false);
      });

    return () => {
      cancelled = true;
      video.removeEventListener("loadeddata", ready);
      video.removeEventListener("loadedmetadata", applyResume);
      video.removeEventListener("canplay", ready);
      video.removeEventListener("playing", ready);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("seeking", onWaiting);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onMediaError);
      video.removeEventListener("volumechange", syncAudio);
      const player = playerRef.current;
      playerRef.current = null;
      try {
        player?.pause();
        player?.destroy();
      } catch {
        // 上游资源可能已先于路由卸载结束。
      }
    };
  }, [info.url, kind, revision]);

  useEffect(() => {
    rememberPlayerVolume(volume, muted);
  }, [muted, volume]);

  const togglePlayback = useCallback(() => {
    const player = playerRef.current;
    const video = videoRef.current;
    if (!player || !video) return;
    if (video.paused) {
      desiredAutoplayRef.current = true;
      void Promise.resolve(player.play()).catch((cause) => {
        if (isInterruptedPlayRequest(cause)) return;
        setError(videoJsPlayerErrorMessage(cause, "AcFun 视频播放失败"));
      });
    } else {
      desiredAutoplayRef.current = false;
      player.pause();
    }
  }, []);

  const commitVolume = useCallback((nextVolume: number, nextMuted: boolean) => {
    const normalizedVolume = Math.max(0, Math.min(100, nextVolume));
    const normalizedMuted = nextMuted || normalizedVolume === 0;
    volumeRef.current = normalizedVolume;
    mutedRef.current = normalizedMuted;
    if (normalizedVolume > 0) previousVolumeRef.current = normalizedVolume;
    if (videoRef.current) {
      applyWebPlayerAudio(videoRef.current, normalizedVolume, normalizedMuted);
    }
    setVolume(normalizedVolume);
    setMuted(normalizedMuted);
  }, []);

  const toggleMute = useCallback(() => {
    if (mutedRef.current || volumeRef.current === 0) {
      commitVolume(previousVolumeRef.current || DEFAULT_PLAYER_VOLUME, false);
      return;
    }
    previousVolumeRef.current = volumeRef.current;
    commitVolume(volumeRef.current, true);
  }, [commitVolume]);

  const seek = useCallback((offset: number) => {
    const video = videoRef.current;
    if (!video) return;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    video.currentTime = Math.max(0, Math.min(video.currentTime + offset, duration || Infinity));
  }, []);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (isPlayerControlTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === " " || key === "k") {
        event.preventDefault();
        togglePlayback();
      } else if (key === "arrowleft") {
        event.preventDefault();
        seek(-5);
      } else if (key === "arrowright") {
        event.preventDefault();
        seek(5);
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
    [fullscreen, revealControls, seek, toggleMute, togglePlayback],
  );

  usePlayerStageTapGestures({
    target: stageRef,
    enabled: !loading && !error,
    onTap: togglePlayback,
    onDoubleTap: () => void fullscreen.toggle(),
    shouldIgnore: (event) => isPlayerControlTarget(event.target),
  });

  const title = detail.item.title;
  const backLabel = fullscreen.fullscreen ? "退出全屏" : "返回 AcFun";
  const handleBack = () => {
    if (fullscreen.fullscreen) void fullscreen.exit();
    else onBack();
  };
  const retry = () => {
    const video = videoRef.current;
    if (video) {
      initialPositionRef.current = Number.isFinite(video.currentTime)
        ? Math.max(0, video.currentTime)
        : 0;
      initialAutoplayRef.current = !video.paused;
    }
    resetPlayback();
    onRetry();
  };
  const copyOriginalUrl = () => {
    setHudMenuOpen(false);
    copyAcfunOriginalUrl(originalUrl);
  };
  const openOriginalUrl = () => {
    setHudMenuOpen(false);
    openAcfunOriginalUrl(originalUrl);
  };
  const controlsAvailable = !loading || error !== null;
  const mobilePortraitControls = mobileClient && portrait && !fullscreen.fullscreen;

  return (
    <VideoJsContainer
      variant="vod"
      ref={stageRef}
      errorDialog={{ error, title: "AcFun 视频播放失败", onRetry: retry }}
      data-player-stage
      data-acfun-player={playerId}
      data-vod-details-player-stage
      data-fullscreen={fullscreen.fullscreen && fullscreen.nativeLayer ? "true" : undefined}
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-black",
        "data-[fullscreen=true]:rounded-none data-[fullscreen=true]:border-0",
      )}
      aria-label={`${title}；按空格或 K 播放或暂停，左右方向键快退或快进，M 静音，F 全屏`}
      aria-keyshortcuts="Space K ArrowLeft ArrowRight M F"
      onPointerEnter={(event: ReactPointerEvent<HTMLElement>) => {
        if (!isPlayerControlTarget(event.target)) revealControls();
      }}
      onPointerMove={(event: ReactPointerEvent<HTMLElement>) => {
        if (isPlayerControlTarget(event.target)) holdControlsVisible();
        else revealControls();
      }}
      onPointerLeave={(event: ReactPointerEvent<HTMLElement>) => {
        if (event.pointerType === "mouse") dismissControls();
        else scheduleControlsHide();
      }}
      onKeyDown={onKeyDown}
      onTogglePause={togglePlayback}
      tabIndex={0}
      controls={
        controlsAvailable && (
          <PlayerControls
            chrome={{
              ref: controlsRef,
              "data-player-controls": true,
              "data-vod-details-controls": true,
              "data-visible": "true",
              "aria-hidden": "false",
              className:
                "absolute inset-x-0 bottom-0 z-30 transition-opacity duration-150 ease-out motion-reduced:transition-none data-[visible=false]:pointer-events-none data-[visible=false]:opacity-0",
              onPointerEnter: holdControlsVisible,
              onPointerLeave: scheduleControlsHide,
              onFocusCapture: holdControlsVisible,
              onBlurCapture: scheduleControlsHide,
            }}
            fullscreen={fullscreen.fullscreen}
            nativeFullscreen={!fullscreen.nativeLayer}
            compact={compact}
            stackedBelowPlayer={compact}
            progressPlacement={mobilePortraitControls ? "center" : "above"}
            portalContainer={stageRef}
            disabled={loading}
            refreshDisabled={loading}
            loadError={fullscreen.error}
            qualities={info.accept_qualities.map((quality) => ({
              quality: quality.label,
              disabled: !quality.available,
              hint: quality.available ? undefined : "当前不可用",
            }))}
            qualityIndex={qualityIndex}
            onQualityChange={(index) => {
              const quality = info.accept_qualities[index];
              if (quality?.available) {
                const video = videoRef.current;
                onQualityChange(quality.id, {
                  time:
                    video && Number.isFinite(video.currentTime)
                      ? Math.max(0, video.currentTime)
                      : 0,
                  autoplay: video ? !video.paused : desiredAutoplayRef.current,
                });
              }
            }}
            onRefresh={retry}
            onTogglePause={togglePlayback}
            onToggleFullscreen={fullscreen.nativeLayer ? () => void fullscreen.toggle() : undefined}
          />
        )
      }
    >
      <div data-video-viewport className="relative flex min-h-0 flex-1 flex-col bg-black">
        <div data-video-frame className="relative flex min-h-0 flex-1 flex-col">
          <div
            data-video-surface
            data-vod-details-media-surface
            className={cn(
              "relative min-h-0 flex-1 overflow-hidden bg-black",
              mobileClient && "touch-none select-none",
            )}
          >
            <VideoJsVideo
              ref={videoRef}
              playsInline
              preload="metadata"
              controls={false}
              className="absolute inset-0 size-full bg-black object-contain"
            />
            {(loading || waiting) && !error && (
              <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-black/20">
                <Spinner
                  className="text-white"
                  aria-label={loading ? "正在加载视频" : "正在缓冲视频"}
                />
              </div>
            )}
            {retainedError !== null && !error && (
              <div className="pointer-events-none absolute inset-x-3 bottom-14 z-20 flex justify-center">
                <div className="pointer-events-auto flex max-w-md items-center gap-2 rounded-lg bg-black/80 px-3 py-2 text-sm text-white shadow-lg backdrop-blur-sm">
                  <span className="min-w-0">刷新播放地址失败，正在使用上一次的流</span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0 border-white/30 bg-transparent text-white hover:bg-white/15 hover:text-white"
                    onClick={onRetry}
                  >
                    重试
                  </Button>
                </div>
              </div>
            )}
          </div>

          {!controlsAvailable && <PlayerLoadingBackButton label={backLabel} onClick={handleBack} />}
          {controlsAvailable && (
            <div
              ref={hudRef}
              data-player-hud
              data-visible="true"
              aria-hidden={false}
              className={cn(
                "absolute inset-x-0 top-0 z-30 transition-opacity duration-150 ease-out",
                "motion-reduced:transition-none data-[visible=false]:pointer-events-none data-[visible=false]:opacity-0",
                "pointer-events-none [&[data-visible=true]_button:enabled]:pointer-events-auto",
              )}
              onPointerEnter={holdControlsVisible}
              onPointerLeave={scheduleControlsHide}
              onFocusCapture={holdControlsVisible}
              onBlurCapture={scheduleControlsHide}
            >
              <div
                className={cn(
                  "player-scrim-overlay-top flex min-w-0 items-center gap-2 bg-transparent text-white",
                  PLAYER_HUD_SURFACE_POSITION_CLASS,
                  PLAYER_HUD_SURFACE_TOP_CLASS,
                  compact ? "pb-1.5" : "pb-3",
                )}
              >
                <MediaButton
                  type="button"
                  aria-label={backLabel}
                  className={PLAYER_HUD_BUTTON_CLASS}
                  onClick={handleBack}
                >
                  <ChevronLeft
                    className={PLAYER_HUD_ICON_CLASS}
                    data-icon="inline-start"
                    aria-hidden
                  />
                </MediaButton>
                <MediaButton
                  type="button"
                  aria-label="返回 AcFun 首页"
                  title="返回 AcFun 首页"
                  className={PLAYER_HUD_BUTTON_CLASS}
                  onClick={onHome}
                >
                  <Home className={PLAYER_HUD_ICON_CLASS} data-icon="inline-start" aria-hidden />
                </MediaButton>
                <div className="flex h-media-control min-w-0 flex-1 items-center px-1">
                  <p className={cn("truncate leading-none", PLAYER_HUD_TITLE_CLASS)} title={title}>
                    {title}
                  </p>
                </div>
                <PlayerHudOverflowMenu
                  label="更多播放操作"
                  title="播放操作"
                  open={hudMenuOpen}
                  onOpenChange={setHudMenuOpen}
                  compact={compact}
                  portalContainer={fullscreen.fullscreen ? stageRef : undefined}
                >
                  <div className="grid grid-cols-2 gap-1.5 max-md:gap-2">
                    <PlayerToolTile
                      icon={Link2}
                      label="复制链接"
                      disabled={!originalUrl}
                      onClick={copyOriginalUrl}
                    />
                    <PlayerToolTile
                      icon={ExternalLink}
                      label="在浏览器中打开"
                      disabled={!originalUrl}
                      onClick={openOriginalUrl}
                    />
                  </div>
                </PlayerHudOverflowMenu>
              </div>
            </div>
          )}
        </div>
      </div>
    </VideoJsContainer>
  );
}

function AcfunPartList({
  parts,
  currentId,
  onChange,
}: {
  parts: readonly AcfunVideoPart[];
  currentId: string | null;
  onChange: (partId: string) => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const currentRowRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(() =>
    videoSelectionDefaultOpen("parts", { mobile: isMobileClient() }),
  );

  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    const row = currentRowRef.current;
    if (!list || !row) return;
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    list.scrollTop += rowRect.top - listRect.top - (list.clientHeight - rowRect.height) / 2;
  }, [currentId, open]);

  if (parts.length <= 1) return null;
  const currentIndex = parts.findIndex((part) => part.id === currentId);
  return (
    <VideoSelectionSection
      label="选集"
      count={videoSelectionCount(currentIndex, parts.length, "P")}
      open={open}
      onOpenChange={setOpen}
    >
      <div
        ref={listRef}
        data-video-selection-list="parts"
        className="max-h-64 overflow-y-auto overscroll-contain px-2 pt-1 pb-2 touch-pan-y"
      >
        {parts.map((part) => {
          const current = part.id === currentId;
          return (
            <VideoSelectionRow
              key={part.id}
              rowRef={current ? currentRowRef : undefined}
              current={current}
              label={`P${part.index}`}
              title={partLabel(part)}
              duration={formatVideoDuration(part.duration_sec)}
              onNavigate={() => onChange(part.id)}
            />
          );
        })}
      </div>
    </VideoSelectionSection>
  );
}

function AcfunVideoInfoCard({ detail }: { detail: AcfunVideoDetail }) {
  const item = detail.item;
  const descriptionId = useId();
  const [expanded, setExpanded] = useState(false);
  const description = detail.description.trim();
  const author = item.author.trim() || "未知作者";
  const hasDetail = description.length > 0 || detail.tags.length > 0;

  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      render={<section className="shrink-0" />}
      aria-label={`视频信息：${item.title}`}
    >
      <div className={VIDEO_DETAILS_INFO_CARD_CLASS}>
        <h1 className="sr-only">{item.title}</h1>
        <div className="flex min-w-0 items-start gap-2.5">
          <Avatar size="lg" className="size-10 ring-1 ring-border/80">
            <AvatarImage
              src={normalizeImageUrl(item.author_avatar)}
              alt={`${author} 的头像`}
              referrerPolicy="no-referrer"
            />
            <AvatarFallback className="font-medium">{Array.from(author)[0] ?? "?"}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm leading-5 font-semibold tracking-tight" title={author}>
              {author}
            </p>
          </div>
        </div>
        {hasDetail ? (
          <CollapsibleTrigger
            aria-controls={descriptionId}
            className="mt-1.5 flex min-h-6 w-full min-w-0 items-center text-left transition-opacity hover:opacity-80"
          >
            <span className="flex w-fit max-w-full min-w-0 items-end gap-1">
              <span
                className={cn(
                  "min-w-0 text-sm leading-5 font-medium tracking-tight",
                  expanded ? "break-words" : "truncate",
                )}
                title={expanded ? undefined : item.title}
              >
                {item.title}
              </span>
              <ChevronDown
                aria-hidden
                className={cn(
                  "mb-[3px] size-3.5 shrink-0 text-muted-foreground transition-transform",
                  expanded && "rotate-180",
                )}
              />
            </span>
          </CollapsibleTrigger>
        ) : (
          <p
            className="mt-1.5 flex min-h-6 items-center truncate text-sm leading-5 font-medium tracking-tight"
            title={item.title}
          >
            {item.title}
          </p>
        )}
        <dl className="mt-0.5 flex min-w-0 items-center gap-x-2 overflow-hidden text-[11px] leading-4 text-muted-foreground">
          <div
            className="flex min-w-0 shrink-[3] items-center gap-1"
            title={`播放：${formatOnline(item.play_count)}`}
          >
            <dt className="sr-only">播放</dt>
            <Play aria-hidden className="size-3 shrink-0" />
            <dd className="truncate tabular-nums">{formatOnline(item.play_count)}</dd>
          </div>
          {item.comment_count != null && (
            <div
              className="flex min-w-0 shrink-[3] items-center gap-1"
              title={`评论：${formatOnline(item.comment_count)}`}
            >
              <dt className="sr-only">评论</dt>
              <MessageCircle aria-hidden className="size-3 shrink-0" />
              <dd className="truncate tabular-nums">{formatOnline(item.comment_count)}</dd>
            </div>
          )}
          {item.published_at > 0 && (
            <div
              className="flex min-w-0 shrink-[0.5] items-center gap-1"
              title={`视频发布时间：${formatDateTime(item.published_at)}`}
            >
              <dt className="sr-only">发布时间</dt>
              <CalendarDays aria-hidden className="size-3 shrink-0" />
              <dd className="truncate tabular-nums">{formatDateTime(item.published_at)}</dd>
            </div>
          )}
        </dl>
        {hasDetail && (
          <CollapsibleContent
            id={descriptionId}
            keepMounted
            className={cn(
              "h-(--collapsible-panel-height) overflow-hidden",
              "transition-[height] duration-150 ease-[var(--motion-ease-out)]",
              "motion-reduce:transition-none",
              "data-starting-style:h-0 data-ending-style:h-0",
            )}
          >
            <div className="mt-2">
              {description && (
                <p className="whitespace-pre-line text-xs leading-relaxed text-muted-foreground">
                  {description}
                </p>
              )}
              {detail.tags.length > 0 && (
                <div
                  className={cn("flex flex-wrap gap-1.5", description && "mt-2")}
                  aria-label="视频 Tags"
                >
                  {detail.tags.map((tag) => (
                    <Badge key={tag} variant="outline">
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </CollapsibleContent>
        )}
      </div>
    </Collapsible>
  );
}

function AcfunSidebarSkeleton() {
  return (
    <div className={VIDEO_DETAILS_SIDEBAR_STACK_CLASS} aria-hidden>
      <section className="shrink-0">
        <div className={VIDEO_DETAILS_INFO_CARD_CLASS}>
          <div className="flex min-w-0 items-start gap-2.5">
            <Skeleton className="size-10 shrink-0 rounded-full ring-1 ring-border/80" />
            <div className="min-w-0 flex-1">
              <Skeleton className="h-5 w-32" />
            </div>
          </div>
          <Skeleton className="mt-1.5 h-6 w-4/5" />
          <div className="mt-0.5 flex items-center gap-x-2">
            <Skeleton className="h-4 w-12" />
            <Skeleton className="h-4 w-10" />
            <Skeleton className="h-4 w-24" />
          </div>
        </div>
      </section>
      <section className="shrink-0">
        <div className={cn("overflow-hidden", VIDEO_DETAILS_SIDEBAR_CARD_CLASS)}>
          <div className="flex items-center gap-2 px-3 py-2">
            <Skeleton className="size-3.5" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="ml-auto h-4 w-10" />
          </div>
          <div className="flex flex-col gap-1 px-2 pb-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        </div>
      </section>
    </div>
  );
}

function AcfunVideoDetails({
  detail,
  videoId,
  currentPartId,
  onPartChange,
}: {
  detail: AcfunVideoDetail;
  videoId: string;
  currentPartId: string | null;
  onPartChange: (partId: string) => void;
}) {
  const [tab, setTab] = useState<"details" | "comments">("details");

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        if (value === "details" || value === "comments") setTab(value);
      }}
      className="flex h-full min-h-0 flex-col gap-0"
    >
      <div className="flex h-11 shrink-0 items-center border-b border-border/80">
        <TabsList
          variant="line"
          className="h-11! min-w-0 flex-1 justify-start rounded-none bg-transparent px-2"
        >
          <TabsTrigger value="details" className="px-3 text-sm">
            详情
          </TabsTrigger>
          <TabsTrigger value="comments" className="px-3 text-sm">
            评论
            {detail.item.comment_count != null && detail.item.comment_count > 0 && (
              <span className="tabular-nums">{formatOnline(detail.item.comment_count)}</span>
            )}
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent
        value="details"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain touch-pan-y"
      >
        <div className={VIDEO_DETAILS_SIDEBAR_STACK_CLASS}>
          <AcfunVideoInfoCard detail={detail} />
          <AcfunPartList parts={detail.parts} currentId={currentPartId} onChange={onPartChange} />
        </div>
      </TabsContent>
      <TabsContent
        value="comments"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain touch-pan-y"
      >
        <AcfunVideoComments videoId={videoId} active={tab === "comments"} />
      </TabsContent>
    </Tabs>
  );
}

function AcfunStageBackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <MediaButton
      type="button"
      aria-label={label}
      className={PLAYER_HUD_BUTTON_CLASS}
      onClick={onClick}
    >
      <ChevronLeft className={PLAYER_HUD_ICON_CLASS} data-icon="inline-start" aria-hidden />
    </MediaButton>
  );
}

function AcfunStagePlaceholder({
  label,
  backLabel,
  onBack,
}: {
  label: string;
  backLabel: string;
  onBack: () => void;
}) {
  return (
    <PlayerStageSkeleton
      label={label}
      back={<AcfunStageBackButton label={backLabel} onClick={onBack} />}
    >
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <Spinner className="text-white" aria-label={label} />
      </div>
    </PlayerStageSkeleton>
  );
}

function AcfunStageError({
  error,
  title,
  backLabel,
  onBack,
  onRetry,
}: {
  error: unknown;
  title: string;
  backLabel: string;
  onBack: () => void;
  onRetry?: () => void;
}) {
  return (
    <PlayerStageSkeleton
      label={title}
      back={<AcfunStageBackButton label={backLabel} onClick={onBack} />}
    >
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        <ErrorState
          className="w-full max-w-xl bg-background"
          error={error}
          title={title}
          onRetry={onRetry}
        />
      </div>
    </PlayerStageSkeleton>
  );
}

export function AcfunVideoPage() {
  return (
    <VideoJsPlayerProvider>
      <AcfunVideoPageContent />
    </VideoJsPlayerProvider>
  );
}

function AcfunVideoPageContent() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const detailsFrameRef = useRef<HTMLElement | null>(null);
  const playbackSessions = useMemo(
    () => new AcfunPlaybackSessions((sessionId) => void acfunVideoStopPlay(sessionId)),
    [],
  );
  const activePlaybackKeyRef = useRef<string | null>(null);
  const playbackMountEpochRef = useRef(0);
  const queryMountEpochRef = useRef(0);
  const videoId = params.get("id")?.trim() ?? "";
  const requestedPartId = params.get("part");
  const [qualityState, setQualityState] = useState<{
    partId: string | null;
    quality: string | null;
  }>({ partId: null, quality: null });
  const [frameSize, setFrameSize] = useState<{
    key: string;
    ratio: number | null;
  } | null>(null);
  const [playerFullscreenOpen, setPlayerFullscreenOpen] = useState(false);

  const detailQuery = useQuery({
    queryKey: ["acfun_video_detail", videoId],
    queryFn: () => acfunVideoGetDetail(videoId),
    enabled: videoId.length > 0,
    staleTime: 5 * 60_000,
  });
  const detail = detailQuery.data;
  const effectivePartId =
    requestedPartId && detail?.parts.some((part) => part.id === requestedPartId)
      ? requestedPartId
      : (detail?.parts[0]?.id ?? null);
  const playbackKey = `${videoId}:${effectivePartId ?? ""}`;
  const [playbackState, setPlaybackState] = useState({
    key: playbackKey,
    time: 0,
    autoplay: true,
  });
  if (playbackState.key !== playbackKey) {
    setPlaybackState({ key: playbackKey, time: 0, autoplay: true });
  }

  if (qualityState.partId !== effectivePartId) {
    setQualityState({ partId: effectivePartId, quality: null });
  }
  const quality = qualityState.partId === effectivePartId ? qualityState.quality : null;

  const playQueryKey = useMemo(
    () => ["acfun_video_play", videoId, effectivePartId ?? "", quality ?? ""] as const,
    [effectivePartId, quality, videoId],
  );
  const playQuery = useQuery({
    queryKey: playQueryKey,
    queryFn: ({ signal }) =>
      playbackSessions.acquire(playbackKey, signal, () =>
        acfunVideoGetPlayInfo({
          videoId,
          partId: effectivePartId,
          quality,
        }),
      ),
    enabled: Boolean(detail && videoId),
    gcTime: 0,
    staleTime: 0,
    retry: 1,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const playResult = playQuery.data;
  const playInfo = playResult?.key === playbackKey ? playResult.info : undefined;
  const mobileClient = isMobileClient();
  const stackedDetails = useStackedDetailsViewport();
  const { ready: playerStartupReady, release: releasePlayerStartup } =
    usePlayerStartupGate(playbackKey);
  const frameAspectRatio = frameSize?.key === playbackKey ? frameSize.ratio : null;
  const detailsResizeEnabled =
    mobileClient &&
    stackedDetails &&
    !playerFullscreenOpen &&
    canResizeVideoDetails(frameAspectRatio);
  const detailsContentRef = useDetailsResize({
    enabled: detailsResizeEnabled,
    aspectRatio: frameAspectRatio,
    containerRef: detailsFrameRef,
    resetKey: playbackKey,
  });
  const secondaryReady = playerStartupReady || playQuery.isError || detailQuery.isError;

  useLayoutEffect(() => {
    const previous = activePlaybackKeyRef.current;
    if (previous !== null && previous !== playbackKey) playbackSessions.clear();
    activePlaybackKeyRef.current = playbackKey;
  }, [playbackKey, playbackSessions]);

  useLayoutEffect(() => {
    if (!playResult || playResult.key !== playbackKey) return;
    playbackSessions.retain(playResult);
  }, [playResult, playbackKey, playbackSessions]);

  useEffect(() => {
    playbackSessions.releasePrevious();
  }, [playResult, playbackSessions]);

  useEffect(() => {
    const epoch = ++playbackMountEpochRef.current;
    return () => {
      // StrictMode 会先重放 effect；微任务确认没有重新挂载后才释放当前代理。
      queueMicrotask(() => {
        // oxlint-disable-next-line react-hooks/exhaustive-deps
        if (playbackMountEpochRef.current === epoch) playbackSessions.clear();
      });
    };
  }, [playbackSessions]);

  useEffect(() => {
    const epoch = ++queryMountEpochRef.current;
    return () => {
      // 与新查询交接时由 QueryObserver 中止旧请求；这里兜底真正卸载。
      queueMicrotask(() => {
        // oxlint-disable-next-line react-hooks/exhaustive-deps
        if (queryMountEpochRef.current !== epoch) return;
        void queryClient.cancelQueries({ queryKey: playQueryKey, exact: true });
        queryClient.removeQueries({ queryKey: playQueryKey, exact: true });
      });
    };
  }, [playQueryKey, queryClient]);

  useEffect(() => {
    if (!detail || requestedPartId === effectivePartId || !effectivePartId) return;
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set("part", effectivePartId);
        return next;
      },
      { replace: true },
    );
  }, [detail, effectivePartId, requestedPartId, setParams]);

  const back = useCallback(() => {
    if (canNavigateBackInApp(window.history.state)) {
      navigate(-1);
      return;
    }
    navigate(acfunHomePath(), { replace: true });
  }, [navigate]);
  const home = useCallback(() => navigate(acfunHomePath()), [navigate]);
  const handleAspectRatioChange = useCallback(
    (ratio: number) => setFrameSize({ key: playbackKey, ratio }),
    [playbackKey],
  );
  const handleFullscreenChange = useCallback((fullscreen: boolean) => {
    setPlayerFullscreenOpen(fullscreen);
  }, []);
  const changePart = (partId: string) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set("part", partId);
        return next;
      },
      { replace: true },
    );
  };

  const originalUrl = videoId ? `https://www.acfun.cn/v/ac${encodeURIComponent(videoId)}` : "";
  const detailFailure = !videoId
    ? new Error("播放链接缺少视频 id")
    : !detailQuery.isLoading && (detailQuery.isError || !detail)
      ? (detailQuery.error ?? new Error("视频详情为空"))
      : null;
  const playFailure = detail && !playInfo && playQuery.isError ? playQuery.error : null;
  const retainedPlayFailure = playInfo && playQuery.isError ? playQuery.error : null;
  const stageStyle =
    frameAspectRatio && frameAspectRatio > 0
      ? ({ "--stage-ar": String(frameAspectRatio) } as CSSProperties)
      : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <main
        ref={detailsFrameRef}
        data-video-details-frame
        className="flex min-h-0 flex-1 flex-col bg-black lg:flex-row"
      >
        <div
          data-vod-details-stage
          style={stageStyle}
          className={cn(
            "relative flex min-w-0 flex-col bg-black",
            "h-auto w-full flex-none aspect-[var(--stage-ar,16/9)] max-lg:max-h-[70%]",
            "lg:aspect-auto lg:h-full lg:w-auto lg:min-h-0 lg:flex-1",
          )}
        >
          {detailFailure ? (
            <AcfunStageError
              error={detailFailure}
              title={videoId ? "视频加载失败" : "无法打开视频"}
              backLabel="返回 AcFun"
              onBack={back}
              onRetry={videoId ? () => void detailQuery.refetch() : undefined}
            />
          ) : playInfo && detail ? (
            <AcfunPlayerSurface
              detail={detail}
              info={playInfo}
              originalUrl={originalUrl}
              retainedError={retainedPlayFailure}
              onBack={back}
              onHome={home}
              onRetry={() => void playQuery.refetch()}
              onQualityChange={(nextQuality, playback) => {
                setPlaybackState({ key: playbackKey, ...playback });
                setQualityState({ partId: effectivePartId, quality: nextQuality });
              }}
              onStartupReady={releasePlayerStartup}
              onAspectRatioChange={handleAspectRatioChange}
              onFullscreenChange={handleFullscreenChange}
              initialPosition={playbackState.time}
              initialAutoplay={playbackState.autoplay}
            />
          ) : playFailure ? (
            <AcfunStageError
              error={playFailure}
              title="播放地址获取失败"
              backLabel="返回 AcFun"
              onBack={back}
              onRetry={() => void playQuery.refetch()}
            />
          ) : (
            <AcfunStagePlaceholder
              label={detailQuery.isLoading ? "正在加载 AcFun 视频" : "正在获取 AcFun 播放地址"}
              backLabel="返回 AcFun"
              onBack={back}
            />
          )}
        </div>

        <aside
          data-vod-details-aside
          tabIndex={-1}
          aria-label="AcFun 视频详情"
          className={cn(
            "relative isolate flex min-h-0 flex-1 flex-col border-t border-border/80 bg-sidebar max-md:pb-[env(safe-area-inset-bottom)]",
            "lg:w-[320px] lg:flex-none lg:border-t-0 lg:border-l xl:w-[340px] lg:pb-0",
          )}
        >
          <div ref={detailsContentRef} className="min-h-0 flex-1 overflow-hidden">
            {detail && secondaryReady ? (
              <AcfunVideoDetails
                key={videoId}
                detail={detail}
                videoId={videoId}
                currentPartId={effectivePartId}
                onPartChange={changePart}
              />
            ) : detailFailure ? null : (
              <AcfunSidebarSkeleton />
            )}
          </div>
        </aside>
      </main>

      {!mobileClient && !playerFullscreenOpen && (
        <footer className="hidden shrink-0 flex-wrap items-center justify-end gap-1.5 border-t border-border/80 bg-sidebar/90 px-3 pt-1.5 pb-[calc(0.375rem+env(safe-area-inset-bottom))] md:flex">
          <Button variant="ghost" size="sm" onClick={home}>
            <Home data-icon="inline-start" aria-hidden />
            AcFun 首页
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!originalUrl}
            onClick={() => copyAcfunOriginalUrl(originalUrl)}
          >
            <Link2 data-icon="inline-start" aria-hidden />
            复制链接
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!originalUrl}
            onClick={() => openAcfunOriginalUrl(originalUrl)}
          >
            <ExternalLink data-icon="inline-start" aria-hidden />
            在浏览器中打开
          </Button>
        </footer>
      )}
    </div>
  );
}
