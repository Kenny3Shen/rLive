import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
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
import { useAsrCaptions } from "@/features/asr/useAsrCaptions";
import { readPlayerVolume, rememberPlayerVolume } from "@/shared/playerVolume";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import type { PlayUrl } from "@/shared/types/live";
import type { PlayerEvent } from "@/shared/types/player";
import { cn } from "@/lib/utils";
import { useAndroidFullscreenOrientation } from "@/features/room/player/androidOrientation";
import { useAndroidPlayerControls } from "@/features/room/player/androidPlayerControls";
import {
  IPTV_MEDIA_LIFECYCLE_PROFILE,
  useMediaLifecycle,
} from "@/features/room/player/useWebPlayer";
import type { XgLivePlaybackKind } from "@/features/room/player/xgPlayer";
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
): XgLivePlaybackKind {
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
  /** 桌面端网页全屏：舞台占满应用窗口，由页面层持有（页脚/侧栏在那层让位）。 */
  webFullscreen?: boolean;
  onWebFullscreenChange?: (value: boolean) => void;
  onStatusChange?: (status: IptvPlaybackStatus, error: string | null) => void;
  onReconnect?: () => void;
  /** 页面返回：挂在顶部 HUD 的返回箭头上；全屏时先退全屏层。 */
  onBack?: () => void;
  backLabel?: string;
  /** 顶部 HUD 右侧的低频工具（关注/录制），由页面层提供。 */
  hudToolsSlot?: ReactNode;
};

