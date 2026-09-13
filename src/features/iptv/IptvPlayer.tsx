import { usePlayerChromeVisibility } from "@/shared/hooks/usePlayerChromeVisibility";
import { usePlayerStageTapGestures } from "@/shared/hooks/usePlayerStageTapGestures";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { AlertCircle, ChevronLeft, Radio, Tv } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button as MediaButton } from "@/components/videojs/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { getClientPlatform } from "@/shared/clientPlatform";
import { AudioOnlyIndicator } from "@/shared/components/player/AudioOnlyIndicator";
import {
  PLAYER_HUD_BUTTON_CLASS,
  PLAYER_HUD_ICON_CLASS,
  PLAYER_HUD_TITLE_SIZE_CLASS,
  PlayerControls,
} from "@/shared/components/player/PlayerControls";
import { useCompactPlayerViewport, usePortraitOrientation } from "@/shared/hooks/usePlayerViewport";
import { useScreenWakeLock } from "@/shared/hooks/useScreenWakeLock";
import { useAsrCaptions } from "@/features/asr/useAsrCaptions";
import { AsrCaptionOverlay } from "@/features/asr/AsrCaptionOverlay";
import { readPlayerVolume, rememberPlayerVolume } from "@/shared/playerVolume";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import type { PlayUrl } from "@/shared/types/live";
import type { PlayerEvent } from "@/shared/types/player";
import { cn } from "@/lib/utils";
import { inferPlaybackProtocol } from "@/lib/playUrl";
import { useAndroidFullscreenOrientation } from "@/features/room/player/androidOrientation";
import { useAndroidPlayerControls } from "@/features/room/player/androidPlayerControls";
import {
  IPTV_MEDIA_LIFECYCLE_PROFILE,
  useMediaLifecycle,
} from "@/features/room/player/useWebPlayer";
import type { VideoJsLivePlaybackKind } from "@/features/room/player/videoJsPlayer";
import {
  useVideoJsPiP,
  VideoJsContainer,
  VideoJsPlayerProvider,
  VideoJsVideo,
} from "@/features/room/player/videoJsControls";
import type { IptvChannel } from "./types";

export type IptvPlaybackStatus = "idle" | "connecting" | "ready" | "playing" | "error";

