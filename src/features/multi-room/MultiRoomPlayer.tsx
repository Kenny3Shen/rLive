import { usePlayerChromeVisibility } from "@/shared/hooks/usePlayerChromeVisibility";
import { usePlayerStageTapGestures } from "@/shared/hooks/usePlayerStageTapGestures";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, CircleAlert, Maximize2, RefreshCw, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Button as MediaButton } from "@/components/videojs/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AudioOnlyIndicator } from "@/shared/components/player/AudioOnlyIndicator";
import {
  PLAYER_HUD_BUTTON_CLASS,
  PLAYER_HUD_ICON_CLASS,
  PlayerControls,
  type PlayerControlsProps,
} from "@/shared/components/player/PlayerControls";
import { RoomIdentityLine } from "@/shared/components/player/RoomIdentityLine";
import { cn, normalizeCoverUrl } from "@/lib/utils";
import { invokeCmd } from "@/shared/api/tauri";
import type {
  CaptionTranslationLanguage,
  CaptionTranslationSourceLanguage,
  LiveRoomDetail,
} from "@/shared/types/live";
import { useAsrCaptions, type AsrCaptions } from "@/features/asr/useAsrCaptions";
import { AsrCaptionOverlay } from "@/features/asr/AsrCaptionOverlay";
import { DanmakuComposer } from "@/features/room/BilibiliDanmakuComposer";
import { DanmuJsDanmaku } from "@/features/room/danmaku/DanmuJsDanmaku";
import { useDanmakuConnection } from "@/features/room/danmaku/useDanmakuConnection";
import { usePlaybackController } from "@/features/room/playback/usePlaybackController";
import type { PlaybackController } from "@/features/room/playback/usePlaybackController";
import { useWebPlayer } from "@/features/room/player/useWebPlayer";
import type { WebPlayerApi } from "@/features/room/player/useWebPlayer";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import {
  useVideoJsPiP,
  VideoJsContainer,
  VideoJsPlayerProvider,
  VideoJsVideo,
} from "@/features/room/player/videoJsControls";
import {
  useMultiRoomLiveSyncRegistration,
  useMultiRoomLiveSyncStatus,
} from "./MultiRoomLiveSyncProvider";
import { liveSyncDanmakuDelayMs, liveSyncFeedStatusText } from "./liveSyncRegistry";
import { useMultiRoomStore, type MultiRoomEntry } from "./multiRoomStore";

const MULTI_ROOM_CONTROLS_HIDE_DELAY_MS = 2_000;
type MultiRoomOverlayInteractionSource = "controls" | "composer";

function playbackErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = String(error.message ?? "").trim();
    if (message) return message;
  }
  return "当前直播流不可用";
}

/**
 * 多画面分格 HUD 上图标按钮的唯一画法：与直播 HUD 同一套 36px `MediaButton`、药丸
 * 圆角与 hover 配色。退出全屏、拖拽把手、设为主画面、刷新与移除共用它 —— 新增按钮
 * 必须走这里，否则就会像之前的拖拽把手那样长出一个 28px、圆角也不一样的按钮。
 *
 * 透传 `button` 属性以支持 dnd-kit 的 `setActivatorNodeRef` 与 `attributes` /
 * `listeners`；`label` 同时作为 tooltip 文案与默认 `aria-label`，需要更具体的读屏
 * 文案时由调用点再传一个 `aria-label` 覆盖。
 */
export function OverlayIconButton({
  label,
  children,
  portalContainer,
  className,
  disabled,
  ...buttonProps
}: ComponentProps<"button"> & {
  label: string;
  children: ReactNode;
  portalContainer?: HTMLElement | RefObject<HTMLElement | null> | null;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <MediaButton
            type="button"
            className={cn(PLAYER_HUD_BUTTON_CLASS, "[&_svg]:size-6", className)}
            aria-label={label}
            aria-disabled={disabled || undefined}
            disabled={disabled}
            {...buttonProps}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent container={portalContainer}>{label}</TooltipContent>
    </Tooltip>
  );
}