/** 共享浏览器媒体生命周期模块的 IPTV 页面适配器。 */
export function IptvPlayer({
  channel,
  reloadToken,
  webFullscreen = false,
  onWebFullscreenChange,
  onStatusChange,
  onReconnect,
  onBack,
  backLabel,
  hudToolsSlot,
}: IptvPlayerProps) {
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

  // 音量记忆跨会话共享：只读一次 localStorage，作为网页层音量/静音的初值。
  const [initialAudio] = useState(readPlayerVolume);
  const player = useMediaLifecycle({
    playUrl: transportEnabled ? playUrl : null,
    sessionKey: channelId ? `iptv:${channelId}` : "iptv:none",
    // Android 音量经原生桥由 STREAM_MUSIC 控制；让 WebView 媒体元素保持单位增益，
    // 避免出现两层音量。也因此 Android 不参与音量记忆：系统媒体音量由 OS 自己记住。
    initialVolume: androidClient ? 100 : initialAudio.volume,
    initialMuted: androidClient ? false : initialAudio.muted,
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

  // 音量记忆共享给所有播放表面；原生音量生效时真实音量是系统媒体音量，由 OS
  // 自己记住，这里不落盘以免把 100 写进桌面端的记忆。
  useEffect(() => {
    if (nativePlayerControlsActive) return;
    rememberPlayerVolume(player.volume, player.muted);
  }, [nativePlayerControlsActive, player.muted, player.volume]);

  useScreenWakeLock(status === "playing" && !audioOnly);
  useAndroidFullscreenOrientation({
    enabled: androidClient,
    fullscreen,
    aspectRatio: player.aspectRatio,
  });

  const asrEnabled = useSettingsStore((state) => state.asrEnabled);
  const asrPending = useSettingsStore((state) => state.asrPending);
  const asrWindowSeconds = useSettingsStore((state) => state.asrWindowSeconds);
  const asrFontSize = useSettingsStore((state) => state.asrFontSize);
  const asrSpeakerDiarizationEnabled = useSettingsStore(
    (state) => state.asrSpeakerDiarizationEnabled,
  );
  const asrTranslationEnabled = useSettingsStore((state) => state.asrTranslationEnabled);
  const asrTranslationFrom = useSettingsStore((state) => state.asrTranslationFrom);
  const asrTranslationTo = useSettingsStore((state) => state.asrTranslationTo);
  const setAsrSpeakerDiarizationEnabled = useSettingsStore(
    (state) => state.setAsrSpeakerDiarizationEnabled,
  );
  const setAsrTranslationEnabled = useSettingsStore((state) => state.setAsrTranslationEnabled);
  const setAsrTranslationFrom = useSettingsStore((state) => state.setAsrTranslationFrom);
  const setAsrTranslationTo = useSettingsStore((state) => state.setAsrTranslationTo);

  // 语音字幕与直播页共用同一条 ASR 管线；sessionKey 与媒体生命周期一致，
  // 换台即换流，识别状态随之清空。
  const asr = useAsrCaptions({
    videoRef: player.videoRef,
    mediaKey: player.mediaKey,
    sessionKey: channelId ? `iptv:${channelId}` : "iptv:none",
    featureEnabled: asrEnabled,
    settingPending: asrPending,
    mediaAvailable: Boolean(channel) && player.mediaAvailable,
    chunkSeconds: asrWindowSeconds,
    translationEnabled: asrTranslationEnabled,
    translationFrom: asrTranslationFrom,
    translationTo: asrTranslationTo,
  });

  // 网页全屏没有浏览器代管的退出路径（原生全屏由 UA 响应 Escape），这里补上
  // 同一按键习惯。刻意跳过原生全屏：useMediaLifecycle 已为它监听 Escape，
  // 两个监听器同时响应会让一次按键连退两层。
  useEffect(() => {
    if (!webFullscreen || fullscreen) return;
    const exitOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onWebFullscreenChange?.(false);
    };
    window.addEventListener("keydown", exitOnEscape);
    return () => window.removeEventListener("keydown", exitOnEscape);
  }, [fullscreen, onWebFullscreenChange, webFullscreen]);

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
    <section
      className={cn(
        "relative w-full overflow-hidden bg-black",
        webFullscreen
          ? "h-full rounded-none border-0"
          : "rounded-2xl border border-border-subtle shadow-sm",
      )}
    >
      <div
        ref={player.stageRef}
        data-player-stage
        data-iptv-player-stage
        data-fullscreen={fullscreen ? "true" : undefined}
        data-audio-only={audioOnly ? "true" : undefined}
        tabIndex={0}
        aria-label={channel ? `${channel.name} 播放器` : "IPTV 播放器"}
        aria-keyshortcuts="Space K M F"
        className={cn(
          "relative bg-muted/20 outline-none",
          webFullscreen ? "h-full aspect-auto" : "aspect-video",
        )}
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

        {channel &&
          !audioOnly &&
          (asr.captionsOn || asr.notice) &&
          (asr.notice ||
            asr.caption ||
            asr.translatedCaption ||
            asr.translationNotice ||
            asr.partial) && (
            <div
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className="pointer-events-none absolute inset-x-4 bottom-[4.5rem] z-20 flex justify-center"
            >
              <p
                className={cn(
                  "flex max-h-[min(7em,45dvh)] min-w-0 max-w-[min(48rem,92%)] flex-col justify-end overflow-hidden rounded-md bg-black/78 px-3 py-1.5 text-center leading-relaxed font-medium text-white shadow-md [text-shadow:0_1px_2px_rgb(0_0_0_/_0.9)]",
                  asr.noticeIsError && asr.notice && "border border-destructive/45 text-red-100",
                )}
                style={{ fontSize: `${asrFontSize}px` }}
              >
                {asr.notice ?? (
                  <span className="flex shrink-0 flex-col gap-0.5 whitespace-pre-line break-words">
                    {asr.caption ? <span>{asr.caption}</span> : null}
                    {asr.translatedCaption ? (
                      <span
                        lang={asrTranslationTo === "auto" ? undefined : asrTranslationTo}
                        className="text-white/82"
                      >
                        {asr.translatedCaption}
                      </span>
                    ) : null}
                    {asr.translationNotice ? (
                      <span className="text-xs font-normal text-destructive">
                        {asr.translationNotice}
                      </span>
                    ) : null}
                    {asr.partial ? <span className="text-white/60">{asr.partial}</span> : null}
                  </span>
                )}
              </p>
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
            className={cn(
              // 与直播/视频播放页同一画法：悬浮于顶边不占布局高度，
              // 与底部控制栏共享同一个空闲淡出。
              "absolute inset-x-0 top-0 z-30 [will-change:opacity] transition-opacity duration-150 ease-out motion-reduced:transition-none data-[visible=false]:pointer-events-none data-[visible=false]:opacity-0",
            )}
            onPointerEnter={holdControlsVisible}
            onPointerLeave={scheduleControlsHide}
            onFocusCapture={holdControlsVisible}
            onBlurCapture={scheduleControlsHide}
          >
            <div
              className={cn(
                "player-scrim-overlay-top flex min-w-0 items-center gap-2 bg-transparent pr-[max(0.375rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] pt-[max(0.375rem,var(--player-safe-area-top,0px))] text-white",
                compactViewport ? "pb-3" : "pb-6",
              )}
            >
              {onBack && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={backLabel ?? "返回上一页"}
                  className={cn(
                    PLAYER_CONTROL_BUTTON_CLASS,
                    PLAYER_CONTROL_ICON_CLASS,
                    PLAYER_OVERLAY_CONTROL_BUTTON_CLASS,
                    "shrink-0",
                  )}
                  // 与直播/视频页 HUD 返回箭头同一层级语义：先退全屏层，
                  // 无全屏层时返回页面。
                  onClick={() => {
                    if (fullscreen) void exitFullscreen();
                    else if (webFullscreen) onWebFullscreenChange?.(false);
                    else onBack();
                  }}
                >
                  <ChevronLeft data-icon="inline-start" aria-hidden />
                </Button>
              )}
              <Badge
                variant="destructive"
                className="shrink-0 gap-1.5 bg-destructive text-destructive-foreground"
              >
                <Radio data-icon="inline-start" aria-hidden />
                直播
              </Badge>
              <span
                data-mobile-static-backdrop
                className="min-w-0 flex-1 truncate rounded-md bg-black/55 px-2 py-1 text-xs text-primary-foreground backdrop-blur"
              >
                {channel.name}
              </span>
              {/* 原生全屏不挂工具：RecordingControl 的 popover 默认 portal 到
                  `<body>`，会被 top layer 盖住（与直播页同一取舍）。 */}
              {!fullscreen && hudToolsSlot && (
                <div className="flex shrink-0 items-center gap-1">{hudToolsSlot}</div>
              )}
            </div>
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
            webFullscreen={webFullscreen}
            fullscreen={fullscreen}
            asrVisible={asr.desktopClient}
            asrOn={asr.captionsOn}
            asrLabel={asr.controlLabel}
            asrDisabled={asr.controlDisabled}
            asrBusy={asr.controlBusy}
            asrTranslationEnabled={asrTranslationEnabled}
            asrTranslationFrom={asrTranslationFrom}
            asrTranslationTo={asrTranslationTo}
            asrTranslationBusy={asr.translationPending}
            asrSpeakerDiarizationEnabled={asrSpeakerDiarizationEnabled}
            asrSettingsPending={asrPending}
            pictureInPictureSupported={player.pictureInPictureSupported}
            pictureInPictureActive={player.pictureInPictureActive}
            pictureInPictureDisabled={status !== "playing" || fullscreen || audioOnly}
            disabled={!channel || !player.mediaAvailable || status === "error"}
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
            onToggleWebFullscreen={() => onWebFullscreenChange?.(!webFullscreen)}
            onToggleAsr={asr.toggle}
            onAsrTranslationEnabledChange={setAsrTranslationEnabled}
            onAsrTranslationFromChange={setAsrTranslationFrom}
            onAsrTranslationToChange={setAsrTranslationTo}
            onAsrSpeakerDiarizationEnabledChange={setAsrSpeakerDiarizationEnabled}
            onToggleFullscreen={() => void toggleFullscreen()}
          />
        </div>
      </div>
    </section>
  );
}
