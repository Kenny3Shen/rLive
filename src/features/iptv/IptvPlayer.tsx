import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AlertCircle, Radio, Tv } from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { getClientPlatform } from "@/shared/clientPlatform";
import { PlayerControls } from "@/shared/components/player/PlayerControls";
import { AudioOnlyIndicator } from "@/shared/components/player/AudioOnlyIndicator";
import { useCompactPlayerViewport } from "@/shared/hooks/usePlayerViewport";
import { requestPlayerAutoplay } from "@/features/room/player/autoplay";
import { useAndroidPlayerControls } from "@/features/room/player/androidPlayerControls";
import {
  useAndroidFullscreenOrientation,
  videoAspectRatio,
} from "@/features/room/player/androidOrientation";
import { createSerialTaskQueue } from "@/features/room/player/serialTaskQueue";
import {
  canUsePictureInPicture,
  exitPictureInPictureForVideo,
  fullscreenElementFor,
  getFullscreenDocument,
  getPictureInPictureDocument,
  isTauriDesktop,
  toggleElementFullscreen,
  toggleVideoPictureInPicture,
} from "@/features/room/player/useWebPlayer";
import {
  createXgPlayer,
  getXgMpegtsCore,
  loadXgPlayerModules,
  xgPlayerErrorMessage,
  type XgPlaybackKind,
  type XgPlayerInstance,
} from "@/features/room/player/xgPlayer";
import { useScreenWakeLock } from "@/shared/hooks/useScreenWakeLock";
import {
  createNativeFullscreenSession,
  restoreNativePlayerMaximizedState,
  setNativePlayerFullscreen,
  toggleNativePlayerFullscreen,
} from "@/shared/nativePlayerFullscreen";
import { cn } from "@/lib/utils";
import type { IptvChannel } from "./types";

export type IptvPlaybackStatus = "idle" | "connecting" | "ready" | "playing" | "error";

const AUTO_RECONNECT_MAX_ATTEMPTS = 2;
const AUTO_RECONNECT_DELAYS_MS = [1_000, 2_500] as const;
const CONTROLS_HIDE_DELAY_MS = 2_600;

// The localhost stream proxy is application-global. This queue keeps channel
// changes orderly within the IPTV page; each proxy session additionally has a
// unique owner ID so an old cleanup cannot stop a newer source.
const proxyQueue = createSerialTaskQueue();
let playerInstanceSequence = 0;
const EMPTY_HEADERS: Record<string, string> = {};

function nextPlayerId(): string {
  playerInstanceSequence = (playerInstanceSequence + 1) % Number.MAX_SAFE_INTEGER;
  const entropy = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `iptv-player-${entropy}-${playerInstanceSequence}`;
}