type MainMultiRoomControlsProps = {
  room: MultiRoomEntry;
  playback: PlaybackController;
  player: WebPlayerApi;
  loading: boolean;
  error: unknown;
  audioOnly: boolean;
  onToggleAudioOnly: () => void;
  onRefresh: () => void;
  osdOn: boolean;
  onToggleOsd: () => void;
  onControlsOverlayInteractionChange: (open: boolean) => void;
  onComposerOverlayInteractionChange: (open: boolean) => void;
  /** 原主画面控制条外层 div 的 props；转发为原生 Controls.Content 的挂载属性。 */
  chrome?: PlayerControlsProps["chrome"];
};

type MainMultiRoomAsrContextValue = {
  asr: AsrCaptions;
  asrFontSize: number;
  asrPending: boolean;
  asrSpeakerDiarizationEnabled: boolean;
  asrTranslationEnabled: boolean;
  asrTranslationFrom: CaptionTranslationSourceLanguage;
  asrTranslationTo: CaptionTranslationLanguage;
  setAsrSpeakerDiarizationEnabled: (enabled: boolean) => void | Promise<void>;
  setAsrTranslationEnabled: (enabled: boolean) => void;
  setAsrTranslationFrom: (from: CaptionTranslationSourceLanguage) => void;
  setAsrTranslationTo: (to: CaptionTranslationLanguage) => void;
};

const MainMultiRoomAsrContext = createContext<MainMultiRoomAsrContextValue | null>(null);

function useMainMultiRoomAsr(): MainMultiRoomAsrContextValue {
  const value = useContext(MainMultiRoomAsrContext);
  if (!value) throw new Error("MainMultiRoomAsrContext is unavailable");
  return value;
}

function MainMultiRoomDanmaku({
  room,
  detail,
  playback,
  player,
  loading,
  error,
  audioOnly,
  osdOn,
}: {
  room: MultiRoomEntry;
  detail: LiveRoomDetail | undefined;
  playback: PlaybackController;
  player: WebPlayerApi;
  loading: boolean;
  error: unknown;
  audioOnly: boolean;
  osdOn: boolean;
}) {
  const syncStatus = useMultiRoomLiveSyncStatus(room.key);
  const danmaku = useDanmakuConnection({
    siteId: room.siteId,
    roomId: room.roomId,
    detailRoomId: detail?.room_id,
    enabled: true,
  });
  const showHost = !loading && error == null && !!playback.playUrl;
  if (!showHost || audioOnly) return null;

  const sessionKey = `multi-room:${room.key}`;
  return (
    <DanmuJsDanmaku
      active={danmaku.active && osdOn}
      sessionKey={sessionKey}
      siteId={room.siteId}
      roomId={detail?.room_id || room.roomId}
      roomTitle={detail?.title || room.title}
      roomUserName={detail?.user_name || room.userName}
      // 全屏把画面放到整整一块屏幕之外，紧凑的胶囊按钮很难点到。
      // 网格单元本来就已经很小了。
      large={player.mode === "fullscreen"}
      // 弹幕是实时到达的，把画面往后拉的时钟对齐
      // 必须把弹幕也拉后同样的量。
      delayMs={liveSyncDanmakuDelayMs(syncStatus)}
      className="absolute inset-0 z-10"
    />
  );
}

function MainMultiRoomAsrProvider({
  children,
  player,
  sessionKey,
  mediaAvailable,
}: {
  children: ReactNode;
  player: WebPlayerApi;
  sessionKey: string;
  mediaAvailable: boolean;
}) {
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
  const setAsrTranslationEnabled = useSettingsStore((state) => state.setAsrTranslationEnabled);
  const setAsrTranslationFrom = useSettingsStore((state) => state.setAsrTranslationFrom);
  const setAsrTranslationTo = useSettingsStore((state) => state.setAsrTranslationTo);
  const setAsrSpeakerDiarizationEnabled = useSettingsStore(
    (state) => state.setAsrSpeakerDiarizationEnabled,
  );
  const asr = useAsrCaptions({
    videoRef: player.videoRef,
    mediaKey: player.mediaKey,
    sessionKey,
    featureEnabled: asrEnabled,
    settingPending: asrPending,
    mediaAvailable,
    chunkSeconds: asrWindowSeconds,
    translationEnabled: asrTranslationEnabled,
    translationFrom: asrTranslationFrom,
    translationTo: asrTranslationTo,
  });

  return (
    <MainMultiRoomAsrContext.Provider
      value={{
        asr,
        asrFontSize,
        asrPending,
        asrSpeakerDiarizationEnabled,
        asrTranslationEnabled,
        asrTranslationFrom,
        asrTranslationTo,
        setAsrSpeakerDiarizationEnabled,
        setAsrTranslationEnabled,
        setAsrTranslationFrom,
        setAsrTranslationTo,
      }}
    >
      {children}
    </MainMultiRoomAsrContext.Provider>
  );
}