export const IPTV_AUTO_RECONNECT_MAX_ATTEMPTS = 2;
export const IPTV_AUTO_RECONNECT_DELAYS_MS = [1_000, 2_500] as const;
const CONTROLS_HIDE_DELAY_MS = 2_000;
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
): VideoJsLivePlaybackKind {
  const url = typeof source === "string" ? source : source.url;
  const protocol = typeof source === "string" ? undefined : source.protocol;
  if (protocol === "flv" || protocol === "hls" || protocol === "native") return protocol;
  if (protocol === "mpeg_ts") return "mpegts";
  const inferred = inferPlaybackProtocol(url, { fallback: "hls" });
  return inferred === "mpeg_ts" ? "mpegts" : inferred;
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
/** Video.js Player 是所有原生 controls components 的唯一上下文。 */
export function IptvPlayer(props: IptvPlayerProps) {
  return (
    <VideoJsPlayerProvider>
      <IptvPlayerContent {...props} />
    </VideoJsPlayerProvider>
  );
}

function IptvPlayerContent({
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
  const portraitOrientation = usePortraitOrientation();
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
  const { videoRef: playerVideoRef, stageRef: playerStageRef, playerRootRef } = player;
  const fullscreen = player.mode === "fullscreen";
  const { exitFullscreen, toggleFullscreen, toggleMute, togglePause } = player;
  const pictureInPicture = useVideoJsPiP();
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
  // 舞台盒子按源画幅比开洞，16:9 以外的频道（大量 4:3 SD）就不会再被
  // 写死的 16:9 盒子左右留黑边。纯音频无画面，保留 16:9 占位。
  const stageAspectRatio =
    !audioOnly && player.aspectRatio && player.aspectRatio > 0 ? player.aspectRatio : null;
  // 旋转与全屏绑定：转到横屏自动全屏，转回竖屏自动退出（仅限自动进来的那次）。
  useAndroidFullscreenOrientation({
    enabled: androidClient,
    fullscreen,
    aspectRatio: player.aspectRatio,
    isLandscape: !portraitOrientation,
    enterFullscreen: toggleFullscreen,
    exitFullscreen: exitFullscreen,
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
    videoRef: playerVideoRef,
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

  usePlayerChromeVisibility({ controlsRef, hudRef, visibleRef: controlsVisibleRef });

  // 双击全屏：识别器与判定窗口来自 Video.js 官方钩子，动作仍是本页的全屏适配器。
  usePlayerStageTapGestures({
    target: playerStageRef,
    onDoubleTap: () => void toggleFullscreen(),
    shouldIgnore: (event) => isPlayerInteractiveTarget(event.target),
  });

  const [previousSession, setPreviousSession] = useState({ channelId, channelUrl, reloadToken });
  if (
    previousSession.channelId !== channelId ||
    previousSession.channelUrl !== channelUrl ||
    previousSession.reloadToken !== reloadToken
  ) {
    setPreviousSession({ channelId, channelUrl, reloadToken });
    setTransportEnabled(true);
    setError(null);
    setStatus(channelId ? "connecting" : "idle");
  }

  // 换台和手动刷新重置重试预算；自动重试只递增 reconnectToken。
  useEffect(() => {
    clearRetryTimer();
    retryAttemptRef.current = 0;
  }, [channelId, channelUrl, clearRetryTimer, reloadToken]);

  useEffect(() => clearRetryTimer, [clearRetryTimer]);

  useEffect(() => {
    onStatusChange?.(status, error);
  }, [error, onStatusChange, status]);

  useEffect(() => {
    if (!audioOnly || !pictureInPicture?.pip) return;
    void pictureInPicture.exitPictureInPicture();
  }, [audioOnly, pictureInPicture]);

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

  /**
   * 鼠标离开播放器区域：HUD 与控制条立即收起，不等空闲倒计时。触摸指针
   * 抬手同样触发 pointerleave，忽略之，保持「点按唤醒 → 空闲淡出」的原节奏。
   */
  const handleStagePointerLeave = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== "mouse") return;
      if (status !== "playing" || player.paused || controlsInteractionOpen) return;
      clearControlsHideTimer();
      setControlVisibility(false);
    },
    [clearControlsHideTimer, controlsInteractionOpen, player.paused, setControlVisibility, status],
  );
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
      style={
        stageAspectRatio ? ({ "--stage-ar": String(stageAspectRatio) } as CSSProperties) : undefined
      }
      className={cn(
        // 只有这一层持有源画幅，内层 Container 铺满；全屏由内层 fixed 舞台接管。
        "relative flex w-full min-w-0 flex-col overflow-hidden bg-black",
        webFullscreen
          ? "h-full rounded-none border-0"
          : "h-auto max-h-full aspect-[var(--stage-ar,16/9)] border border-border-subtle shadow-sm",
      )}
    >
      <VideoJsContainer
        ref={playerStageRef}
        data-player-stage
        data-iptv-player-stage
        data-fullscreen={fullscreen ? "true" : undefined}
        data-audio-only={audioOnly ? "true" : undefined}
        tabIndex={0}
        aria-label={channel ? `${channel.name} 播放器` : "IPTV 播放器"}
        aria-keyshortcuts="Space K M F"
        className={cn(
          // 不自带 aspect-video：比值已由 section 持有，再叠一层只会算出
          // 更短的盒子并在外层居中 → 上下等高死区（黑边）。
          "relative min-h-0 flex-1 bg-muted/20 outline-none",
        )}
        onKeyDown={handleStageKeyDown}
        onPointerMove={scheduleControlsHide}
        onPointerDown={(event) => {
          if (isPlayerInteractiveTarget(event.target)) return;
          event.currentTarget.focus({ preventScroll: true });
          scheduleControlsHide();
        }}
        onPointerLeave={handleStagePointerLeave}
        controls={
          <PlayerControls
            chrome={{
              ref: controlsRef,
              "data-player-controls": true,
              "data-visible": "true",
              "aria-hidden": "false",
              className:
                "absolute inset-x-0 bottom-0 z-30 [will-change:opacity] transition-opacity duration-150 ease-out motion-reduced:transition-none data-[visible=false]:pointer-events-none data-[visible=false]:opacity-0",
              onPointerEnter: holdControlsVisible,
              onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
                event.stopPropagation();
                holdControlsVisible();
              },
              onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
                event.stopPropagation();
                holdControlsVisible();
              },
              onPointerLeave: scheduleControlsHide,
              onFocusCapture: holdControlsVisible,
              onBlurCapture: (event: ReactFocusEvent<HTMLDivElement>) => {
                const nextFocused = event.relatedTarget;
                if (nextFocused instanceof Node && event.currentTarget.contains(nextFocused))
                  return;
                scheduleControlsHide();
              },
            }}
            externalAudioControls={
              nativePlayerControlsActive
                ? {
                    volume: playerControlVolume,
                    muted: playerControlMuted,
                    onVolumeChange: handlePlayerVolumeChange,
                    onToggleMute: handleTogglePlayerMute,
                  }
                : undefined
            }
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
            pictureInPictureDisabled={status !== "playing" || fullscreen || audioOnly}
            disabled={!channel || !player.mediaAvailable || status === "error"}
            stackedBelowPlayer
            compact={compactViewport}
            portalContainer={playerStageRef}
            onOverlayInteractionChange={handleControlsInteractionChange}
            refreshDisabled={!channel || status === "connecting"}
            loadError={player.fullscreenError}
            onRefresh={onReconnect}
            onToggleAudioOnly={() => setAudioOnly((current) => !current)}
            onToggleWebFullscreen={() => onWebFullscreenChange?.(!webFullscreen)}
            onToggleAsr={asr.toggle}
            onAsrTranslationEnabledChange={setAsrTranslationEnabled}
            onAsrTranslationFromChange={setAsrTranslationFrom}
            onAsrTranslationToChange={setAsrTranslationTo}
            onAsrSpeakerDiarizationEnabledChange={setAsrSpeakerDiarizationEnabled}
            onToggleFullscreen={() => void toggleFullscreen()}
          />
        }
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
          <VideoJsVideo
            key={player.mediaKey}
            ref={playerVideoRef}
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

        {channel && !audioOnly && (
          <AsrCaptionOverlay asr={asr} fontSize={asrFontSize} translationTo={asrTranslationTo} />
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
            data-visible="true"
            aria-hidden={false}
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
                <MediaButton
                  type="button"
                  aria-label={backLabel ?? "返回上一页"}
                  className={PLAYER_HUD_BUTTON_CLASS}
                  // 与直播/视频页 HUD 返回箭头同一层级语义：先退全屏层，
                  // 无全屏层时返回页面。
                  onClick={() => {
                    if (fullscreen) void exitFullscreen();
                    else if (webFullscreen) onWebFullscreenChange?.(false);
                    else onBack();
                  }}
                >
                  <ChevronLeft
                    className={PLAYER_HUD_ICON_CLASS}
                    data-icon="inline-start"
                    aria-hidden
                  />
                </MediaButton>
              )}
              <div className="flex h-media-control min-w-0 flex-1 items-center gap-2">
                <Badge
                  variant="destructive"
                  className="shrink-0 gap-1.5 bg-destructive text-destructive-foreground"
                >
                  <Radio data-icon="inline-start" aria-hidden />
                  直播
                </Badge>
                <span
                  data-mobile-static-backdrop
                  className={cn(
                    "inline-flex items-center min-w-0 truncate rounded-md bg-black/55 px-2 py-1 text-primary-foreground backdrop-blur leading-none",
                    PLAYER_HUD_TITLE_SIZE_CLASS,
                  )}
                >
                  {channel.name}
                </span>
              </div>
              {/* 原生全屏不挂工具：RecordingControl 的 popover 默认 portal 到
                  `<body>`，会被 top layer 盖住（与直播页同一取舍）。 */}
              {!fullscreen && hudToolsSlot && (
                <div className="flex shrink-0 items-center gap-1">{hudToolsSlot}</div>
              )}
            </div>
          </div>
        )}

      </VideoJsContainer>
    </section>
  );
}
