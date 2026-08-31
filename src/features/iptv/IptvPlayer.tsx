import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { AlertCircle, ChevronLeft, Radio, Tv } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { getClientPlatform } from "@/shared/clientPlatform";
import { AudioOnlyIndicator } from "@/shared/components/player/AudioOnlyIndicator";
import {
  PLAYER_CONTROL_BUTTON_CLASS,
  PLAYER_CONTROL_ICON_CLASS,
  PLAYER_OVERLAY_CONTROL_BUTTON_CLASS,
  PlayerControls,
} from "@/shared/components/player/PlayerControls";
import { useCompactPlayerViewport } from "@/shared/hooks/usePlayerViewport";
import { useScreenWakeLock } from "@/shared/hooks/useScreenWakeLock";
import type { PlayUrl } from "@/shared/types/live";
import type { PlayerEvent } from "@/shared/types/player";
import { cn } from "@/lib/utils";
import { useAndroidFullscreenOrientation } from "@/features/room/player/androidOrientation";
import { useAndroidPlayerControls } from "@/features/room/player/androidPlayerControls";
import {
  IPTV_MEDIA_LIFECYCLE_PROFILE,
  useMediaLifecycle,
} from "@/features/room/player/useWebPlayer";
import type { XgPlaybackKind } from "@/features/room/player/xgPlayer";
import type { IptvChannel } from "./types";

export type IptvPlaybackStatus = "idle" | "connecting" | "ready" | "playing" | "error";

export const IPTV_AUTO_RECONNECT_MAX_ATTEMPTS = 2;
export const IPTV_AUTO_RECONNECT_DELAYS_MS = [1_000, 2_500] as const;
const CONTROLS_HIDE_DELAY_MS = 2_600;
export type IptvReconnectAction =
  | { type: "retry"; attempt: number; delayMs: number }
  | { type: "fail" };

export function nextIptvReconnectAction(completedAttempts: number): IptvReconnectAction {
  const attempt = Math.max(0, Math.floor(completedAttempts)) + 1;
  if (attempt > IPTV_AUTO_RECONNECT_MAX_ATTEMPTS) return { type: "fail" };
  return {
    type: "retry",
    attempt,
    delayMs: IPTV_AUTO_RECONNECT_DELAYS_MS[attempt - 1] ?? IPTV_AUTO_RECONNECT_DELAYS_MS.at(-1)!,
  };
}