function MainMultiRoomStageOverlays({
  showHost,
  audioOnly,
  playerRunning,
}: {
  showHost: boolean;
  audioOnly: boolean;
  playerRunning: boolean;
}) {
  const { asr, asrFontSize, asrTranslationTo } = useMainMultiRoomAsr();

  return (
    <>
      {showHost && audioOnly && playerRunning && <AudioOnlyIndicator />}
      {showHost && !audioOnly && (
        <AsrCaptionOverlay asr={asr} fontSize={asrFontSize} translationTo={asrTranslationTo} />
      )}
    </>
  );
}

function MainMultiRoomControls({
  room,
  playback,
  player,
  loading,
  error,
  audioOnly,
  onToggleAudioOnly,
  onRefresh,
  osdOn,
  onToggleOsd,
  onControlsOverlayInteractionChange,
  onComposerOverlayInteractionChange,
  chrome,
}: MainMultiRoomControlsProps) {
  const {
    asr,
    asrSpeakerDiarizationEnabled,
    asrTranslationEnabled,
    asrTranslationFrom,
    asrTranslationTo,
    setAsrSpeakerDiarizationEnabled,
    setAsrTranslationEnabled,
    setAsrTranslationFrom,
    setAsrTranslationTo,
  } = useMainMultiRoomAsr();
  const showHost = !loading && error == null && !!playback.playUrl;
  const loadError = playback.loadError ?? player.loadError ?? player.fullscreenError;
  const pictureInPicture = useVideoJsPiP();
  const toggleAudioOnly = useCallback(() => {
    if (!audioOnly && pictureInPicture?.pip) {
      void pictureInPicture.exitPictureInPicture();
    }
    onToggleAudioOnly();
  }, [audioOnly, onToggleAudioOnly, pictureInPicture]);
  return (
    <PlayerControls
      chrome={chrome}
      audioOnly={audioOnly}
      osdOn={osdOn}
      asrVisible={asr.desktopClient}
      asrOn={asr.captionsOn}
      asrLabel={asr.controlLabel}
      asrDisabled={asr.controlDisabled}
      asrBusy={asr.controlBusy}
      asrTranslationEnabled={asrTranslationEnabled}
      asrTranslationFrom={asrTranslationFrom}
      asrTranslationTo={asrTranslationTo}
      asrSpeakerDiarizationEnabled={asrSpeakerDiarizationEnabled}
      qualities={playback.qualities}
      qualityIndex={playback.qualityIndex}
      lines={playback.lines}
      lineIndex={playback.lineIndex}
      fullscreen={player.mode === "fullscreen"}
      pictureInPictureDisabled={!player.running || player.mode === "fullscreen" || audioOnly}
      disabled={!showHost}
      refreshDisabled={loading || !playback.playUrl}
      loadError={loadError}
      // 导演网格的一个单元：非全屏时下方总有更多网格，
      // 因此控制元素不在窗口底边。
      stackedBelowPlayer
      portalContainer={player.stageRef}
      centerSlot={
        <DanmakuComposer
          siteId={room.siteId}
          roomId={room.roomId}
          overlay
          portalContainer={player.stageRef}
          onOverlayInteractionChange={onComposerOverlayInteractionChange}
        />
      }
      onOverlayInteractionChange={onControlsOverlayInteractionChange}
      onRefresh={onRefresh}
      onToggleAudioOnly={toggleAudioOnly}
      onToggleOsd={onToggleOsd}
      onToggleAsr={asr.toggle}
      onAsrTranslationEnabledChange={setAsrTranslationEnabled}
      onAsrTranslationFromChange={setAsrTranslationFrom}
      onAsrTranslationToChange={setAsrTranslationTo}
      onAsrSpeakerDiarizationEnabledChange={setAsrSpeakerDiarizationEnabled}
      onQualityChange={playback.onQualityChange}
      onLineChange={playback.onLineChange}
      onToggleFullscreen={() => void player.toggleFullscreen()}
    />
  );
}