function isFlvStream(url: string): boolean {
  return /\.flv(?:[?#]|$)/i.test(url) || /[?&](?:format|type)=flv(?:[&#]|$)/i.test(url);
}

function isMpegTransportStream(url: string): boolean {
  return (
    /\.(?:ts|m2ts)(?:[?#]|$)/i.test(url) || /[?&](?:format|type)=(?:ts|mpegts)(?:[&#]|$)/i.test(url)
  );
}

function isProgressiveVideo(url: string): boolean {
  return /\.(?:mp4|m4v|webm|mov)(?:[?#]|$)/i.test(url);
}

function isPlayerInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      'button, input, select, textarea, [role="button"], [role="combobox"], [role="slider"], [contenteditable="true"]',
    ),
  );
}

export function iptvPlaybackKind(
  source: string | Pick<IptvChannel, "url" | "protocol">,
): XgPlaybackKind {
  const url = typeof source === "string" ? source : source.url;
  const protocol = typeof source === "string" ? undefined : source.protocol;
  if (protocol === "flv" || protocol === "hls" || protocol === "native") return protocol;
  if (protocol === "mpeg_ts") return "mpegts";
  if (isFlvStream(url)) return "flv";
  if (isMpegTransportStream(url)) return "mpegts";
  if (isProgressiveVideo(url)) return "native";
  return "hls";
}

type IptvPlayerProps = {
  channel: IptvChannel | null;
  reloadToken: number;
  onStatusChange?: (status: IptvPlaybackStatus, error: string | null) => void;
  onReconnect?: () => void;
};

/**
 * IPTV playback shares the xgplayer protocol plugins used by live rooms. The
 * local proxy rewrites nested HLS resources and supplies remote headers.
 */
export function IptvPlayer({ channel, reloadToken, onStatusChange, onReconnect }: IptvPlayerProps) {
  const channelId = channel?.id ?? null;
  const channelUrl = channel?.url ?? null;
  const channelProtocol = channel?.protocol;
  const channelHeaders = channel?.headers ?? EMPTY_HEADERS;
  const stageRef = useRef<HTMLDivElement | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const controlsVisibleRef = useRef(true);
  const playerRootRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerRef = useRef<XgPlayerInstance | null>(null);
  const instanceIdRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const controlsHideTimerRef = useRef<number | null>(null);
  const previousVolumeRef = useRef(80);
  const retryAttemptRef = useRef(0);
  const autoReconnectRef = useRef<(message: string) => void>(() => {});
  const nativeFullscreenSessionRef = useRef(createNativeFullscreenSession());
  const [reconnectToken, setReconnectToken] = useState(0);
  const [status, setStatus] = useState<IptvPlaybackStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [mediaAvailable, setMediaAvailable] = useState(false);
  const [paused, setPaused] = useState(true);
  const [volume, setVolume] = useState(80);
  const [muted, setMuted] = useState(false);
  const [audioOnly, setAudioOnly] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);
  const [pictureInPictureSupported, setPictureInPictureSupported] = useState(false);
  const [pictureInPictureActive, setPictureInPictureActive] = useState(false);
  const [aspectRatio, setAspectRatio] = useState<number | null>(null);
  const [controlsInteractionOpen, setControlsInteractionOpen] = useState(false);
  const compactViewport = useCompactPlayerViewport();
  const androidClient = getClientPlatform() === "android";
  const androidPlayerControls = useAndroidPlayerControls(androidClient);
  const nativePlayerControlsActive = androidClient && androidPlayerControls.supported;
  const playerControlVolume = nativePlayerControlsActive
    ? (androidPlayerControls.state?.mediaVolume ?? volume)
    : volume;
  const playerControlMuted = nativePlayerControlsActive
    ? (androidPlayerControls.state?.mediaVolume ?? volume) <= 0
    : muted;
  useScreenWakeLock(status === "playing" && !audioOnly);
  useAndroidFullscreenOrientation({
    enabled: androidClient,
    fullscreen,
    aspectRatio,
  });

  if (instanceIdRef.current === null) {
    instanceIdRef.current = nextPlayerId();
  }

  useEffect(() => {
    retryAttemptRef.current = 0;
  }, [channelId, channelUrl]);

  // A manual retry starts a fresh retry budget. Automatic retries use a
  // separate token and therefore keep their finite attempt count.
  useEffect(() => {
    retryAttemptRef.current = 0;
  }, [reloadToken]);

  useEffect(() => {
    onStatusChange?.(status, error);
  }, [error, onStatusChange, status]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = nativePlayerControlsActive ? 1 : Math.max(0, Math.min(1, volume / 100));
    video.muted = nativePlayerControlsActive ? false : muted;
  }, [muted, nativePlayerControlsActive, volume]);

  useEffect(() => {
    if (!audioOnly) return;
    void exitPictureInPictureForVideo(getPictureInPictureDocument(), videoRef.current);
  }, [audioOnly]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const pictureInPictureDocument = getPictureInPictureDocument();
    const syncPictureInPicture = () => {
      if (canUsePictureInPicture(pictureInPictureDocument, video)) {
        setPictureInPictureSupported(true);
      }
      setPictureInPictureActive(pictureInPictureDocument?.pictureInPictureElement === video);
    };
    syncPictureInPicture();
    video.addEventListener("enterpictureinpicture", syncPictureInPicture);
    video.addEventListener("leavepictureinpicture", syncPictureInPicture);
    return () => {
      video.removeEventListener("enterpictureinpicture", syncPictureInPicture);
      video.removeEventListener("leavepictureinpicture", syncPictureInPicture);
    };
  }, []);

  useEffect(() => {
    const syncFullscreen = () => {
      const stage = stageRef.current;
      const active = fullscreenElementFor(getFullscreenDocument());
      setFullscreen(Boolean(active && stage && (active === stage || stage.contains(active))));
    };
    syncFullscreen();
    document.addEventListener("fullscreenchange", syncFullscreen);
    document.addEventListener("webkitfullscreenchange", syncFullscreen);
    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreen);
      document.removeEventListener("webkitfullscreenchange", syncFullscreen);
    };
  }, []);

  useEffect(() => {
    if (!isTauriDesktop()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const appWindow = getCurrentWindow();
        const syncFullscreen = async () => {
          try {
            const active = await appWindow.isFullscreen();
            if (!active) {
              await restoreNativePlayerMaximizedState(
                appWindow,
                nativeFullscreenSessionRef.current,
              );
            }
            if (!disposed) setFullscreen(active);
          } catch {
            // The native window can be mid-teardown during route navigation.
          }
        };
        await syncFullscreen();
        unlisten = await appWindow.onResized(() => void syncFullscreen());
      } catch {
        // Browser previews use the HTML fullscreen path above.
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const clearControlsHideTimer = useCallback(() => {
    if (controlsHideTimerRef.current === null) return;
    window.clearTimeout(controlsHideTimerRef.current);
    controlsHideTimerRef.current = null;
  }, []);

  const setControlVisibility = useCallback((visible: boolean) => {
    if (controlsVisibleRef.current === visible) return;
    controlsVisibleRef.current = visible;

    // Keep control chrome state out of React's media subtree so showing or
    // hiding it cannot compete with video decoding on the transition frame.
    const controls = controlsRef.current;
    if (!controls) return;
    controls.dataset.visible = visible ? "true" : "false";
    controls.setAttribute("aria-hidden", String(!visible));
    controls.toggleAttribute("inert", !visible);
  }, []);

  const scheduleControlsHide = useCallback(() => {
    clearControlsHideTimer();
    setControlVisibility(true);
    if (status !== "playing" || paused || controlsInteractionOpen) return;
    controlsHideTimerRef.current = window.setTimeout(() => {
      controlsHideTimerRef.current = null;
      setControlVisibility(false);
    }, CONTROLS_HIDE_DELAY_MS);
  }, [clearControlsHideTimer, controlsInteractionOpen, paused, setControlVisibility, status]);

  const holdControlsVisible = useCallback(() => {
    clearControlsHideTimer();
    setControlVisibility(true);
  }, [clearControlsHideTimer, setControlVisibility]);

  useEffect(() => {
    scheduleControlsHide();
    return clearControlsHideTimer;
  }, [clearControlsHideTimer, scheduleControlsHide]);

  const togglePause = useCallback(() => {
    const video = videoRef.current;
    const player = playerRef.current;
    if (!video || !player) return;
    if (video.paused) {
      try {
        const pending = player.play();
        if (pending) {
          void pending.catch((cause) => {
            setError(xgPlayerErrorMessage(cause, "无法开始播放"));
          });
        }
      } catch (cause) {
        setError(xgPlayerErrorMessage(cause, "无法开始播放"));
      }
      return;
    }
    player.pause();
  }, []);

  const changeVolume = useCallback((value: number) => {
    const next = Math.max(0, Math.min(100, Math.round(value)));
    if (next > 0) previousVolumeRef.current = next;
    setVolume(next);
    setMuted(next === 0);
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((currentMuted) => {
      if (currentMuted || volume === 0) {
        const restored = previousVolumeRef.current || 80;
        setVolume(restored);
        return false;
      }
      previousVolumeRef.current = volume;
      return true;
    });
  }, [volume]);

  const togglePictureInPicture = useCallback(async () => {
    const video = videoRef.current;
    const pictureInPictureDocument = getPictureInPictureDocument();
    if (!video || !canUsePictureInPicture(pictureInPictureDocument, video)) return;
    const changed = await toggleVideoPictureInPicture(pictureInPictureDocument, video);
    if (changed) {
      setPictureInPictureActive(pictureInPictureDocument?.pictureInPictureElement === video);
    }
  }, []);

  const toggleFullscreen = useCallback(async () => {
    if (isTauriDesktop()) {
      try {
        const appWindow = getCurrentWindow();
        const next = await toggleNativePlayerFullscreen(
          appWindow,
          nativeFullscreenSessionRef.current,
        );
        setFullscreen(next);
        setFullscreenError(null);
      } catch (cause) {
        setFullscreenError(xgPlayerErrorMessage(cause, "全屏切换失败"));
      }
      return;
    }

    try {
      const toggled = await toggleElementFullscreen(getFullscreenDocument(), stageRef.current);
      setFullscreenError(toggled ? null : "当前设备不支持全屏播放");
    } catch (cause) {
      setFullscreenError(xgPlayerErrorMessage(cause, "全屏切换失败"));
    }
  }, []);

  useEffect(() => {
    if (!fullscreen) return;
    const exitNativeFullscreen = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !isTauriDesktop()) return;
      void (async () => {
        try {
          const appWindow = getCurrentWindow();
          if (await appWindow.isFullscreen()) {
            await setNativePlayerFullscreen(appWindow, false, nativeFullscreenSessionRef.current);
          }
          setFullscreen(false);
        } catch {
          // The platform shortcut can still leave fullscreen on its own.
        }
      })();
    };
    window.addEventListener("keydown", exitNativeFullscreen);
    return () => window.removeEventListener("keydown", exitNativeFullscreen);
  }, [fullscreen]);

  const handleStageKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.nativeEvent.isComposing ||
        isPlayerInteractiveTarget(event.target)
      ) {
        return;
      }

      if (event.key === "Tab") {
        if (event.shiftKey) return;
        const firstControl =
          controlsRef.current?.querySelector<HTMLElement>("button:not(:disabled)");
        if (!firstControl) return;
        event.preventDefault();
        holdControlsVisible();
        window.requestAnimationFrame(() => {
          firstControl.focus({ preventScroll: true });
        });
        return;
      }

      if (event.repeat) return;
      const key = event.key.toLowerCase();
      if (key !== " " && key !== "k" && key !== "m" && key !== "f") return;
      event.preventDefault();
      scheduleControlsHide();
      if (key === " " || key === "k") togglePause();
      else if (key === "m") {
        if (nativePlayerControlsActive) androidPlayerControls.toggleMediaMute();
        else toggleMute();
      } else {
        void toggleFullscreen();
      }
    },
    [
      androidPlayerControls,
      holdControlsVisible,
      nativePlayerControlsActive,
      scheduleControlsHide,
      toggleFullscreen,
      toggleMute,
      togglePause,
    ],
  );

  const handleControlsInteractionChange = useCallback(
    (open: boolean) => {
      setControlsInteractionOpen(open);
      if (open) holdControlsVisible();
    },
    [holdControlsVisible],
  );

  useEffect(() => {
    let disposed = false;
    const generation = ++generationRef.current;
    const sessionId = `${instanceIdRef.current}:${generation}`;

    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }

    const destroyMedia = () => {
      const video = videoRef.current;
      const muted = video?.muted ?? false;
      const volume = video?.volume ?? 1;
      void exitPictureInPictureForVideo(getPictureInPictureDocument(), video);
      if (!disposed) {
        setMediaAvailable(false);
        setPictureInPictureActive(false);
        setPaused(true);
        setAspectRatio(null);
      }
      const player = playerRef.current;
      playerRef.current = null;
      if (player) {
        try {
          player.pause();
        } catch {
          // Playback can already be detached during a channel switch.
        }
        try {
          player.destroy();
        } catch {
          // A partly initialized protocol plugin is still safe to discard.
        }
      }

      if (video) {
        try {
          video.pause();
          video.removeAttribute("src");
          video.srcObject = null;
          video.load();
          video.muted = muted;
          video.volume = volume;
        } catch {
          // The element can already be detached while React is unmounting.
        }
      }
    };

    const stopProxy = async () => {
      try {
        await invokeCmd<void>("stream_proxy_stop", { sessionId });
      } catch {
        // Stop is ownership-aware; an old source can safely finish after a new one.
      }
    };

    const finishWithError = (message: string) => {
      if (disposed || generationRef.current !== generation) return;
      setStatus("error");
      setError(message);
    };

    const scheduleAutoReconnect = (message: string) => {
      if (disposed || generationRef.current !== generation || retryTimerRef.current !== null) {
        return;
      }
      const attempt = retryAttemptRef.current + 1;
      if (attempt > AUTO_RECONNECT_MAX_ATTEMPTS) {
        finishWithError(`${message}，自动重连失败，请手动重连`);
        return;
      }

      retryAttemptRef.current = attempt;
      setStatus("connecting");
      setError(`${message}，正在自动重连（${attempt}/${AUTO_RECONNECT_MAX_ATTEMPTS}）…`);
      // Reserve the retry slot before tearing down the media element. Calling
      // video.load() can synchronously emit another error event, which should
      // not consume a second attempt while this retry is already queued.
      retryTimerRef.current = 0;
      destroyMedia();
      void proxyQueue.enqueue(stopProxy).then(
        () => {
          if (disposed || generationRef.current !== generation) return;
          retryTimerRef.current = window.setTimeout(
            () => {
              retryTimerRef.current = null;
              if (!disposed && generationRef.current === generation) {
                setReconnectToken((token) => token + 1);
              }
            },
            AUTO_RECONNECT_DELAYS_MS[attempt - 1] ?? AUTO_RECONNECT_DELAYS_MS.at(-1)!,
          );
        },
        () => {
          if (disposed || generationRef.current !== generation) return;
          retryTimerRef.current = window.setTimeout(
            () => {
              retryTimerRef.current = null;
              if (!disposed && generationRef.current === generation) {
                setReconnectToken((token) => token + 1);
              }
            },
            AUTO_RECONNECT_DELAYS_MS[attempt - 1] ?? AUTO_RECONNECT_DELAYS_MS.at(-1)!,
          );
        },
      );
    };
    autoReconnectRef.current = scheduleAutoReconnect;

    if (!channelUrl) {
      destroyMedia();
      retryAttemptRef.current = 0;
      setStatus("idle");
      setError(null);
      void proxyQueue.enqueue(stopProxy);
      return () => {
        disposed = true;
        destroyMedia();
        void proxyQueue.enqueue(stopProxy);
      };
    }

    setMediaAvailable(false);
    setPaused(true);
    setStatus("connecting");
    setError(null);
    const playbackKind = iptvPlaybackKind({ url: channelUrl, protocol: channelProtocol });
    const xgModulesPromise = loadXgPlayerModules(playbackKind);
    void xgModulesPromise.catch(() => {});

    void proxyQueue
      .enqueue(async () => {
        if (disposed || generationRef.current !== generation) {
          await stopProxy();
          return;
        }

        try {
          destroyMedia();
          const localUrl = await invokeCmd<string>("stream_proxy_start", {
            url: channelUrl,
            headers: channelHeaders,
            sessionId,
            hls: playbackKind === "hls",
          });
          if (disposed || generationRef.current !== generation) {
            await stopProxy();
            return;
          }

          const video = videoRef.current;
          const playerRoot = playerRootRef.current;
          if (!video || !playerRoot) throw new Error("播放器尚未准备好");
          const playbackUrl = `${localUrl}?t=${Date.now()}_${generation}`;
          const startPlayback = (player: XgPlayerInstance) => {
            if (disposed || generationRef.current !== generation) return;
            const isCurrentPlayer = () =>
              !disposed && generationRef.current === generation && playerRef.current === player;
            const markPlaying = () => {
              if (!isCurrentPlayer()) return;
              retryAttemptRef.current = 0;
              setError(null);
              setStatus("playing");
            };
            requestPlayerAutoplay(player, video, isCurrentPlayer, () => {}, markPlaying);
          };
          const reportError = (message: string) => {
            if (disposed || generationRef.current !== generation) return;
            scheduleAutoReconnect(message);
          };

          const modules = await xgModulesPromise;
          if (disposed || generationRef.current !== generation) {
            await stopProxy();
            return;
          }
          const player = createXgPlayer(modules, {
            root: playerRoot,
            video,
            url: playbackUrl,
            kind: playbackKind,
            isLive: playbackKind !== "native",
            hls: {
              hlsOpts: {
                lowLatencyMode: false,
                backBufferLength: 30,
                maxBufferLength: 30,
                liveSyncDurationCount: 3,
                liveMaxLatencyDurationCount: 6,
                manifestLoadingMaxRetry: 3,
                levelLoadingMaxRetry: 3,
                fragLoadingMaxRetry: 3,
              },
            },
            flv: {
              mediaDataSource: {
                type: "flv",
                isLive: true,
                hasAudio: true,
                hasVideo: true,
              },
              mpegtsConfig: {
                enableWorker: false,
                enableStashBuffer: true,
                stashInitialSize: 384,
                liveBufferLatencyChasing: true,
                liveBufferLatencyMaxLatency: 3,
                liveBufferLatencyMinRemain: 0.5,
                autoCleanupSourceBuffer: true,
              },
            },
            mpegts: {
              mediaDataSource: {
                type: "mpegts",
                isLive: true,
                hasAudio: true,
                hasVideo: true,
              },
              mpegtsConfig: {
                enableWorker: false,
                enableStashBuffer: true,
                stashInitialSize: 384,
                liveBufferLatencyChasing: true,
                liveBufferLatencyMaxLatency: 3,
                liveBufferLatencyMinRemain: 0.5,
                autoCleanupSourceBuffer: true,
              },
            },
          });
          playerRef.current = player;
          setMediaAvailable(true);
          const reportXgError = (cause: unknown) => {
            if (playerRef.current !== player) return;
            const fallback =
              playbackKind === "hls" ? "该频道的 HLS 流播放失败" : "该频道的视频流播放失败";
            reportError(xgPlayerErrorMessage(cause, fallback));
          };
          player.on("error", reportXgError);
          if (playbackKind === "flv" || playbackKind === "mpegts") {
            player.on("mpegts_error", reportXgError);
            getXgMpegtsCore(player)?.on("loading_complete", () => {
              if (playerRef.current === player) reportError("直播流已结束");
            });
          }
          if (playbackKind === "hls") {
            let fatalFailureCount = 0;
            player.on("playing", () => {
              if (playerRef.current === player) fatalFailureCount = 0;
            });
            player.on("HLS_ERROR", (cause) => {
              if (playerRef.current !== player || !cause || typeof cause !== "object") return;
              const event = cause as { errorType?: unknown; errorFatal?: unknown };
              if (event.errorFatal !== true) return;
              const type = String(event.errorType ?? "").toLowerCase();
              if (type !== "networkerror" && type !== "mediaerror") return;
              // HlsJsPlugin performs one immediate in-place recovery.
              if (++fatalFailureCount > 1) {
                window.setTimeout(() => reportXgError(event), 0);
              }
            });
          }
          startPlayback(player);
        } catch (cause) {
          if (disposed || generationRef.current !== generation) return;
          const message =
            cause instanceof Error ? cause.message : "频道播放初始化失败，请切换线路或重试";
          scheduleAutoReconnect(message);
          destroyMedia();
          await stopProxy();
        }
      })
      .catch(() => {
        // All actionable errors are reflected in the player surface above.
      });

    return () => {
      disposed = true;
      autoReconnectRef.current = () => {};
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      destroyMedia();
      void proxyQueue.enqueue(stopProxy);
    };
  }, [channelHeaders, channelId, channelProtocol, channelUrl, reconnectToken, reloadToken]);

  const statusText: Record<IptvPlaybackStatus, string> = {
    idle: "选择一个频道开始观看",
    connecting: "正在连接频道…",
    ready: "频道已就绪，点击播放按钮开始",
    playing: "正在播放",
    error: "播放失败",
  };

  return (
    <section className="relative w-full overflow-hidden rounded-2xl border border-border-subtle bg-black shadow-sm">
      <div
        ref={stageRef}
        data-player-stage
        data-iptv-player-stage
        data-fullscreen={fullscreen ? "true" : undefined}
        data-audio-only={audioOnly ? "true" : undefined}
        tabIndex={0}
        aria-label={channel ? `${channel.name} 播放器` : "IPTV 播放器"}
        aria-keyshortcuts="Space K M F"
        className="relative aspect-video bg-muted/20 outline-none"
        onKeyDown={handleStageKeyDown}
        onPointerMove={scheduleControlsHide}
        onPointerDown={(event) => {
          if (isPlayerInteractiveTarget(event.target)) return;
          event.currentTarget.focus({ preventScroll: true });
          scheduleControlsHide();
        }}
        onDoubleClick={(event) => {
          if (isPlayerInteractiveTarget(event.target)) return;
          void toggleFullscreen();
        }}
      >
        <div
          ref={playerRootRef}
          data-player-engine-root
          aria-hidden={audioOnly}
          className={cn(
            "absolute inset-0 size-full overflow-hidden bg-black",
            audioOnly && "invisible",
          )}
        >
          <video
            ref={videoRef}
            data-player-video
            playsInline
            tabIndex={-1}
            disablePictureInPicture={audioOnly}
            className="absolute inset-0 size-full bg-black object-contain"
            onPlay={() => setPaused(false)}
            onPlaying={() => {
              retryAttemptRef.current = 0;
              setError(null);
              setStatus("playing");
              setPaused(false);
            }}
            onPause={() => {
              setPaused(true);
              setStatus((current) => (current === "playing" ? "ready" : current));
            }}
            onWaiting={() =>
              setStatus((current) => (current === "playing" ? "connecting" : current))
            }
            onCanPlay={(event) => {
              setPaused(event.currentTarget.paused);
              setStatus((current) => (current === "connecting" ? "ready" : current));
            }}
            onLoadedMetadata={(event) => setAspectRatio(videoAspectRatio(event.currentTarget))}
            onResize={(event) => setAspectRatio(videoAspectRatio(event.currentTarget))}
            onVolumeChange={(event) => {
              if (nativePlayerControlsActive) return;
              const video = event.currentTarget;
              const nextVolume = Math.round(video.volume * 100);
              setVolume(nextVolume);
              setMuted(video.muted || nextVolume === 0);
              if (nextVolume > 0) previousVolumeRef.current = nextVolume;
            }}
            onError={() => {
              autoReconnectRef.current("浏览器无法解码此频道流");
            }}
          />
        </div>

        {channel && audioOnly && status === "playing" && <AudioOnlyIndicator />}

        {!channel && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
            <Tv className="size-8" aria-hidden />
            <p className="text-sm">从右侧频道列表选择节目</p>
          </div>
        )}

        {channel && status !== "playing" && status !== "error" && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/30 text-primary-foreground">
            {status === "connecting" && <Spinner className="size-5" aria-label="正在连接" />}
            <p className="text-sm">{statusText[status]}</p>
          </div>
        )}

        {error && (
          <div className="absolute right-3 bottom-16 left-3 z-20 flex items-start gap-2 rounded-lg bg-background/90 p-3 text-sm text-foreground shadow-lg backdrop-blur">
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
            <p>{error}</p>
          </div>
        )}

        {channel && (
          <div className="pointer-events-none absolute top-3 left-3 z-20 flex items-center gap-2">
            <Badge
              variant="destructive"
              className="gap-1.5 bg-destructive text-destructive-foreground"
            >
              <Radio data-icon="inline-start" aria-hidden />
              直播
            </Badge>
            <span className="max-w-[18rem] truncate rounded-md bg-black/55 px-2 py-1 text-xs text-primary-foreground backdrop-blur">
              {channel.name}
            </span>
          </div>
        )}

        <div
          ref={controlsRef}
          data-player-controls
          data-visible="true"
          aria-hidden="false"
          className="absolute inset-x-0 bottom-0 z-30 [will-change:opacity] transition-opacity duration-150 ease-out motion-reduce:transition-none data-[visible=false]:pointer-events-none data-[visible=false]:opacity-0"
          onPointerEnter={holdControlsVisible}
          onPointerMove={(event) => {
            event.stopPropagation();
            holdControlsVisible();
          }}
          onPointerDown={(event) => {
            event.stopPropagation();
            holdControlsVisible();
          }}
          onPointerLeave={scheduleControlsHide}
          onFocusCapture={holdControlsVisible}
          onBlurCapture={(event) => {
            const nextFocused = event.relatedTarget;
            if (nextFocused instanceof Node && event.currentTarget.contains(nextFocused)) return;
            scheduleControlsHide();
          }}
        >
          <PlayerControls
            paused={paused}
            volume={playerControlVolume}
            muted={playerControlMuted}
            audioOnly={audioOnly}
            fullscreen={fullscreen}
            pictureInPictureSupported={pictureInPictureSupported}
            pictureInPictureActive={pictureInPictureActive}
            pictureInPictureDisabled={status !== "playing" || fullscreen || audioOnly}
            disabled={!channel || !mediaAvailable || status === "error"}
            overlay
            compact={compactViewport}
            portalContainer={stageRef}
            onOverlayInteractionChange={handleControlsInteractionChange}
            refreshDisabled={!channel || status === "connecting"}
            loadError={fullscreenError}
            onRefresh={onReconnect}
            onTogglePause={togglePause}
            onVolume={(value) => {
              if (nativePlayerControlsActive) {
                androidPlayerControls.setMediaVolume(value);
                return;
              }
              changeVolume(value);
            }}
            onToggleMute={() => {
              if (nativePlayerControlsActive) {
                androidPlayerControls.toggleMediaMute();
                return;
              }
              toggleMute();
            }}
            onToggleAudioOnly={() => setAudioOnly((current) => !current)}
            onTogglePictureInPicture={() => void togglePictureInPicture()}
            onToggleFullscreen={() => void toggleFullscreen()}
          />
        </div>
      </div>
    </section>
  );
}