export function iptvLifecycleReloadToken(
  manualReloadToken: number,
  automaticReconnectToken: number,
): string {
  return `${manualReloadToken}:${automaticReconnectToken}`;
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

export function iptvChannelPlayUrl(channel: IptvChannel): PlayUrl {
  const playbackKind = iptvPlaybackKind(channel);
  return {
    source_id: `iptv:${channel.id}`,
    label: channel.name,
    protocol: playbackKind === "mpegts" ? "mpeg_ts" : playbackKind,
    priority: 0,
    url: channel.url,
    headers: channel.headers,
  };
}

type IptvPlayerProps = {
  channel: IptvChannel | null;
  reloadToken: number;
  onStatusChange?: (status: IptvPlaybackStatus, error: string | null) => void;
  onReconnect?: () => void;
};

/** 共享浏览器媒体生命周期模块的 IPTV 页面适配器。 */
export function IptvPlayer({ channel, reloadToken, onStatusChange, onReconnect }: IptvPlayerProps) {
  const channelId = channel?.id ?? null;
  const channelUrl = channel?.url ?? null;
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const hudRef = useRef<HTMLDivElement | null>(null);
  const controlsVisibleRef = useRef(true);
  const retryTimerRef = useRef<number | null>(null);
  const controlsHideTimerRef = useRef<number | null>(null);
  const retryAttemptRef = useRef(0);
  const [reconnectToken, setReconnectToken] = useState(0);
  const [transportEnabled, setTransportEnabled] = useState(true);
  const [status, setStatus] = useState<IptvPlaybackStatus>(channel ? "connecting" : "idle");
  const [error, setError] = useState<string | null>(null);
  const [audioOnly, setAudioOnly] = useState(false);
  const [controlsInteractionOpen, setControlsInteractionOpen] = useState(false);
  const compactViewport = useCompactPlayerViewport();
  const androidClient = getClientPlatform() === "android";

  const playUrl = useMemo<PlayUrl | null>(() => {
    return channel ? iptvChannelPlayUrl(channel) : null;
  }, [channel]);

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current === null) return;
    window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
  }, []);

  const handleMediaFailure = useCallback((event: PlayerEvent) => {
    if (retryTimerRef.current !== null) return;
    const message =
      event.message?.trim() ||
      (event.protocol === "hls" ? "该频道的 HLS 流播放失败" : "该频道的视频流播放失败");
    const action = nextIptvReconnectAction(retryAttemptRef.current);
    if (action.type === "fail") {
      setStatus("error");
      setError(`${message}，自动重连失败，请手动重连`);
      return;
    }

    retryAttemptRef.current = action.attempt;
    setTransportEnabled(false);
    setStatus("connecting");
    setError(`${message}，正在自动重连（${action.attempt}/${IPTV_AUTO_RECONNECT_MAX_ATTEMPTS}）…`);
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      setTransportEnabled(true);
      setReconnectToken((token) => token + 1);
    }, action.delayMs);
  }, []);

  const handlePlaying = useCallback(() => {
    clearRetryTimer();
    retryAttemptRef.current = 0;
    setError(null);
    setStatus("playing");
  }, [clearRetryTimer]);

  const handleReady = useCallback(() => {
    setStatus((current) => (current === "connecting" ? "ready" : current));
  }, []);

  const handleWaiting = useCallback(() => {
    setStatus((current) => (current === "playing" ? "connecting" : current));
  }, []);

  const handlePause = useCallback(() => {
    setStatus((current) => (current === "playing" ? "ready" : current));
  }, []);

  const player = useMediaLifecycle({
    playUrl: transportEnabled ? playUrl : null,
    sessionKey: channelId ? `iptv:${channelId}` : "iptv:none",
    initialVolume: androidClient ? 100 : 80,
    initialMuted: false,
    reloadToken: iptvLifecycleReloadToken(reloadToken, reconnectToken),
    onMediaFailure: handleMediaFailure,
    onReady: handleReady,
    onWaiting: handleWaiting,
    onPause: handlePause,
    onPlaying: handlePlaying,
    profile: IPTV_MEDIA_LIFECYCLE_PROFILE,
  });
  const fullscreen = player.mode === "fullscreen";
  const { exitFullscreen, exitPictureInPicture, toggleFullscreen, toggleMute, togglePause } =
    player;
  const androidPlayerControls = useAndroidPlayerControls(
    androidClient,
    channelId ? `iptv:${channelId}` : "iptv:none",
  );
  const nativePlayerControlsActive = androidClient && androidPlayerControls.supported;
  const nativeMediaVolume = nativePlayerControlsActive
    ? androidPlayerControls.state?.mediaVolume
    : undefined;
  const playerControlVolume = nativeMediaVolume ?? player.volume;
  const playerControlMuted =
    nativeMediaVolume !== undefined ? nativeMediaVolume <= 0 : player.muted;
  const changePlayerVolume = player.changeVolume;
  const handlePlayerVolumeChange = useCallback(
    (value: number) => {
      if (nativePlayerControlsActive && androidPlayerControls.setMediaVolume(value)) return;
      changePlayerVolume(value);
    },
    [androidPlayerControls, changePlayerVolume, nativePlayerControlsActive],
  );
  const handleTogglePlayerMute = useCallback(() => {
    if (nativePlayerControlsActive && androidPlayerControls.toggleMediaMute()) return;
    toggleMute();
  }, [androidPlayerControls, nativePlayerControlsActive, toggleMute]);

  useScreenWakeLock(status === "playing" && !audioOnly);
  useAndroidFullscreenOrientation({
    enabled: androidClient,
    fullscreen,
    aspectRatio: player.aspectRatio,
  });

  useEffect(() => {
    clearRetryTimer();
    retryAttemptRef.current = 0;
    setTransportEnabled(true);
    setError(null);
    setStatus(channelId ? "connecting" : "idle");
  }, [channelId, channelUrl, clearRetryTimer]);

  // 手动刷新拥有全新的 IPTV 重试预算。自动重试只递增 reconnectToken，
  // 因而保留其有界的尝试次数。
  useEffect(() => {
    clearRetryTimer();
    retryAttemptRef.current = 0;
    setTransportEnabled(true);
    setError(null);
    if (channelId) setStatus("connecting");
  }, [channelId, clearRetryTimer, reloadToken]);

  useEffect(() => clearRetryTimer, [clearRetryTimer]);

  useEffect(() => {
    onStatusChange?.(status, error);
  }, [error, onStatusChange, status]);

  useEffect(() => {
    if (!audioOnly) return;
    void exitPictureInPicture();
  }, [audioOnly, exitPictureInPicture]);

  const clearControlsHideTimer = useCallback(() => {
    if (controlsHideTimerRef.current === null) return;
    window.clearTimeout(controlsHideTimerRef.current);
    controlsHideTimerRef.current = null;
  }, []);

  const setControlVisibility = useCallback((visible: boolean) => {
    if (controlsVisibleRef.current === visible) return;
    controlsVisibleRef.current = visible;
    for (const layer of [controlsRef.current, hudRef.current]) {
      if (!layer) continue;
      layer.dataset.visible = visible ? "true" : "false";
      layer.setAttribute("aria-hidden", String(!visible));
      layer.toggleAttribute("inert", !visible);
    }
  }, []);

  const scheduleControlsHide = useCallback(() => {
    clearControlsHideTimer();
    setControlVisibility(true);
    if (status !== "playing" || player.paused || controlsInteractionOpen) return;
    controlsHideTimerRef.current = window.setTimeout(() => {
      controlsHideTimerRef.current = null;
      setControlVisibility(false);
    }, CONTROLS_HIDE_DELAY_MS);
  }, [
    clearControlsHideTimer,
    controlsInteractionOpen,
    player.paused,
    setControlVisibility,
    status,
  ]);

  const holdControlsVisible = useCallback(() => {
    clearControlsHideTimer();
    setControlVisibility(true);
  }, [clearControlsHideTimer, setControlVisibility]);

  useEffect(() => {
    scheduleControlsHide();
    return clearControlsHideTimer;
  }, [clearControlsHideTimer, scheduleControlsHide]);

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
        window.requestAnimationFrame(() => firstControl.focus({ preventScroll: true }));
        return;
      }

      if (event.repeat) return;
      const key = event.key.toLowerCase();
      if (key !== " " && key !== "k" && key !== "m" && key !== "f") return;
      event.preventDefault();
      scheduleControlsHide();
      if (key === " " || key === "k") togglePause();
      else if (key === "m") handleTogglePlayerMute();
      else void toggleFullscreen();
    },
    [
      handleTogglePlayerMute,
      holdControlsVisible,
      scheduleControlsHide,
      toggleFullscreen,
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
        ref={player.stageRef}
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
          ref={player.playerRootRef}
          data-player-engine-root
          aria-hidden={audioOnly}
          className={cn(
            "absolute inset-0 size-full overflow-hidden bg-black",
            audioOnly && "invisible",
          )}
        >
          <video
            key={player.mediaKey}
            ref={player.videoRef}
            data-player-video
            playsInline
            tabIndex={-1}
            disablePictureInPicture={audioOnly}
            className="absolute inset-0 size-full bg-black object-contain"
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
          <div
            data-mobile-static-backdrop
            className="absolute right-3 bottom-16 left-3 z-20 flex items-start gap-2 rounded-lg bg-background/90 p-3 text-sm text-foreground shadow-lg backdrop-blur"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
            <p>{error}</p>
          </div>
        )}

        {channel && (
          <div
            ref={hudRef}
            data-player-hud
            data-visible={controlsVisibleRef.current ? "true" : "false"}
            aria-hidden={!controlsVisibleRef.current}
            className="pointer-events-none absolute top-3 left-3 z-20 flex items-center gap-2 [will-change:opacity] transition-opacity duration-150 ease-out motion-reduced:transition-none data-[visible=false]:opacity-0"
          >
            {fullscreen && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="退出全屏"
                className={cn(
                  PLAYER_CONTROL_BUTTON_CLASS,
                  PLAYER_CONTROL_ICON_CLASS,
                  PLAYER_OVERLAY_CONTROL_BUTTON_CLASS,
                  "pointer-events-auto",
                )}
                onPointerEnter={holdControlsVisible}
                onPointerLeave={scheduleControlsHide}
                onClick={() => void exitFullscreen()}
              >
                <ChevronLeft data-icon="inline-start" aria-hidden />
              </Button>
            )}
            <Badge
              variant="destructive"
              className="gap-1.5 bg-destructive text-destructive-foreground"
            >
              <Radio data-icon="inline-start" aria-hidden />
              直播
            </Badge>
            <span
              data-mobile-static-backdrop
              className="max-w-[18rem] truncate rounded-md bg-black/55 px-2 py-1 text-xs text-primary-foreground backdrop-blur"
            >
              {channel.name}
            </span>
          </div>
        )}

        <div
          ref={controlsRef}
          data-player-controls
          data-visible="true"
          aria-hidden="false"
          className="absolute inset-x-0 bottom-0 z-30 [will-change:opacity] transition-opacity duration-150 ease-out motion-reduced:transition-none data-[visible=false]:pointer-events-none data-[visible=false]:opacity-0"
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
            paused={player.paused}
            volume={playerControlVolume}
            muted={playerControlMuted}
            audioOnly={audioOnly}
            fullscreen={fullscreen}
            pictureInPictureSupported={player.pictureInPictureSupported}
            pictureInPictureActive={player.pictureInPictureActive}
            pictureInPictureDisabled={status !== "playing" || fullscreen || audioOnly}
            disabled={!channel || !player.mediaAvailable || status === "error"}
            overlay
            stackedBelowPlayer
            compact={compactViewport}
            portalContainer={player.stageRef}
            onOverlayInteractionChange={handleControlsInteractionChange}
            refreshDisabled={!channel || status === "connecting"}
            loadError={player.fullscreenError}
            onRefresh={onReconnect}
            onTogglePause={togglePause}
            onVolume={handlePlayerVolumeChange}
            onToggleMute={handleTogglePlayerMute}
            onToggleAudioOnly={() => setAudioOnly((current) => !current)}
            onTogglePictureInPicture={() => void player.togglePictureInPicture()}
            onToggleFullscreen={() => void toggleFullscreen()}
          />
        </div>
      </div>
    </section>
  );
}