/** 单个磁贴的直播时钟状态胶囊；独立成组件使一次 tick 只重渲染它。 */
function MultiRoomSyncBadge({
  roomKey,
  portalContainer,
}: {
  roomKey: string;
  portalContainer?: HTMLElement | RefObject<HTMLElement | null> | null;
}) {
  const status = useMultiRoomLiveSyncStatus(roomKey);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge variant={status?.limited ? "destructive" : "secondary"} className="tabular-nums" />
        }
      >
        {status?.holdSeconds == null ? "等待同步" : `延后 ${status.holdSeconds.toFixed(1)}s`}
      </TooltipTrigger>
      <TooltipContent container={portalContainer}>{liveSyncFeedStatusText(status)}</TooltipContent>
    </Tooltip>
  );
}

type MultiRoomPlayerProps = {
  room: MultiRoomEntry;
  main: boolean;
  dragHandle?: ReactNode;
};

export function MultiRoomPlayer(props: MultiRoomPlayerProps) {
  return (
    <VideoJsPlayerProvider>
      <MultiRoomPlayerContent {...props} />
    </VideoJsPlayerProvider>
  );
}

function MultiRoomPlayerContent({ room, main, dragHandle }: MultiRoomPlayerProps) {
  const setMainRoom = useMultiRoomStore((state) => state.setMainRoom);
  const removeRoom = useMultiRoomStore((state) => state.removeRoom);
  const updateAudio = useMultiRoomStore((state) => state.updateAudio);
  const updateMetadata = useMultiRoomStore((state) => state.updateMetadata);
  const syncMode = useMultiRoomStore((state) => state.syncMode);
  const [audioOnly, setAudioOnly] = useState(false);
  const [osdOn, setOsdOn] = useState(false);
  const controlsHideTimerRef = useRef<number | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const hudRef = useRef<HTMLDivElement | null>(null);
  const controlsVisibleRef = useRef(true);
  const controlsFocusWithinRef = useRef(false);
  const overlayInteractionOpenRef = useRef(false);
  const overlayInteractionSourcesRef = useRef<Record<MultiRoomOverlayInteractionSource, boolean>>({
    controls: false,
    composer: false,
  });
  const [initialControlsActivityAt] = useState(Date.now);
  const lastControlsActivityAtRef = useRef(initialControlsActivityAt);
  const detailQuery = useQuery({
    queryKey: ["room_detail", room.siteId, room.roomId],
    queryFn: () =>
      invokeCmd<LiveRoomDetail>("site_get_room_detail", {
        siteId: room.siteId,
        roomId: room.roomId,
      }),
  });
  const refetchDetail = detailQuery.refetch;
  const refreshDetail = useCallback(async () => {
    const result = await refetchDetail();
    if (result.isError) throw result.error;
    return result.data;
  }, [refetchDetail]);
  const playback = usePlaybackController({
    siteId: room.siteId,
    roomId: room.roomId,
    detail: detailQuery.data,
    refreshDetail,
    enabled: !!detailQuery.data,
  });
  const player = useWebPlayer({
    playUrl: playback.playUrl,
    siteId: room.siteId,
    quality: playback.qualities[playback.qualityIndex]?.quality ?? null,
    sessionKey: `multi-room:${room.key}`,
    initialVolume: room.volume,
    initialMuted: room.muted,
    // 所有流共享一个窗口，因此只有主流可以读取或驱动全屏；
    // 否则六条流都会声称自己在全屏。
    fullscreenOwner: main,
    reloadToken: playback.reloadToken,
    // 协议插件只在创建时读取延迟选项，
    // 因此对齐配置属于传输身份的一部分。
    liveSyncHold: syncMode !== "off",
    onMediaFailure: playback.onPlayerMediaFailure,
    onPlaying: playback.onPlayerPlaying,
  });
  const { stageRef: playerStageRef, playerRootRef, videoRef: playerVideoRef } = player;
  useMultiRoomLiveSyncRegistration({ key: room.key, main, sync: player.sync });
  const playerVolume = player.volume;
  const playerMuted = player.muted;
  const setPlayerAudio = player.setAudio;
  const exitPlayerFullscreen = player.exitFullscreen;

  usePlayerChromeVisibility({ controlsRef, hudRef, visibleRef: controlsVisibleRef, enabled: main });
  // 副画面双击设为主画面：识别器来自 Video.js 官方钩子，动作仍是本页的 store 操作。
  usePlayerStageTapGestures({
    target: playerStageRef,
    enabled: !main,
    onDoubleTap: () => setMainRoom(room.key),
  });
  if (!main && audioOnly) setAudioOnly(false);
  if (!main && osdOn) setOsdOn(false);

  // 某条流在全屏舞台期间可能被降级、拖走或移除。全屏属于当前的主流，
  // 因此一旦它不再是主流就立即交出 —— 包括卸载时 ——
  // 而不是让整个导演网格周围一直保持窗口全屏。
  useEffect(() => {
    if (!main) return;
    return () => {
      void exitPlayerFullscreen();
    };
  }, [exitPlayerFullscreen, main]);

  useEffect(() => {
    if (detailQuery.data) updateMetadata(room.key, detailQuery.data);
  }, [detailQuery.data, room.key, updateMetadata]);

  // 原生控制条直接驱动媒体元素；player 的音量状态由既有 volumechange 监听同步，
  // 用户在原生音量控件上的改动经此处写回共享的房间音量（设为主画面、删除、
  // 拖拽、切主画面后各房间仍从同一份音量语义读取）。房间音频自己变化
  // （切主/移除主流重排有声角色）时仍以 store 为准推回媒体元素。
  const lastRoomAudioRef = useRef({ volume: room.volume, muted: room.muted });
  useEffect(() => {
    if (playerVolume === room.volume && playerMuted === room.muted) {
      lastRoomAudioRef.current = { volume: room.volume, muted: room.muted };
      return;
    }
    const roomAudioChanged =
      lastRoomAudioRef.current.volume !== room.volume ||
      lastRoomAudioRef.current.muted !== room.muted;
    lastRoomAudioRef.current = { volume: room.volume, muted: room.muted };
    if (roomAudioChanged) {
      setPlayerAudio(room.volume, room.muted);
      return;
    }
    updateAudio(room.key, playerVolume, playerMuted);
  }, [playerMuted, playerVolume, room.key, room.muted, room.volume, setPlayerAudio, updateAudio]);

  const detail = detailQuery.data;
  const title = detail?.title || room.title;
  const userName = detail?.user_name || room.userName;
  const userAvatar = detail?.user_avatar;
  const online = detail?.online;
  const cover = normalizeCoverUrl(detail?.cover || room.cover);
  const loading = detailQuery.isLoading || playback.loading;
  const error = detailQuery.error ?? playback.error ?? playback.loadError ?? player.loadError;
  const showHost = !loading && error == null && !!playback.playUrl;

  function retry() {
    if (detailQuery.isError) {
      void detailQuery.refetch();
      return;
    }
    playback.retryPlay();
  }

  const fullscreen = main && player.mode === "fullscreen";

  const clearControlsHideTimer = useCallback(() => {
    if (controlsHideTimerRef.current === null) return;
    window.clearTimeout(controlsHideTimerRef.current);
    controlsHideTimerRef.current = null;
  }, []);

  const setControlsVisible = useCallback((visible: boolean) => {
    // 按房间为键的磁贴会原地更换角色，
    // 过期的 inert 状态必须始终重新同步。
    controlsVisibleRef.current = visible;
    for (const layer of [controlsRef.current, hudRef.current]) {
      if (!layer) continue;
      layer.dataset.visible = visible ? "true" : "false";
      layer.setAttribute("aria-hidden", String(!visible));
      layer.toggleAttribute("inert", !visible);
    }
  }, []);

  const hasKeyboardFocusWithinControls = useCallback(() => {
    if (!controlsFocusWithinRef.current) return false;
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement) || !activeElement.matches(":focus-visible")) {
      return false;
    }
    return (
      controlsRef.current?.contains(activeElement) === true ||
      hudRef.current?.contains(activeElement) === true
    );
  }, []);

  const scheduleControlsHide = useCallback(() => {
    clearControlsHideTimer();
    setControlsVisible(true);
    if (
      !main ||
      !player.running ||
      player.paused ||
      overlayInteractionOpenRef.current ||
      hasKeyboardFocusWithinControls()
    ) {
      return;
    }

    const hideWhenIdle = () => {
      const remaining =
        MULTI_ROOM_CONTROLS_HIDE_DELAY_MS - (Date.now() - lastControlsActivityAtRef.current);
      if (remaining > 0) {
        controlsHideTimerRef.current = window.setTimeout(hideWhenIdle, remaining);
        return;
      }
      controlsHideTimerRef.current = null;
      if (
        !main ||
        !player.running ||
        player.paused ||
        overlayInteractionOpenRef.current ||
        hasKeyboardFocusWithinControls()
      ) {
        setControlsVisible(true);
        return;
      }
      setControlsVisible(false);
    };

    controlsHideTimerRef.current = window.setTimeout(
      hideWhenIdle,
      Math.max(
        0,
        MULTI_ROOM_CONTROLS_HIDE_DELAY_MS - (Date.now() - lastControlsActivityAtRef.current),
      ),
    );
  }, [
    clearControlsHideTimer,
    hasKeyboardFocusWithinControls,
    main,
    player.paused,
    player.running,
    setControlsVisible,
  ]);

  const holdControlsVisible = useCallback(() => {
    lastControlsActivityAtRef.current = Date.now();
    clearControlsHideTimer();
    setControlsVisible(true);
  }, [clearControlsHideTimer, setControlsVisible]);

  const revealControls = useCallback(() => {
    lastControlsActivityAtRef.current = Date.now();
    setControlsVisible(true);
    scheduleControlsHide();
  }, [scheduleControlsHide, setControlsVisible]);

  const resumeControlsAutoHide = useCallback(() => {
    lastControlsActivityAtRef.current = Date.now();
    scheduleControlsHide();
  }, [scheduleControlsHide]);

  /**
   * 鼠标离开主画面：HUD 与控制条立即收起，不等空闲倒计时。触摸指针抬手
   * 同样触发 pointerleave，仍走原空闲节奏，避免吞掉点按唤醒的 chrome。
   */
  const handleStagePointerLeave = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType !== "mouse") {
        resumeControlsAutoHide();
        return;
      }
      if (
        !main ||
        !player.running ||
        player.paused ||
        overlayInteractionOpenRef.current ||
        hasKeyboardFocusWithinControls()
      ) {
        return;
      }
      clearControlsHideTimer();
      setControlsVisible(false);
    },
    [
      clearControlsHideTimer,
      hasKeyboardFocusWithinControls,
      main,
      player.paused,
      player.running,
      resumeControlsAutoHide,
      setControlsVisible,
    ],
  );

  const handleOverlayInteractionChange = useCallback(
    (source: MultiRoomOverlayInteractionSource, open: boolean) => {
      overlayInteractionSourcesRef.current[source] = open;
      const hasOpenOverlay = Object.values(overlayInteractionSourcesRef.current).some(Boolean);
      overlayInteractionOpenRef.current = hasOpenOverlay;
      if (hasOpenOverlay) holdControlsVisible();
      else resumeControlsAutoHide();
    },
    [holdControlsVisible, resumeControlsAutoHide],
  );

  const handleControlsOverlayInteractionChange = useCallback(
    (open: boolean) => handleOverlayInteractionChange("controls", open),
    [handleOverlayInteractionChange],
  );

  const handleComposerOverlayInteractionChange = useCallback(
    (open: boolean) => handleOverlayInteractionChange("composer", open),
    [handleOverlayInteractionChange],
  );

  const handleChromePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      holdControlsVisible();
    },
    [holdControlsVisible],
  );

  const handleChromeFocusCapture = useCallback(() => {
    controlsFocusWithinRef.current = true;
    holdControlsVisible();
  }, [holdControlsVisible]);

  const handleChromeBlurCapture = useCallback(
    (event: ReactFocusEvent<HTMLDivElement>) => {
      const nextFocused = event.relatedTarget;
      if (
        nextFocused instanceof Node &&
        (controlsRef.current?.contains(nextFocused) === true ||
          hudRef.current?.contains(nextFocused) === true)
      ) {
        controlsFocusWithinRef.current = true;
        holdControlsVisible();
        return;
      }
      controlsFocusWithinRef.current = false;
      resumeControlsAutoHide();
    },
    [holdControlsVisible, resumeControlsAutoHide],
  );

  useEffect(() => {
    controlsFocusWithinRef.current = false;
    overlayInteractionOpenRef.current = false;
    overlayInteractionSourcesRef.current.controls = false;
    overlayInteractionSourcesRef.current.composer = false;
    lastControlsActivityAtRef.current = Date.now();
    setControlsVisible(true);
    scheduleControlsHide();
    return clearControlsHideTimer;
  }, [
    clearControlsHideTimer,
    main,
    player.paused,
    player.running,
    scheduleControlsHide,
    setControlsVisible,
  ]);

  // ASR provider 必须同时罩住舞台字幕（容器内）与 controls 参数内容（皮肤内的
  // Controls.Content），包在容器外是唯一让两者共享同一条管线的挂法。
  const stage = (
    <VideoJsContainer
      ref={playerStageRef}
      data-multi-room-player={room.key}
      data-main={main ? "true" : "false"}
      // 只有主流携带舞台标记。全屏时这条 article 从 3x3 网格中提升为固定全窗口层
      // （见 styles.css 的 [data-player-stage] 规则），
      // 而不是仅仅让窗口围绕整个导演矩阵变大。
      data-player-stage={main ? "" : undefined}
      data-fullscreen={fullscreen ? "true" : undefined}
      className="group/player relative size-full min-h-0 overflow-hidden bg-black outline-none"
      tabIndex={0}
      aria-label={`${main ? "主画面" : "副画面"}：${title}`}
      onPointerEnter={main ? revealControls : undefined}
      onPointerMove={main ? revealControls : undefined}
      onPointerDown={main ? revealControls : undefined}
      onPointerLeave={main ? handleStagePointerLeave : undefined}
      controls={
        main ? (
          <MainMultiRoomControls
            chrome={{
              ref: controlsRef,
              "data-player-controls": true,
              "data-visible": "true",
              "aria-hidden": false,
              className:
                "absolute inset-x-0 bottom-0 z-30 [will-change:opacity] transition-opacity duration-150 ease-out motion-reduced:transition-none data-[visible=false]:pointer-events-none data-[visible=false]:opacity-0",
              onPointerEnter: holdControlsVisible,
              onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
                event.stopPropagation();
                holdControlsVisible();
              },
              onPointerDown: handleChromePointerDown,
              onPointerLeave: resumeControlsAutoHide,
              onFocusCapture: handleChromeFocusCapture,
              onBlurCapture: handleChromeBlurCapture,
            }}
            room={room}
            playback={playback}
            player={player}
            loading={loading}
            error={error}
            audioOnly={audioOnly}
            osdOn={osdOn}
            onToggleAudioOnly={() => setAudioOnly((enabled) => !enabled)}
            onRefresh={retry}
            onToggleOsd={() => setOsdOn((visible) => !visible)}
            onControlsOverlayInteractionChange={handleControlsOverlayInteractionChange}
            onComposerOverlayInteractionChange={handleComposerOverlayInteractionChange}
          />
        ) : (
          // 副画面与主画面共用同一原生控制面：不带主画面业务参数，
          // 音量经上方 volumechange 同步写回共享房间音量。
          <PlayerControls
            compact
            nativeFullscreen
            chrome={{
              className:
                "absolute inset-x-0 bottom-0 z-30 opacity-0 transition-opacity group-focus-within/player:opacity-100 group-hover/player:opacity-100",
            }}
          />
        )
      }
    >
      {cover && (
        <img
          src={cover}
          alt=""
          draggable={false}
          className="absolute inset-0 size-full object-cover opacity-35"
          referrerPolicy="no-referrer"
        />
      )}
      <div
        ref={playerRootRef}
        data-player-engine-root
        className={`absolute inset-0 size-full overflow-hidden bg-black/70${audioOnly ? " invisible" : ""}`}
      >
        <VideoJsVideo
          key={player.mediaKey}
          ref={playerVideoRef}
          data-player-video
          className="absolute inset-0 size-full bg-black object-contain"
          crossOrigin="anonymous"
          playsInline
          autoPlay
          controls={false}
          disablePictureInPicture={audioOnly}
        />
      </div>

      {main && (
        <MainMultiRoomDanmaku
          room={room}
          detail={detail}
          playback={playback}
          player={player}
          loading={loading}
          error={error}
          audioOnly={audioOnly}
          osdOn={osdOn}
        />
      )}

      {loading && !player.running && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Spinner className="size-7 text-white/80" aria-label="正在加载直播流" />
        </div>
      )}

      {!loading && error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 px-4 text-center text-white">
          <CircleAlert className="size-5 text-white/75" aria-hidden />
          <p className="line-clamp-2 text-xs text-white/80">{playbackErrorMessage(error)}</p>
          <Button type="button" variant="secondary" size="sm" onClick={retry}>
            <RefreshCw data-icon="inline-start" aria-hidden />
            重试
          </Button>
        </div>
      )}

      <div
        ref={hudRef}
        data-player-hud={main ? true : undefined}
        data-visible={main ? "true" : undefined}
        aria-hidden={main ? false : undefined}
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 z-30 flex min-w-0 items-center gap-2 bg-gradient-to-b from-black/80 to-transparent p-2 pb-6 text-white opacity-0 transition-opacity",
          main
            ? "[will-change:opacity] duration-150 ease-out motion-reduced:transition-none data-[visible=true]:opacity-100 data-[visible=false]:pointer-events-none data-[visible=false]:opacity-0"
            : "group-focus-within/player:opacity-100 group-hover/player:opacity-100",
        )}
        onPointerEnter={main ? holdControlsVisible : undefined}
        onPointerMove={
          main
            ? (event) => {
                event.stopPropagation();
                holdControlsVisible();
              }
            : undefined
        }
        onPointerDown={main ? handleChromePointerDown : undefined}
        onPointerLeave={main ? resumeControlsAutoHide : undefined}
        onFocusCapture={main ? handleChromeFocusCapture : undefined}
        onBlurCapture={main ? handleChromeBlurCapture : undefined}
      >
        <div className="pointer-events-auto flex h-media-control min-w-0 flex-1 items-center gap-1.5">
          {fullscreen && (
            <OverlayIconButton
              label="退出全屏"
              portalContainer={playerStageRef}
              onClick={() => void exitPlayerFullscreen()}
            >
              <ChevronLeft className={PLAYER_HUD_ICON_CLASS} aria-hidden />
            </OverlayIconButton>
          )}
          {dragHandle}
          {main && (
            <Badge variant="secondary" className="shrink-0">
              主画面
            </Badge>
          )}
          <RoomIdentityLine
            siteId={room.siteId}
            roomId={detail?.room_id || room.roomId}
            title={title}
            userName={userName}
            userAvatar={userAvatar}
            online={online}
            density="tile"
            className="flex-1"
          />
        </div>
        <div className="pointer-events-auto flex h-media-control shrink-0 items-center gap-1">
          {syncMode !== "off" && (
            <MultiRoomSyncBadge roomKey={room.key} portalContainer={playerStageRef} />
          )}
          {!main && (
            <OverlayIconButton
              label="设为主画面"
              portalContainer={playerStageRef}
              onClick={() => setMainRoom(room.key)}
            >
              <Maximize2 aria-hidden />
            </OverlayIconButton>
          )}
          <OverlayIconButton label="刷新此路" portalContainer={playerStageRef} onClick={retry}>
            <RefreshCw aria-hidden />
          </OverlayIconButton>
          <OverlayIconButton
            label="移除此路"
            portalContainer={playerStageRef}
            onClick={() => removeRoom(room.key)}
          >
            <X aria-hidden />
          </OverlayIconButton>
        </div>
      </div>

      {main && (
        <MainMultiRoomStageOverlays
          showHost={showHost}
          audioOnly={audioOnly}
          playerRunning={player.running}
        />
      )}
    </VideoJsContainer>
  );

  return main ? (
    <MainMultiRoomAsrProvider
      player={player}
      sessionKey={`multi-room:${room.key}`}
      mediaAvailable={showHost}
    >
      {stage}
    </MainMultiRoomAsrProvider>
  ) : (
    stage
  );
}
