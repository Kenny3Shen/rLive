import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import {
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Captions,
  CaptionsOff,
  Headphones,
  MessageSquareOff,
  MessageSquareText,
  PictureInPicture2,
  SunMedium,
  VideoOff,
  Volume2,
  VolumeX,
  type LucideIcon,
} from "lucide-react";
import { ANDROID_BACK_EVENT } from "@/app/androidBackNavigation";
import { getClientPlatform } from "@/shared/clientPlatform";
import type { PlayUrl, SiteId } from "@/shared/types/live";
import { ErrorState } from "@/shared/components/ErrorState";
import { DanmakuPanel } from "./DanmakuPanel";
import { DanmakuSettingsPanel } from "./DanmakuSettingsPanel";
import { FollowPanel } from "./FollowPanel";
import { SuperChatOverlay } from "./SuperChatOverlay";
import { DanmakuComposer } from "./BilibiliDanmakuComposer";
import {
  PlayerFullscreenHud,
  showPlayerFullscreenHud,
  type PlayerHudRoomAction,
} from "./PlayerFullscreenHud";
import {
  audioOnlyControlPresentation,
  danmakuControlPresentation,
  PlayerControls,
} from "@/shared/components/player/PlayerControls";
import { AudioOnlyIndicator } from "@/shared/components/player/AudioOnlyIndicator";
import { CanvasDanmaku } from "./canvas/CanvasDanmaku";
import { useAutoDanmakuSend } from "./danmaku/useAutoDanmakuSend";
import { useAsrCaptions } from "@/features/asr/useAsrCaptions";
import { useWebPlayer } from "./player/useWebPlayer";
import { useAndroidPlayerControls } from "./player/androidPlayerControls";
import { useAndroidFullscreenOrientation } from "./player/androidOrientation";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { setToastPortalContainer } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { useScreenWakeLock } from "@/shared/hooks/useScreenWakeLock";
import {
  useCompactLandscapePlayerViewport,
  useCompactPlayerViewport,
} from "@/shared/hooks/usePlayerViewport";
import { useHorizontalSwipe } from "@/shared/hooks/useHorizontalSwipe";
import type { PlayerEvent } from "@/shared/types/player";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { EASE_OUT, prefersReducedMotion } from "@/shared/motion/tokens";
import { siteSupportsSuperChat } from "./superChat";

export type RoomSideTab = "chat" | "settings" | "follow";

export type PlayerMobileRoomAction = {
  id: "mute" | "audio-only" | "danmaku" | "asr" | "picture-in-picture";
  label: string;
  icon: LucideIcon;
  pressed?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

/** Keep the visual tab order and touch-navigation order in one place. */
export const ROOM_SIDE_TABS: readonly RoomSideTab[] = ["chat", "follow", "settings"];

// A CSS pixel is density-independent in an Android WebView.  This keeps a
// normal vertical scroll or a short finger adjustment from changing the tab.
export const ROOM_SIDE_TAB_SWIPE_MIN_DISTANCE_PX = 48;
const ROOM_SIDE_TAB_SWIPE_DIRECTION_RATIO = 1.25;

// Android uses a native bridge for Activity brightness. Other mobile clients
// keep the same picture-local gesture through the compositor shade fallback.
export const PLAYER_EDGE_GESTURE_MIN_DISTANCE_PX = 12;
const PLAYER_EDGE_GESTURE_DIRECTION_RATIO = 1.25;
const PLAYER_EDGE_GESTURE_MIN_STAGE_HEIGHT_PX = 160;
// Bilibili-style adjustment tracks the finger across the whole picture height
// instead of jumping through coarse fixed steps.
const PLAYER_EDGE_GESTURE_DRAG_HEIGHT_RATIO = 1;
const PLAYER_EDGE_GESTURE_HUD_LINGER_MS = 520;
const PLAYER_EDGE_GESTURE_START_GUTTER_RATIO = 0.08;
// Match familiar mobile stage interactions: a short tap toggles the
// chrome, a second tap within this window enters/exits fullscreen.
export const PLAYER_STAGE_TAP_MAX_DISTANCE_PX = 14;
export const PLAYER_STAGE_TAP_MAX_DURATION_MS = 320;
export const PLAYER_STAGE_DOUBLE_TAP_MS = 280;

export type PlayerEdgeGesture = "brightness" | "volume";

type PlayerEdgeGestureState = {
  pointerId: number;
  kind: PlayerEdgeGesture;
  startX: number;
  startY: number;
  stageHeight: number;
  startValue: number;
  lastValue: number;
  active: boolean;
  /** Snapshot native availability so a delayed bridge failure cannot reroute a swipe. */
  native: boolean;
};

type PlayerStageTapState = {
  pointerId: number;
  startX: number;
  startY: number;
  startedAt: number;
};

/** The left half adjusts picture brightness; the right half adjusts volume. */
export function playerEdgeGestureForStart(
  clientX: number,
  stageLeft: number,
  stageWidth: number,
): PlayerEdgeGesture {
  return clientX - stageLeft < Math.max(0, stageWidth) / 2 ? "brightness" : "volume";
}

/** Convert the 0-100 fallback brightness into a compositor-only black overlay. */
export function playerBrightnessShadeOpacity(value: number): number {
  const brightness = Math.max(0, Math.min(100, value));
  return (100 - brightness) / 100;
}

/** A deliberate vertical drag wins over a diagonal or horizontal gesture. */
export function isVerticalPlayerEdgeGesture(deltaX: number, deltaY: number): boolean {
  const verticalDistance = Math.abs(deltaY);
  return (
    verticalDistance >= PLAYER_EDGE_GESTURE_MIN_DISTANCE_PX &&
    verticalDistance > Math.abs(deltaX) * PLAYER_EDGE_GESTURE_DIRECTION_RATIO
  );
}

export type PlayerEdgeGestureIntent = "pending" | "adjust" | "reject";

/**
 * Keep short contacts with their original picture target until they either
 * become a vertical adjustment or clearly turn into another gesture. This is
 * especially important for Canvas overlays: they need the matching pointerup
 * to finish touch hit testing.
 */
export function playerEdgeGestureIntent(
  deltaX: number,
  deltaY: number,
): PlayerEdgeGestureIntent {
  const horizontalDistance = Math.abs(deltaX);
  const verticalDistance = Math.abs(deltaY);
  if (
    horizontalDistance < PLAYER_EDGE_GESTURE_MIN_DISTANCE_PX &&
    verticalDistance < PLAYER_EDGE_GESTURE_MIN_DISTANCE_PX
  ) {
    return "pending";
  }
  return isVerticalPlayerEdgeGesture(deltaX, deltaY) ? "adjust" : "reject";
}

/**
 * Drag distance that maps to a full 0–100 adjustment. Using the whole stage
 * makes small finger movements continuous and controllable rather than jumpy.
 */
export function playerEdgeGestureDragExtent(stageHeight: number): number {
  return (
    Math.max(PLAYER_EDGE_GESTURE_MIN_STAGE_HEIGHT_PX, stageHeight) *
    PLAYER_EDGE_GESTURE_DRAG_HEIGHT_RATIO
  );
}

/** Dragging one player-height up/down maps to a full 0–100 adjustment. */
export function playerEdgeGestureValue(
  startValue: number,
  deltaY: number,
  stageHeight: number,
): number {
  const height = playerEdgeGestureDragExtent(stageHeight);
  return Math.max(0, Math.min(100, startValue - (deltaY / height) * 100));
}

/**
 * Leave a narrow top/bottom gutter for system-edge gestures. Interactive
 * playback chrome is excluded separately by `isPlayerEdgeGestureIgnoredTarget`.
 */
export function canStartPlayerEdgeGesture(
  clientY: number,
  stageTop: number,
  stageHeight: number,
): boolean {
  if (stageHeight <= 0) return false;
  const ratio = (clientY - stageTop) / stageHeight;
  return (
    ratio >= PLAYER_EDGE_GESTURE_START_GUTTER_RATIO &&
    ratio <= 1 - PLAYER_EDGE_GESTURE_START_GUTTER_RATIO
  );
}

/** A short, mostly stationary touch is a stage tap rather than a drag gesture. */
export function isPlayerStageTap(deltaX: number, deltaY: number, durationMs: number): boolean {
  return (
    durationMs >= 0 &&
    durationMs <= PLAYER_STAGE_TAP_MAX_DURATION_MS &&
    Math.hypot(deltaX, deltaY) <= PLAYER_STAGE_TAP_MAX_DISTANCE_PX
  );
}

/** Second short touch inside the double-tap window toggles fullscreen. */
export function isPlayerStageDoubleTap(lastTapAt: number, now: number): boolean {
  return lastTapAt > 0 && now - lastTapAt <= PLAYER_STAGE_DOUBLE_TAP_MS;
}

function isRoomSideTab(value: string): value is RoomSideTab {
  return ROOM_SIDE_TABS.includes(value as RoomSideTab);
}

export function isHorizontalRoomSideTabSwipe(deltaX: number, deltaY: number): boolean {
  const horizontalDistance = Math.abs(deltaX);
  const verticalDistance = Math.abs(deltaY);
  return (
    horizontalDistance >= ROOM_SIDE_TAB_SWIPE_MIN_DISTANCE_PX &&
    horizontalDistance > verticalDistance * ROOM_SIDE_TAB_SWIPE_DIRECTION_RATIO
  );
}

/**
 * Returns the adjacent tab for a deliberate horizontal swipe, or null for a
 * vertical/short gesture and at either end of the tab strip.  A left swipe
 * advances through the visible order; a right swipe goes back.
 */
export function nextRoomSideTabForSwipe(
  currentTab: RoomSideTab,
  deltaX: number,
  deltaY: number,
): RoomSideTab | null {
  if (!isHorizontalRoomSideTabSwipe(deltaX, deltaY)) return null;

  const currentIndex = ROOM_SIDE_TABS.indexOf(currentTab);
  if (currentIndex < 0) return null;
  const direction = deltaX < 0 ? 1 : -1;
  return ROOM_SIDE_TABS[currentIndex + direction] ?? null;
}

const CONTROLS_HIDE_DELAY_MS = 2_600;
const OVERLAY_FOCUS_RESTORE_DELAY_MS = 160;
type OverlayInteractionSource = "controls" | "composer" | "hud";

function isTouchPointer(pointerType: string): boolean {
  // A few Android WebViews expose an empty pointerType for finger input.
  return pointerType === "touch" || pointerType === "";
}

/** Stop the canvas only while an overlay genuinely covers the video frame. */
export function shouldRunDanmakuCanvas({
  danmakuActive,
  osdOn,
  sidePanelOverlaysPlayer,
}: {
  danmakuActive: boolean;
  osdOn: boolean;
  sidePanelOverlaysPlayer: boolean;
}): boolean {
  return danmakuActive && osdOn && !sidePanelOverlaysPlayer;
}

/** Portrait phones show the chat directly below the picture on first entry. */
export function sidePanelStartsOpen(compactLandscapeViewport: boolean): boolean {
  return !compactLandscapeViewport;
}

/** Once opened, keep the panel alive so hidden/fullscreen chat can retain its queue. */
export function shouldRetainRoomSidePanel(
  retained: boolean,
  sidePanelOpen: boolean,
  compactViewport: boolean,
): boolean {
  return retained || sidePanelOpen || !compactViewport;
}

export function shouldShowRoomDanmakuPanel(
  sidePanelOpen: boolean,
  fullscreen: boolean,
  activeSideTab: RoomSideTab,
): boolean {
  return sidePanelOpen && !fullscreen && activeSideTab === "chat";
}

/**
 * Whether this player stacks the picture above the chat when windowed.
 *
 * Deliberately independent of fullscreen. `player.mode` is derived from a
 * `fullscreenchange` state update, so it trails the browser's own `:fullscreen`
 * by a frame; the CSS that closes that gap (see `data-portrait-stack` in
 * styles.css) needs a marker that is already correct during the transition.
 */
export function usesPortraitStackLayout(
  inlineCompactSidePanel: boolean,
  sidePanelOpen: boolean,
): boolean {
  return inlineCompactSidePanel && sidePanelOpen;
}

/** The stack only applies while windowed; fullscreen gives the picture the screen. */
export function isPortraitStackedPlayer(
  portraitStackLayout: boolean,
  fullscreen: boolean,
): boolean {
  return portraitStackLayout && !fullscreen;
}

export function showDanmakuComposerInPlayerControls(
  inlineCompactSidePanel: boolean,
  fullscreen: boolean,
): boolean {
  return !inlineCompactSidePanel || fullscreen;
}

function isPlayerInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      'button, input, select, textarea, [role="button"], [role="combobox"], [role="slider"], [contenteditable="true"]',
    ),
  );
}

/**
 * A player-edge swipe must start on the picture itself. In particular, a
 * touch that begins in the bottom control bar must never turn into a volume
 * gesture when it leaves a button's hit target.
 */
function isPlayerEdgeGestureIgnoredTarget(target: EventTarget | null): boolean {
  const element =
    target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  return Boolean(
    element?.closest(
      '[data-player-controls], [data-player-hud], button, input, select, textarea, [role="button"], [role="combobox"], [role="slider"], [contenteditable="true"]',
    ),
  );
}

type PlayerPaneProps = {
  playUrl: PlayUrl | null;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** Compact streamer identity shown above the side tabs. */
  sideHeader?: ReactNode;
  danmakuActive?: boolean;
  danmakuStatusText?: string | null;
  qualities?: { quality: string }[];
  qualityIndex?: number;
  onQualityChange?: (index: number) => void;
  lines?: PlayUrl[];
  lineIndex?: number;
  onLineChange?: (index: number) => void;
  /** Refresh the active stream metadata and rebuild the MSE session. */
  onRefresh?: () => void;
  loadError?: string | null;
  reloadToken?: number;
  onPlayerMediaFailure?: (event: PlayerEvent) => void;
  onPlayerPlaying?: () => void;
  /** Stable room identity, used to discard messages during direct room switches. */
  roomSessionKey?: string;
  /** Controlled by RoomPage so a follow-list room switch keeps this tab open. */
  sideTab?: RoomSideTab;
  onSideTabChange?: (tab: RoomSideTab) => void;
  /** The canonical room identity for platform-specific chat controls. */
  siteId?: SiteId;
  roomId?: string;
  roomTitle?: string;
  roomUserName?: string;
  roomUserAvatar?: string;
  roomOnline?: number;
  /**
   * Room-level entries for the fullscreen HUD overflow menu (copy link, follow,
   * multi-room). The app chrome that normally hosts them is covered by the
   * fullscreen stage, so the page hands them down instead.
   */
  fullscreenRoomActions?: readonly PlayerHudRoomAction[];
  /** Publishes portrait-only secondary controls to RoomPage's room-actions menu. */
  onMobileRoomActionsChange?: (actions: readonly PlayerMobileRoomAction[]) => void;
};

/**
 * Room player — **xgplayer web MSE path** (protocol plugins + localhost proxy).
 *
 * No mpv / no native HWND / no companion overlay window. Video + scrolling
 * danmaku share one DOM stack; leave-room unmount stops everything cleanly.
 */
export function PlayerPane({
  playUrl,
  loading,
  error,
  onRetry,
  sideHeader,
  danmakuActive = false,
  danmakuStatusText,
  qualities = [],
  qualityIndex = 0,
  onQualityChange,
  lines = [],
  lineIndex = 0,
  onLineChange,
  onRefresh,
  loadError: externalLoadError,
  reloadToken = 0,
  onPlayerMediaFailure,
  onPlayerPlaying,
  roomSessionKey,
  sideTab,
  onSideTabChange,
  siteId,
  roomId,
  roomTitle,
  roomUserName,
  roomUserAvatar,
  roomOnline,
  fullscreenRoomActions = [],
  onMobileRoomActionsChange,
}: PlayerPaneProps) {
  const compactViewport = useCompactPlayerViewport();
  const compactLandscapeViewport = useCompactLandscapePlayerViewport();
  const clientPlatform = getClientPlatform();
  const mobileClient = clientPlatform !== "desktop";
  const androidClient = clientPlatform === "android";
  // Portrait phones use a normal video + chat stack, so new rooms immediately
  // expose the danmaku list. Short landscape screens stay viewing-first and
  // retain a dismissible overlay drawer instead.
  const [sidePanelOpen, setSidePanelOpen] = useState(() =>
    sidePanelStartsOpen(compactLandscapeViewport),
  );
  // PlayerPane is normally controlled by RoomPage, but keeping a local value
  // preserves the same tab behaviour for embedded/uncontrolled callers and
  // lets a touch gesture select a tab without depending on Base UI internals.
  const [uncontrolledSideTab, setUncontrolledSideTab] = useState<RoomSideTab>("chat");
  const activeSideTab = sideTab ?? uncontrolledSideTab;
  const [sidePanelRetained, setSidePanelRetained] = useState(
    () => sidePanelOpen || !compactViewport,
  );
  const shouldMountSidePanel = shouldRetainRoomSidePanel(
    sidePanelRetained,
    sidePanelOpen,
    compactViewport,
  );
  const [osdOn, setOsdOn] = useState(true);
  const [audioOnly, setAudioOnly] = useState(false);
  const [overlayInteractionOpen, setOverlayInteractionOpen] = useState(false);
  const superChatEnabled = useSettingsStore((state) => state.superChatEnabled);
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
  const controlsHideTimerRef = useRef<number | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  // The fullscreen top HUD is a second chrome layer on the same idle timer.
  const hudRef = useRef<HTMLDivElement | null>(null);
  const controlsVisibleRef = useRef(true);
  // Track focus inside the bottom chrome. A clicked button also takes DOM
  // focus, so the idle guard below additionally checks :focus-visible before
  // treating that focus as a keyboard interaction that must keep it present.
  const controlsFocusWithinRef = useRef(false);
  const lastControlsActivityAtRef = useRef(Date.now());
  const overlayInteractionOpenRef = useRef(false);
  const overlayInteractionSourcesRef = useRef<Record<OverlayInteractionSource, boolean>>({
    controls: false,
    composer: false,
    hud: false,
  });
  const playerBrightnessRef = useRef(100);
  const brightnessShadeRef = useRef<HTMLDivElement | null>(null);
  const playerEdgeGestureRef = useRef<PlayerEdgeGestureState | null>(null);
  const playerEdgeGestureFeedbackRef = useRef<HTMLDivElement | null>(null);
  const playerEdgeGesturePanelRef = useRef<HTMLDivElement | null>(null);
  const playerEdgeGestureBrightnessIconRef = useRef<SVGSVGElement | null>(null);
  const playerEdgeGestureVolumeIconRef = useRef<SVGSVGElement | null>(null);
  const playerEdgeGestureLabelRef = useRef<HTMLSpanElement | null>(null);
  const playerEdgeGestureValueRef = useRef<HTMLElement | null>(null);
  const playerEdgeGestureProgressRef = useRef<HTMLSpanElement | null>(null);
  const playerEdgeGestureFeedbackTimerRef = useRef<number | null>(null);
  const playerStageTapRef = useRef<PlayerStageTapState | null>(null);
  const playerStageTapTimerRef = useRef<number | null>(null);
  const lastPlayerStageTapAtRef = useRef(0);
  const player = useWebPlayer({
    playUrl,
    siteId,
    quality: qualities[qualityIndex]?.quality ?? null,
    // Android volume is controlled by STREAM_MUSIC through the native bridge;
    // keep the WebView media element at unity gain to avoid two volume layers.
    initialVolume: androidClient ? 100 : 80,
    sessionKey: roomSessionKey,
    reloadToken,
    onMediaFailure: onPlayerMediaFailure,
    onPlaying: onPlayerPlaying,
  });
  const { contextSafe: playerEdgeGestureContextSafe } = useGSAP({
    scope: playerEdgeGestureFeedbackRef,
  });
  const androidPlayerControls = useAndroidPlayerControls(androidClient, roomSessionKey);
  // Landscape streams auto-rotate on Android fullscreen; portrait ones stay
  // upright because the lock is derived from the decoded frame size.
  useAndroidFullscreenOrientation({
    enabled: androidClient,
    fullscreen: player.mode === "fullscreen",
    aspectRatio: player.aspectRatio,
  });
  const previewPlayerVolume = player.previewVolume;
  const setPlayerAudio = player.setAudio;
  const changePlayerVolume = player.changeVolume;
  const togglePlayerMute = player.toggleMute;
  const togglePlayerPictureInPicture = player.togglePictureInPicture;
  const togglePlayerFullscreen = player.toggleFullscreen;
  useScreenWakeLock(player.running && !player.paused && !audioOnly);
  // This stays above the conditional side panel, so hiding that panel never
  // silently stops a session the user explicitly enabled.
  const autoDanmakuSend = useAutoDanmakuSend({
    siteId,
    roomId,
    roomTitle,
    roomUserName,
    roomSessionKey,
  });

  const displayError =
    error ??
    (player.loadError
      ? {
          code: "play_error",
          message: player.loadError,
          site: null,
          retryable: true,
        }
      : null);
  const showHost = !loading && displayError == null && !!playUrl;
  const transportDisabled = !showHost;
  // A failed MSE session still has a stream URL and must be refreshable; the
  // error state is precisely where this control is most useful.
  const refreshDisabled = loading || !playUrl;
  const loadError = externalLoadError ?? player.loadError ?? player.fullscreenError;
  const danmakuSessionKey = `${roomSessionKey ?? "room"}:${playUrl?.url ?? "idle"}`;
  const asr = useAsrCaptions({
    videoRef: player.videoRef,
    mediaKey: player.mediaKey,
    sessionKey: danmakuSessionKey,
    featureEnabled: asrEnabled,
    settingPending: asrPending,
    mediaAvailable: showHost,
    chunkSeconds: asrWindowSeconds,
    translationEnabled: asrTranslationEnabled,
    translationFrom: asrTranslationFrom,
    translationTo: asrTranslationTo,
  });
  // Android routes loudness through STREAM_MUSIC. Use native state whenever the
  // bridge is supported, even before the first getState resolves, so UI and
  // gestures never fall back to the HTML <video> volume on a phone.
  const nativePlayerControlsActive = androidClient && androidPlayerControls.supported;
  const nativePlayerControlState = nativePlayerControlsActive ? androidPlayerControls.state : null;
  const playerControlVolume = nativePlayerControlState?.mediaVolume ?? player.volume;
  const playerControlMuted =
    nativePlayerControlState?.mediaVolume !== undefined
      ? nativePlayerControlState.mediaVolume <= 0
      : player.muted;

  const handleToggleMute = useCallback(() => {
    if (nativePlayerControlsActive && androidPlayerControls.toggleMediaMute()) return;
    togglePlayerMute();
  }, [androidPlayerControls, nativePlayerControlsActive, togglePlayerMute]);
  const handlePlayerVolumeChange = useCallback(
    (value: number) => {
      if (nativePlayerControlsActive && androidPlayerControls.setMediaVolume(value)) return;
      changePlayerVolume(value);
    },
    [androidPlayerControls, changePlayerVolume, nativePlayerControlsActive],
  );
  const handleToggleAudioOnly = useCallback(() => {
    const nextAudioOnly = !audioOnly;
    if (nextAudioOnly && player.pictureInPictureActive) {
      void togglePlayerPictureInPicture();
    }
    setAudioOnly(nextAudioOnly);
  }, [audioOnly, player.pictureInPictureActive, togglePlayerPictureInPicture]);
  const handleToggleOsd = useCallback(() => setOsdOn((visible) => !visible), []);
  const handleTogglePictureInPicture = useCallback(
    () => void togglePlayerPictureInPicture(),
    [togglePlayerPictureInPicture],
  );
  const mobileRoomActions = useMemo<readonly PlayerMobileRoomAction[]>(() => {
    const audioOnlyControl = audioOnlyControlPresentation(audioOnly);
    const danmakuControl = danmakuControlPresentation(osdOn);
    const actions: PlayerMobileRoomAction[] = [
      {
        id: "mute",
        label: playerControlMuted ? "取消静音" : "静音",
        icon: playerControlMuted ? VolumeX : Volume2,
        pressed: playerControlMuted,
        disabled: transportDisabled,
        onSelect: handleToggleMute,
      },
      {
        id: "audio-only",
        label: audioOnlyControl.label,
        icon: audioOnlyControl.icon === "headphones" ? Headphones : VideoOff,
        pressed: audioOnlyControl.enabled,
        disabled: transportDisabled && !audioOnly,
        onSelect: handleToggleAudioOnly,
      },
      {
        id: "danmaku",
        label: danmakuControl.label,
        icon: danmakuControl.icon === "message-square-text" ? MessageSquareText : MessageSquareOff,
        pressed: danmakuControl.enabled,
        disabled: transportDisabled,
        onSelect: handleToggleOsd,
      },
    ];
    if (asr.desktopClient) {
      actions.push({
        id: "asr",
        label: asr.controlLabel,
        icon: asr.captionsOn ? Captions : CaptionsOff,
        pressed: asr.captionsOn,
        disabled: asr.controlDisabled,
        onSelect: asr.toggle,
      });
    }
    if (player.pictureInPictureSupported) {
      actions.push({
        id: "picture-in-picture",
        label: player.pictureInPictureActive ? "退出画中画" : "画中画",
        icon: PictureInPicture2,
        pressed: player.pictureInPictureActive,
        disabled: transportDisabled || player.mode === "fullscreen" || audioOnly,
        onSelect: handleTogglePictureInPicture,
      });
    }
    return actions;
  }, [
    asr.captionsOn,
    asr.controlDisabled,
    asr.controlLabel,
    asr.desktopClient,
    asr.toggle,
    audioOnly,
    handleToggleAudioOnly,
    handleToggleMute,
    handleToggleOsd,
    handleTogglePictureInPicture,
    osdOn,
    player.mode,
    player.pictureInPictureActive,
    player.pictureInPictureSupported,
    playerControlMuted,
    transportDisabled,
  ]);

  useEffect(() => {
    onMobileRoomActionsChange?.(mobileRoomActions);
  }, [mobileRoomActions, onMobileRoomActionsChange]);

  useEffect(
    () => () => {
      onMobileRoomActionsChange?.([]);
    },
    [onMobileRoomActionsChange],
  );
  const canAutoHideControls =
    showHost && player.running && !player.paused && !overlayInteractionOpen;
  const inlineCompactSidePanel = compactViewport && !compactLandscapeViewport;
  const mobileDrawerOpen = compactLandscapeViewport && sidePanelOpen;
  const canvasActive = shouldRunDanmakuCanvas({
    danmakuActive,
    osdOn,
    sidePanelOverlaysPlayer: mobileDrawerOpen,
  });
  const compactLandscapeSidePanelClassName =
    "absolute inset-y-0 right-0 z-50 h-full w-[min(22rem,78vw)] max-w-full overscroll-contain rounded-l-2xl border-l border-border/80 pb-[env(safe-area-inset-bottom)] pr-[env(safe-area-inset-right)] shadow-2xl";
  const portraitStackLayout = usesPortraitStackLayout(inlineCompactSidePanel, sidePanelOpen);
  const portraitStackedPlayer = isPortraitStackedPlayer(
    portraitStackLayout,
    player.mode === "fullscreen",
  );
  const fullscreenHudVisible = showPlayerFullscreenHud({
    fullscreen: player.mode === "fullscreen",
    hasRoomIdentity: Boolean(roomTitle?.trim() || roomUserName?.trim()),
    hasActions: fullscreenRoomActions.length > 0 || mobileRoomActions.length > 0,
  });

  // Entering short landscape switches to an overlay drawer; rotating back to
  // portrait restores the immediately useful video + danmaku stack.
  useEffect(() => {
    setSidePanelOpen(sidePanelStartsOpen(compactLandscapeViewport));
  }, [compactLandscapeViewport]);

  // A new room starts over: drop the retention flag and let the effect below
  // raise it again on the following render if this viewport mounts the panel anyway.
  // Clearing rather than recomputing keeps the dependency list honest — the
  // recomputed value is exactly what that effect derives.
  useEffect(() => {
    setSidePanelRetained(false);
  }, [roomSessionKey]);

  useEffect(() => {
    if (shouldMountSidePanel && !sidePanelRetained) setSidePanelRetained(true);
  }, [shouldMountSidePanel, sidePanelRetained]);

  useEffect(() => {
    if (!mobileDrawerOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setSidePanelOpen(false);
    };
    const closeOnAndroidBack = (event: Event) => {
      event.preventDefault();
      setSidePanelOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener(ANDROID_BACK_EVENT, closeOnAndroidBack);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener(ANDROID_BACK_EVENT, closeOnAndroidBack);
    };
  }, [mobileDrawerOpen]);

  // Toasts default to a `<body>` portal, which the fullscreen stage covers on
  // both paths (browser top layer, and the fixed in-page layer used by the
  // desktop native window). Re-home the viewport for as long as this player
  // owns the screen so copy/follow feedback stays visible.
  useEffect(() => {
    if (player.mode !== "fullscreen") return;
    const stage = player.stageRef.current;
    if (!stage) return;
    setToastPortalContainer(stage);
    return () => setToastPortalContainer(null);
  }, [player.mode, player.stageRef]);

  // Prefer exiting fullscreen before room navigation. This is the only Back
  // handling the Android in-page fullscreen has: the Activity deliberately does
  // not consume Back for it, so that overlay listeners above (HUD menu, volume
  // panel) keep their turn at the same event.
  useEffect(() => {
    if (player.mode !== "fullscreen") return;
    const exitOnAndroidBack = (event: Event) => {
      event.preventDefault();
      void togglePlayerFullscreen();
    };
    window.addEventListener(ANDROID_BACK_EVENT, exitOnAndroidBack);
    return () => window.removeEventListener(ANDROID_BACK_EVENT, exitOnAndroidBack);
  }, [player.mode, togglePlayerFullscreen]);

  const clearControlsHideTimer = useCallback(() => {
    if (controlsHideTimerRef.current !== null) {
      window.clearTimeout(controlsHideTimerRef.current);
      controlsHideTimerRef.current = null;
    }
  }, []);

  const clearPlayerStageTapTimer = useCallback(() => {
    if (playerStageTapTimerRef.current !== null) {
      window.clearTimeout(playerStageTapTimerRef.current);
      playerStageTapTimerRef.current = null;
    }
  }, []);

  const setControlVisibility = useCallback((visible: boolean) => {
    if (controlsVisibleRef.current === visible) return;
    controlsVisibleRef.current = visible;

    // Hiding controls used to update PlayerPane state. That re-rendered the
    // live canvas and every keep-mounted side tab at the exact moment the
    // animation started, which is perceptible during a busy danmaku stream.
    // This small DOM-only state is deliberately isolated to the overlay: CSS
    // still performs the composited fade, while the video, canvas and lists
    // continue their existing work without a React reconciliation.
    //
    // Both chrome layers are driven from here so the fullscreen top HUD and the
    // bottom bar always appear and fade as one surface.
    for (const layer of [controlsRef.current, hudRef.current]) {
      if (!layer) continue;
      layer.dataset.visible = visible ? "true" : "false";
      layer.setAttribute("aria-hidden", String(!visible));
      layer.toggleAttribute("inert", !visible);
    }
  }, []);

  const markControlsActivity = useCallback(() => {
    lastControlsActivityAtRef.current = Date.now();
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
    if (
      !canAutoHideControls ||
      overlayInteractionOpenRef.current ||
      hasKeyboardFocusWithinControls()
    ) {
      setControlVisibility(true);
      return;
    }

    // Pointer events can fire at display refresh rate. Rather than resetting a
    // timeout for each one, keep one timer and let it check the latest activity
    // timestamp when it wakes up. This leaves the video/danmaku main thread
    // free while retaining an exact idle-delay contract.
    const hideWhenIdle = () => {
      const remaining = CONTROLS_HIDE_DELAY_MS - (Date.now() - lastControlsActivityAtRef.current);
      if (remaining > 0) {
        controlsHideTimerRef.current = window.setTimeout(hideWhenIdle, remaining);
        return;
      }

      controlsHideTimerRef.current = null;
      if (
        !canAutoHideControls ||
        overlayInteractionOpenRef.current ||
        hasKeyboardFocusWithinControls()
      ) {
        setControlVisibility(true);
        return;
      }
      setControlVisibility(false);
    };

    const initialDelay = Math.max(
      0,
      CONTROLS_HIDE_DELAY_MS - (Date.now() - lastControlsActivityAtRef.current),
    );
    controlsHideTimerRef.current = window.setTimeout(hideWhenIdle, initialDelay);
  }, [
    canAutoHideControls,
    clearControlsHideTimer,
    hasKeyboardFocusWithinControls,
    setControlVisibility,
  ]);

  const revealControls = useCallback(() => {
    markControlsActivity();
    setControlVisibility(true);
    if (controlsHideTimerRef.current === null) scheduleControlsHide();
  }, [markControlsActivity, scheduleControlsHide, setControlVisibility]);

  const hideControls = useCallback(() => {
    clearControlsHideTimer();
    clearPlayerStageTapTimer();
    setControlVisibility(false);
  }, [clearControlsHideTimer, clearPlayerStageTapTimer, setControlVisibility]);

  /** Simple Live single-tap: show when hidden, hide when already visible. */
  const toggleControls = useCallback(() => {
    if (controlsVisibleRef.current) {
      hideControls();
      return;
    }
    revealControls();
  }, [hideControls, revealControls]);

  const holdControlsVisible = useCallback(() => {
    markControlsActivity();
    clearControlsHideTimer();
    setControlVisibility(true);
  }, [clearControlsHideTimer, markControlsActivity, setControlVisibility]);

  const resumeControlsAutoHide = useCallback(() => {
    markControlsActivity();
    scheduleControlsHide();
  }, [markControlsActivity, scheduleControlsHide]);

  const handleOverlayInteractionChange = useCallback(
    (source: OverlayInteractionSource, open: boolean) => {
      overlayInteractionSourcesRef.current[source] = open;
      const hasOpenOverlay =
        overlayInteractionSourcesRef.current.controls ||
        overlayInteractionSourcesRef.current.composer ||
        overlayInteractionSourcesRef.current.hud;
      overlayInteractionOpenRef.current = hasOpenOverlay;
      setOverlayInteractionOpen(hasOpenOverlay);
      if (hasOpenOverlay) holdControlsVisible();
    },
    [holdControlsVisible],
  );

  const handleControlsOverlayInteractionChange = useCallback(
    (open: boolean) => handleOverlayInteractionChange("controls", open),
    [handleOverlayInteractionChange],
  );

  const handleComposerOverlayInteractionChange = useCallback(
    (open: boolean) => handleOverlayInteractionChange("composer", open),
    [handleOverlayInteractionChange],
  );

  const handleHudOverlayInteractionChange = useCallback(
    (open: boolean) => handleOverlayInteractionChange("hud", open),
    [handleOverlayInteractionChange],
  );

  // Both chrome layers hold themselves visible while pointer or keyboard focus
  // is inside them, and Tab between them must not restart the idle countdown.
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

  const selectSideTab = useCallback(
    (nextTab: RoomSideTab) => {
      if (nextTab === activeSideTab) return;
      if (sideTab === undefined) setUncontrolledSideTab(nextTab);
      onSideTabChange?.(nextTab);
    },
    [activeSideTab, onSideTabChange, sideTab],
  );

  const handleSideTabValueChange = useCallback(
    (value: string) => {
      if (isRoomSideTab(value)) selectSideTab(value);
    },
    [selectSideTab],
  );
  const sideTabSwipe = useHorizontalSwipe({
    items: ROOM_SIDE_TABS,
    value: activeSideTab,
    onChange: selectSideTab,
    enabled: sidePanelOpen,
    layout: "track",
  });

  const clearPlayerEdgeGestureFeedbackTimer = useCallback(() => {
    if (playerEdgeGestureFeedbackTimerRef.current !== null) {
      window.clearTimeout(playerEdgeGestureFeedbackTimerRef.current);
      playerEdgeGestureFeedbackTimerRef.current = null;
    }
  }, []);

  const revealPlayerEdgeGestureFeedback = useMemo(
    () =>
      playerEdgeGestureContextSafe(() => {
        const feedback = playerEdgeGestureFeedbackRef.current;
        const panel = playerEdgeGesturePanelRef.current;
        if (!feedback) return;
        const wasVisible = feedback.dataset.visible === "true";
        feedback.dataset.visible = "true";
        if (wasVisible) return;

        if (prefersReducedMotion()) {
          gsap.set(feedback, { autoAlpha: 1 });
          if (panel) gsap.set(panel, { scale: 1 });
          return;
        }
        gsap.to(feedback, {
          autoAlpha: 1,
          duration: 0.16,
          ease: EASE_OUT,
          overwrite: "auto",
        });
        if (panel) {
          gsap.to(panel, {
            scale: 1,
            duration: 0.16,
            ease: EASE_OUT,
            overwrite: "auto",
          });
        }
      }),
    [playerEdgeGestureContextSafe],
  );

  const hidePlayerEdgeGestureFeedback = useMemo(
    () =>
      playerEdgeGestureContextSafe(() => {
        const feedback = playerEdgeGestureFeedbackRef.current;
        const panel = playerEdgeGesturePanelRef.current;
        if (!feedback || feedback.dataset.visible !== "true") return;
        feedback.dataset.visible = "false";

        if (prefersReducedMotion()) {
          gsap.set(feedback, { autoAlpha: 0 });
          if (panel) gsap.set(panel, { scale: 0.97 });
          return;
        }
        gsap.to(feedback, {
          autoAlpha: 0,
          duration: 0.14,
          ease: EASE_OUT,
          overwrite: "auto",
        });
        if (panel) {
          gsap.to(panel, {
            scale: 0.97,
            duration: 0.14,
            ease: EASE_OUT,
            overwrite: "auto",
          });
        }
      }),
    [playerEdgeGestureContextSafe],
  );

  const showPlayerEdgeGestureFeedback = useCallback(
    (kind: PlayerEdgeGesture, value: number) => {
      const feedback = playerEdgeGestureFeedbackRef.current;
      const brightnessIcon = playerEdgeGestureBrightnessIconRef.current;
      const volumeIcon = playerEdgeGestureVolumeIconRef.current;
      const label = playerEdgeGestureLabelRef.current;
      const valueNode = playerEdgeGestureValueRef.current;
      const progress = playerEdgeGestureProgressRef.current;
      if (feedback) {
        feedback.dataset.kind = kind;
        feedback.dataset.playerEdgeGestureFeedback = kind;
      }
      if (brightnessIcon) brightnessIcon.style.display = kind === "brightness" ? "" : "none";
      if (volumeIcon) volumeIcon.style.display = kind === "volume" ? "" : "none";
      if (label) label.textContent = kind === "brightness" ? "亮度" : "音量";
      if (valueNode) valueNode.textContent = `${Math.round(value)}%`;
      if (progress) progress.style.transform = `scaleX(${Math.max(0, Math.min(1, value / 100))})`;
      clearPlayerEdgeGestureFeedbackTimer();
      revealPlayerEdgeGestureFeedback();
    },
    [clearPlayerEdgeGestureFeedbackTimer, revealPlayerEdgeGestureFeedback],
  );

  const schedulePlayerEdgeGestureFeedbackHide = useCallback(() => {
    clearPlayerEdgeGestureFeedbackTimer();
    playerEdgeGestureFeedbackTimerRef.current = window.setTimeout(() => {
      playerEdgeGestureFeedbackTimerRef.current = null;
      hidePlayerEdgeGestureFeedback();
    }, PLAYER_EDGE_GESTURE_HUD_LINGER_MS);
  }, [clearPlayerEdgeGestureFeedbackTimer, hidePlayerEdgeGestureFeedback]);

  const setClampedPlayerBrightness = useCallback((value: number, applyShade: boolean) => {
    const nextValue = Math.max(0, Math.min(100, value));
    if (playerBrightnessRef.current === nextValue) return;
    playerBrightnessRef.current = nextValue;
    if (applyShade && brightnessShadeRef.current) {
      brightnessShadeRef.current.style.opacity = String(playerBrightnessShadeOpacity(nextValue));
    }
  }, []);

  const releasePlayerEdgeGesturePointer = useCallback(
    (element: HTMLDivElement, pointerId: number) => {
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
    },
    [],
  );

  const handlePlayerEdgeGestureStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (
        !mobileClient ||
        !showHost ||
        !isTouchPointer(event.pointerType) ||
        !event.isPrimary ||
        isPlayerEdgeGestureIgnoredTarget(event.target)
      ) {
        return;
      }

      const stageBounds = event.currentTarget.getBoundingClientRect();
      if (
        stageBounds.width <= 0 ||
        stageBounds.height <= 0 ||
        !canStartPlayerEdgeGesture(event.clientY, stageBounds.top, stageBounds.height)
      ) {
        return;
      }

      const kind = playerEdgeGestureForStart(event.clientX, stageBounds.left, stageBounds.width);
      // Android controls both brightness and volume through the native bridge.
      const native = nativePlayerControlsActive;
      let startValue: number;
      if (kind === "brightness") {
        startValue = playerBrightnessRef.current;
      } else {
        startValue =
          native && nativePlayerControlState
            ? nativePlayerControlState.mediaVolume
            : player.muted || player.volume === 0
              ? 0
              : player.volume;
      }
      playerEdgeGestureRef.current = {
        pointerId: event.pointerId,
        kind,
        startX: event.clientX,
        startY: event.clientY,
        stageHeight: stageBounds.height,
        startValue,
        lastValue: startValue,
        active: false,
        native,
      };
    },
    [
      mobileClient,
      nativePlayerControlsActive,
      nativePlayerControlState,
      player.muted,
      player.volume,
      showHost,
    ],
  );

  /** Returns whether this pointer belongs to a pending/active edge gesture. */
  const handlePlayerEdgeGestureMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): boolean => {
      const gesture = playerEdgeGestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return false;

      const deltaX = event.clientX - gesture.startX;
      const deltaY = event.clientY - gesture.startY;
      let beganAdjustment = false;

      if (!gesture.active) {
        const intent = playerEdgeGestureIntent(deltaX, deltaY);
        if (intent === "pending") return true;
        if (intent === "reject") {
          playerEdgeGestureRef.current = null;
          releasePlayerEdgeGesturePointer(event.currentTarget, event.pointerId);
          return false;
        }
        gesture.active = true;
        beganAdjustment = true;
        // Do not capture on pointerdown: a short touch must keep its original
        // target so Canvas danmaku can receive pointerup and finish hit testing.
        // Once the contact is a real adjustment, capture keeps it continuous
        // when the finger reaches a stage edge in Android WebView fullscreen.
        event.currentTarget.setPointerCapture(event.pointerId);
        // A recognised volume/brightness drag cancels any pending stage tap.
        clearPlayerStageTapTimer();
        lastPlayerStageTapAtRef.current = 0;
        playerStageTapRef.current = null;
      }

      event.preventDefault();
      const nextValue = playerEdgeGestureValue(gesture.startValue, deltaY, gesture.stageHeight);
      if (beganAdjustment || nextValue !== gesture.lastValue) {
        gesture.lastValue = nextValue;
        if (gesture.kind === "brightness") {
          setClampedPlayerBrightness(nextValue, !gesture.native);
          if (gesture.native) {
            androidPlayerControls.setBrightness(nextValue);
          }
        } else if (gesture.native) {
          androidPlayerControls.setMediaVolume(nextValue);
        } else {
          previewPlayerVolume(nextValue);
        }
        showPlayerEdgeGestureFeedback(gesture.kind, nextValue);
      }
      return true;
    },
    [
      androidPlayerControls,
      clearPlayerStageTapTimer,
      previewPlayerVolume,
      releasePlayerEdgeGesturePointer,
      setClampedPlayerBrightness,
      showPlayerEdgeGestureFeedback,
    ],
  );

  const handlePlayerEdgeGestureEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const gesture = playerEdgeGestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return false;

      playerEdgeGestureRef.current = null;
      releasePlayerEdgeGesturePointer(event.currentTarget, event.pointerId);
      if (gesture.active) {
        if (gesture.native) androidPlayerControls.flush();
        if (gesture.kind === "volume" && !gesture.native) {
          setPlayerAudio(gesture.lastValue, gesture.lastValue === 0);
        }
        schedulePlayerEdgeGestureFeedbackHide();
        event.preventDefault();
      }
      return gesture.active;
    },
    [
      androidPlayerControls,
      releasePlayerEdgeGesturePointer,
      schedulePlayerEdgeGestureFeedbackHide,
      setPlayerAudio,
    ],
  );

  const handlePlayerEdgeGestureCancel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const gesture = playerEdgeGestureRef.current;
      if (gesture && gesture.pointerId === event.pointerId) {
        playerEdgeGestureRef.current = null;
        releasePlayerEdgeGesturePointer(event.currentTarget, event.pointerId);
        if (gesture.active) {
          if (gesture.native) androidPlayerControls.flush();
          if (gesture.kind === "volume" && !gesture.native) {
            setPlayerAudio(gesture.lastValue, gesture.lastValue === 0);
          }
          schedulePlayerEdgeGestureFeedbackHide();
        }
      }
      if (playerStageTapRef.current?.pointerId === event.pointerId) {
        playerStageTapRef.current = null;
      }
      clearPlayerStageTapTimer();
    },
    [
      androidPlayerControls,
      clearPlayerStageTapTimer,
      releasePlayerEdgeGesturePointer,
      schedulePlayerEdgeGestureFeedbackHide,
      setPlayerAudio,
    ],
  );

  const handleStagePointerActivity = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.type === "pointerdown") {
        event.currentTarget.focus({ preventScroll: true });
      }
      // Desktop/mouse keeps the always-reveal behaviour. Mobile touch uses an
      // explicit single-tap toggle so a second tap can hide the chrome again,
      // matching familiar mobile players rather than only resetting the timer.
      if (mobileClient && isTouchPointer(event.pointerType)) return;
      revealControls();
    },
    [mobileClient, revealControls],
  );

  const handleStagePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.type === "pointerdown") {
        event.currentTarget.focus({ preventScroll: true });
      }

      if (
        mobileClient &&
        isTouchPointer(event.pointerType) &&
        event.isPrimary &&
        !isPlayerEdgeGestureIgnoredTarget(event.target)
      ) {
        playerStageTapRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          startedAt: Date.now(),
        };
        handlePlayerEdgeGestureStart(event);
        return;
      }

      handleStagePointerActivity(event);
      handlePlayerEdgeGestureStart(event);
    },
    [handlePlayerEdgeGestureStart, handleStagePointerActivity, mobileClient],
  );

  const handleStagePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (handlePlayerEdgeGestureMove(event)) return;
      handleStagePointerActivity(event);
    },
    [handlePlayerEdgeGestureMove, handleStagePointerActivity],
  );

  const handleStagePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const gestureConsumed = handlePlayerEdgeGestureEnd(event);
      const tap = playerStageTapRef.current;
      if (!tap || tap.pointerId !== event.pointerId) return;
      playerStageTapRef.current = null;
      // Child picture overlays use preventDefault to claim a completed tap.
      // Still let the event reach here so pending edge/tap state is cleared,
      // but never turn that claimed press into playback or fullscreen chrome.
      if (gestureConsumed || event.defaultPrevented) return;
      if (
        !mobileClient ||
        !isTouchPointer(event.pointerType) ||
        !showHost ||
        isPlayerEdgeGestureIgnoredTarget(event.target)
      ) {
        return;
      }

      const durationMs = Date.now() - tap.startedAt;
      if (!isPlayerStageTap(event.clientX - tap.startX, event.clientY - tap.startY, durationMs)) {
        return;
      }

      event.preventDefault();
      const now = Date.now();
      if (isPlayerStageDoubleTap(lastPlayerStageTapAtRef.current, now)) {
        clearPlayerStageTapTimer();
        lastPlayerStageTapAtRef.current = 0;
        // Double-tap toggles fullscreen like other mobile video players.
        void togglePlayerFullscreen();
        return;
      }

      lastPlayerStageTapAtRef.current = now;
      clearPlayerStageTapTimer();
      // Delay the single-tap action so a second tap can claim double-tap
      // fullscreen without first flashing the control bar.
      playerStageTapTimerRef.current = window.setTimeout(() => {
        playerStageTapTimerRef.current = null;
        lastPlayerStageTapAtRef.current = 0;
        toggleControls();
      }, PLAYER_STAGE_DOUBLE_TAP_MS);
    },
    [
      clearPlayerStageTapTimer,
      handlePlayerEdgeGestureEnd,
      mobileClient,
      showHost,
      toggleControls,
      togglePlayerFullscreen,
    ],
  );

  useEffect(() => clearPlayerEdgeGestureFeedbackTimer, [clearPlayerEdgeGestureFeedbackTimer]);
  useEffect(() => clearPlayerStageTapTimer, [clearPlayerStageTapTimer]);

  useEffect(() => {
    const resetFallbackBrightness = () => {
      playerBrightnessRef.current = 100;
      if (brightnessShadeRef.current) brightnessShadeRef.current.style.opacity = "0";
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") resetFallbackBrightness();
    };

    resetFallbackBrightness();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [roomSessionKey]);

  useEffect(() => {
    if (!androidClient || !androidPlayerControls.supported) return;
    playerBrightnessRef.current = 100;
    if (brightnessShadeRef.current) brightnessShadeRef.current.style.opacity = "0";
  }, [androidClient, androidPlayerControls.supported]);

  useEffect(() => {
    if (!nativePlayerControlState) return;
    const gesture = playerEdgeGestureRef.current;
    if (gesture?.active && gesture.kind === "brightness") return;
    playerBrightnessRef.current = nativePlayerControlState.brightness;
  }, [nativePlayerControlState]);

  const focusFirstControl = useCallback(() => {
    // Hidden transparent chrome must not be in the tab sequence.  After Tab
    // reveals it, explicitly put focus on its first usable control instead of
    // relying on an asynchronous React state update to affect this key's
    // native tab traversal.
    //
    // Layers are visited in DOM order, so a fullscreen session enters at the
    // top HUD and Tab continues naturally down into the bottom bar.
    window.requestAnimationFrame(() => {
      for (const layer of [hudRef.current, controlsRef.current]) {
        const target = layer?.querySelector<HTMLElement>(
          'button:not(:disabled), [role="combobox"]:not([aria-disabled="true"])',
        );
        if (!target) continue;
        target.focus({ preventScroll: true });
        return;
      }
    });
  }, []);

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
        event.preventDefault();
        revealControls();
        focusFirstControl();
        return;
      }

      if (event.repeat) return;
      const key = event.key.toLowerCase();
      if (key !== " " && key !== "k" && key !== "m" && key !== "f") return;

      event.preventDefault();
      revealControls();
      if (key === " " || key === "k") {
        player.togglePause();
      } else if (key === "m") {
        player.toggleMute();
      } else {
        void player.toggleFullscreen();
      }
    },
    [focusFirstControl, player, revealControls],
  );

  // Live playback stays unobstructed by default, while every pointer, touch
  // or keyboard interaction brings the bottom chrome back immediately.
  useEffect(() => {
    markControlsActivity();
    setControlVisibility(true);
    scheduleControlsHide();
    return clearControlsHideTimer;
  }, [
    roomSessionKey,
    scheduleControlsHide,
    clearControlsHideTimer,
    markControlsActivity,
    setControlVisibility,
  ]);

  useEffect(() => {
    // A direct room switch unmounts popovers, but reset the source fence as a
    // fallback so a closing portal can never pin controls for the next room.
    overlayInteractionSourcesRef.current.controls = false;
    overlayInteractionSourcesRef.current.composer = false;
    overlayInteractionSourcesRef.current.hud = false;
    overlayInteractionOpenRef.current = false;
    controlsFocusWithinRef.current = false;
    setOverlayInteractionOpen(false);
  }, [roomSessionKey]);

  useEffect(() => {
    if (overlayInteractionOpen) return;
    // Base UI returns focus from a portalled Select/Popover to its trigger.
    // Its exit transition is 100ms, so schedule after focus restoration rather
    // than allowing that focus handler to clear the idle timer.
    const timer = window.setTimeout(resumeControlsAutoHide, OVERLAY_FOCUS_RESTORE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [overlayInteractionOpen, resumeControlsAutoHide]);

  // Show the controls after every fullscreen switch, whichever implementation
  // performed it. Keyed on `player.mode` rather than `fullscreenchange`, because
  // the desktop and Android in-page layers never fire that event.
  useEffect(() => {
    revealControls();
  }, [player.mode, revealControls]);

  return (
    <div
      data-room-player-shell
      className={cn(
        "relative flex h-full min-h-0 min-w-0 w-full bg-black",
        inlineCompactSidePanel && "flex-col",
      )}
    >
      <div
        data-room-player-frame
        className={cn(
          "relative flex min-w-0 flex-col bg-black",
          portraitStackedPlayer ? "w-full flex-none" : "min-h-0 flex-1",
        )}
      >
        <div
          ref={player.stageRef}
          data-player-stage
          data-fullscreen={player.mode === "fullscreen" ? "true" : undefined}
          // Fullscreen-independent, so CSS can restore the 16:9 stack in the
          // same frame the browser leaves fullscreen.
          data-portrait-stack={portraitStackLayout ? "true" : undefined}
          data-audio-only={audioOnly ? "true" : undefined}
          // Overlays anchored above the controls (super chat, captions) must
          // clear the same gesture-bar allowance the chrome uses, and only
          // when the chrome actually reserves it.
          style={
            {
              "--player-chrome-inset": portraitStackedPlayer
                ? "0px"
                : "env(safe-area-inset-bottom)",
            } as CSSProperties
          }
          className={cn(
            "relative flex min-w-0 flex-col overflow-hidden bg-black",
            portraitStackedPlayer ? "w-full" : "min-h-0 flex-1",
            mobileClient && showHost && "touch-none",
          )}
          tabIndex={0}
          aria-label={
            mobileClient
              ? "直播播放器；单击显示或隐藏控制条，双击全屏；左侧上下滑动调节亮度，右侧上下滑动调节音量；按空格或 K 播放或暂停，M 静音，F 全屏"
              : "直播播放器；按空格或 K 播放或暂停，M 静音，F 全屏"
          }
          aria-keyshortcuts="Space K M F"
          onPointerEnter={handleStagePointerActivity}
          onPointerMove={handleStagePointerMove}
          onPointerDown={handleStagePointerDown}
          onPointerUp={handleStagePointerUp}
          onPointerCancel={handlePlayerEdgeGestureCancel}
          onKeyDown={handleStageKeyDown}
        >
          <div
            data-player-video-surface
            className={cn(
              "relative min-w-0 overflow-hidden bg-black",
              portraitStackedPlayer ? "aspect-video w-full shrink-0" : "min-h-0 flex-1",
            )}
          >
            {loading && (
              <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 text-muted-foreground">
                <Spinner className="size-8 text-primary" />
                <p className="text-sm">正在解析线路…</p>
              </div>
            )}
            {!loading && displayError != null && (
              <div className="absolute inset-0 z-20 flex items-center justify-center p-6">
                <div className="w-full max-w-md">
                  <ErrorState
                    error={displayError}
                    title="播放不可用"
                    onRetry={onRetry}
                    className="bg-card shadow-2xl shadow-black/50"
                  />
                </div>
              </div>
            )}
            {!loading && displayError == null && !playUrl && (
              <div className="absolute inset-0 z-20 flex items-center justify-center text-sm text-muted-foreground">
                未选择流
              </div>
            )}

            <div className="absolute inset-0">
              <div
                ref={player.playerRootRef}
                data-player-engine-root
                aria-hidden={audioOnly}
                className={cn(
                  "absolute inset-0 size-full overflow-hidden bg-black",
                  audioOnly && "invisible",
                )}
              >
                {/* key=mediaKey forces a clean <video> after leave/re-enter (MSE). */}
                <video
                  key={player.mediaKey}
                  ref={player.videoRef}
                  data-player-video
                  className="absolute inset-0 size-full bg-black object-contain"
                  crossOrigin="anonymous"
                  playsInline
                  autoPlay
                  controls={false}
                  disablePictureInPicture={audioOnly}
                />
              </div>

              {/* Floating danmaku shares the picture brightness, while the
                  controls and room information keep their normal contrast. */}
              {showHost && osdOn && !audioOnly && (
                <CanvasDanmaku
                  active={canvasActive}
                  sessionKey={danmakuSessionKey}
                  siteId={siteId}
                  roomId={roomId}
                  roomTitle={roomTitle}
                  roomUserName={roomUserName}
                  // Fullscreen puts the picture a whole display away, where the
                  // compact pill is hard to aim at.
                  large={player.mode === "fullscreen"}
                  className="z-10"
                />
              )}
              {/* Dimming only needs alpha composition. A full-surface CSS
                  brightness filter would re-filter both video and Canvas on
                  every gesture step in browser/bridge-fallback playback. */}
              <div
                ref={brightnessShadeRef}
                data-player-brightness-shade
                className="pointer-events-none absolute inset-0 z-[11] bg-black opacity-0"
                aria-hidden="true"
              />
            </div>

            {showHost && audioOnly && player.running && <AudioOnlyIndicator />}

            {showHost && !audioOnly && superChatEnabled && siteSupportsSuperChat(siteId) && (
              <SuperChatOverlay
                key={`sc:${roomSessionKey ?? "room"}`}
                active={danmakuActive}
                className="absolute bottom-[calc(5rem+var(--player-chrome-inset))] left-[max(0.75rem,env(safe-area-inset-left))] z-20 max-h-[calc(100%_-_5.75rem_-_var(--player-chrome-inset))] w-[min(240px,calc(100%-1.5rem))]"
              />
            )}

            {showHost &&
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
                  className="pointer-events-none absolute inset-x-4 bottom-[calc(4.5rem+var(--player-chrome-inset))] z-20 flex justify-center"
                >
                  <p
                    className={cn(
                      "flex max-h-[min(7em,45dvh)] min-w-0 max-w-[min(48rem,92%)] flex-col justify-end overflow-hidden rounded-md bg-black/78 px-3 py-1.5 text-center leading-relaxed font-medium text-white shadow-md [text-shadow:0_1px_2px_rgb(0_0_0_/_0.9)]",
                      asr.noticeIsError &&
                        asr.notice &&
                        "border border-destructive/45 text-red-100",
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

            {showHost && !player.running && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
                <Spinner className="size-8 text-white/70" />
              </div>
            )}

            <div
              ref={playerEdgeGestureFeedbackRef}
              aria-hidden="true"
              data-kind="brightness"
              data-player-edge-gesture-feedback="brightness"
              data-visible="false"
              className="pointer-events-none invisible absolute inset-0 z-20 flex items-center justify-center opacity-0 [will-change:opacity]"
            >
              <div
                ref={playerEdgeGesturePanelRef}
                className="flex w-44 max-w-[calc(100%-2rem)] flex-col gap-3 rounded-lg border border-white/12 bg-black/78 p-3 text-white shadow-xl [transform:scale(0.97)] [will-change:transform]"
              >
                <div className="flex items-center gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white/12">
                    <SunMedium ref={playerEdgeGestureBrightnessIconRef} className="size-5" />
                    <Volume2
                      ref={playerEdgeGestureVolumeIconRef}
                      className="size-5"
                      style={{ display: "none" }}
                    />
                  </span>
                  <span className="flex min-w-0 flex-1 items-baseline justify-between gap-2">
                    <span ref={playerEdgeGestureLabelRef} className="text-sm text-white/76">
                      亮度
                    </span>
                    <strong
                      ref={playerEdgeGestureValueRef}
                      className="text-base font-semibold tabular-nums"
                    >
                      100%
                    </strong>
                  </span>
                </div>
                <span className="h-1 overflow-hidden rounded-full bg-white/20">
                  <span
                    ref={playerEdgeGestureProgressRef}
                    className="block h-full origin-left rounded-full bg-white [transform:scaleX(1)] [will-change:transform]"
                  />
                </span>
              </div>
            </div>
          </div>

          {fullscreenHudVisible && (
            <div
              ref={hudRef}
              data-player-hud
              data-visible={controlsVisibleRef.current ? "true" : "false"}
              aria-hidden={!controlsVisibleRef.current}
              className={cn(
                // Mirror of the bottom chrome: a fixed-position sibling of the
                // video surface that floats over the top edge instead of taking
                // layout height, faded by the same imperative data attribute so
                // no React reconciliation happens on the idle timer.
                "absolute inset-x-0 top-0 z-30 [will-change:opacity] transition-opacity duration-150 ease-out motion-reduced:transition-none data-[visible=false]:pointer-events-none data-[visible=false]:opacity-0",
              )}
              onPointerEnter={holdControlsVisible}
              onPointerDown={handleChromePointerDown}
              onPointerLeave={resumeControlsAutoHide}
              onFocusCapture={handleChromeFocusCapture}
              onBlurCapture={handleChromeBlurCapture}
            >
              <PlayerFullscreenHud
                siteId={siteId}
                roomId={roomId}
                roomTitle={roomTitle}
                roomUserName={roomUserName}
                roomUserAvatar={roomUserAvatar}
                roomOnline={roomOnline}
                roomActions={fullscreenRoomActions}
                playerActions={mobileRoomActions}
                compact={compactViewport}
                portalContainer={player.stageRef}
                onOverlayInteractionChange={handleHudOverlayInteractionChange}
                onExitFullscreen={player.exitFullscreen}
              />
            </div>
          )}

          <div
            ref={controlsRef}
            data-player-controls
            data-visible="true"
            aria-hidden="false"
            className={cn(
              // The chrome floats over the bottom edge of the picture instead
              // of consuming layout height, so hiding it gives the whole stage
              // back to the video. Keep the filtered surface stationary: moving
              // backdrop blur would resample the video on every transition
              // frame. The data attribute changes imperatively, so this
              // compositor-only fade also avoids reconciling the video, canvas
              // and side panels.
              "absolute inset-x-0 bottom-0 z-30 [will-change:opacity] transition-opacity duration-150 ease-out motion-reduced:transition-none data-[visible=false]:pointer-events-none data-[visible=false]:opacity-0",
            )}
            onPointerEnter={holdControlsVisible}
            onPointerDown={handleChromePointerDown}
            onPointerLeave={resumeControlsAutoHide}
            onFocusCapture={handleChromeFocusCapture}
            onBlurCapture={handleChromeBlurCapture}
          >
            <PlayerControls
              paused={player.paused}
              volume={playerControlVolume}
              muted={playerControlMuted}
              audioOnly={audioOnly}
              sidePanelOpen={sidePanelOpen}
              sidePanelLabel={
                compactViewport ? (sidePanelOpen ? "收起直播间面板" : "打开直播间面板") : undefined
              }
              osdOn={osdOn}
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
              qualities={qualities}
              qualityIndex={qualityIndex}
              lines={lines}
              lineIndex={lineIndex}
              fullscreen={player.mode === "fullscreen"}
              // Capability is device-level and stable; keep the control
              // mounted so reconnect loops (loading toggling) cannot make
              // the chrome flicker. transportDisabled covers unusable states.
              pictureInPictureSupported={player.pictureInPictureSupported}
              pictureInPictureActive={player.pictureInPictureActive}
              pictureInPictureDisabled={
                !player.running || player.mode === "fullscreen" || audioOnly
              }
              loadError={loadError}
              disabled={transportDisabled}
              overlay
              // Portrait stacks the danmaku panel under the picture, so the
              // controls float over the video's bottom edge rather than the
              // window's — no gesture-bar inset there.
              stackedBelowPlayer={portraitStackedPlayer}
              compact={compactViewport}
              portalContainer={player.stageRef}
              centerSlot={
                showDanmakuComposerInPlayerControls(
                  inlineCompactSidePanel,
                  player.mode === "fullscreen",
                ) ? (
                  <DanmakuComposer
                    siteId={siteId}
                    roomId={roomId}
                    roomTitle={roomTitle}
                    roomUserName={roomUserName}
                    overlay
                    onOverlayInteractionChange={handleComposerOverlayInteractionChange}
                  />
                ) : null
              }
              onOverlayInteractionChange={handleControlsOverlayInteractionChange}
              refreshDisabled={refreshDisabled}
              onRefresh={onRefresh}
              onTogglePause={() => player.togglePause()}
              onVolume={(value) => {
                handlePlayerVolumeChange(value);
              }}
              onToggleMute={handleToggleMute}
              onToggleAudioOnly={handleToggleAudioOnly}
              onToggleSidePanel={() => setSidePanelOpen((open) => !open)}
              onToggleOsd={handleToggleOsd}
              onToggleAsr={asr.toggle}
              onAsrTranslationEnabledChange={setAsrTranslationEnabled}
              onAsrTranslationFromChange={setAsrTranslationFrom}
              onAsrTranslationToChange={setAsrTranslationTo}
              onAsrSpeakerDiarizationEnabledChange={setAsrSpeakerDiarizationEnabled}
              onQualityChange={onQualityChange ?? (() => {})}
              onLineChange={onLineChange ?? (() => {})}
              onTogglePictureInPicture={handleTogglePictureInPicture}
              onToggleFullscreen={() => void player.toggleFullscreen()}
            />
          </div>
        </div>
      </div>

      {mobileDrawerOpen && (
        <Button
          type="button"
          variant="ghost"
          tabIndex={-1}
          aria-hidden
          className="absolute inset-0 z-40 h-auto w-auto rounded-none bg-black/45 p-0 hover:bg-black/45"
          onClick={() => setSidePanelOpen(false)}
        />
      )}

      {shouldMountSidePanel && (
        <aside
          aria-hidden={!sidePanelOpen}
          aria-labelledby={mobileDrawerOpen ? "room-side-panel-title" : undefined}
          aria-modal={mobileDrawerOpen ? true : undefined}
          role={mobileDrawerOpen ? "dialog" : undefined}
          data-room-side-tab-swipe-surface
          data-horizontal-swipe-surface
          className={cn(
            "flex min-h-0 min-w-0 flex-col overflow-hidden bg-sidebar touch-pan-y overscroll-y-contain",
            inlineCompactSidePanel
              ? "min-h-0 w-full flex-1 border-t border-border/80"
              : compactLandscapeViewport
                ? `${compactLandscapeSidePanelClassName} shrink-0`
                : "w-[300px] shrink-0 border-l border-border/80 lg:w-[320px]",
            !sidePanelOpen && "hidden",
          )}
          onPointerDownCapture={sideTabSwipe.onPointerDownCapture}
          onPointerMoveCapture={sideTabSwipe.onPointerMoveCapture}
          onPointerUpCapture={sideTabSwipe.onPointerUpCapture}
          onPointerCancelCapture={sideTabSwipe.onPointerCancelCapture}
          onClickCapture={sideTabSwipe.onClickCapture}
        >
          {mobileDrawerOpen && (
            <h2 id="room-side-panel-title" className="sr-only">
              直播间面板
            </h2>
          )}
          {sideHeader}
          <Tabs
            value={activeSideTab}
            className="flex min-h-0 flex-1 flex-col gap-0"
            onValueChange={handleSideTabValueChange}
          >
            <div className="flex h-11 shrink-0 items-center border-b border-border/80">
              <TabsList
                variant="line"
                className="h-11! min-w-0 flex-1 justify-start rounded-none bg-transparent px-2"
              >
                <TabsTrigger value="chat" className="px-3 text-sm">
                  弹幕
                </TabsTrigger>
                <TabsTrigger value="follow" className="text-sm">
                  关注
                </TabsTrigger>
                <TabsTrigger value="settings" className="text-sm">
                  设置
                </TabsTrigger>
              </TabsList>
            </div>
            <div data-room-side-tab-viewport className="relative min-h-0 flex-1 overflow-hidden">
              <div
                ref={sideTabSwipe.bindPage}
                data-slot="horizontal-swipe-track"
                className="flex h-full min-w-0"
                style={{ width: `${ROOM_SIDE_TABS.length * 100}%` }}
              >
                <div
                  role="tabpanel"
                  aria-label="弹幕"
                  aria-hidden={activeSideTab === "chat" ? undefined : true}
                  inert={activeSideTab === "chat" ? undefined : true}
                  data-room-side-tab-panel="chat"
                  className="flex min-h-0 min-w-0 shrink-0 flex-col"
                  style={{ width: `${100 / ROOM_SIDE_TABS.length}%` }}
                >
                  <DanmakuPanel
                    key={`chat:${roomSessionKey ?? "room"}`}
                    active={danmakuActive}
                    siteId={siteId}
                    roomId={roomId}
                    roomTitle={roomTitle}
                    roomUserName={roomUserName}
                    visible={shouldShowRoomDanmakuPanel(
                      sidePanelOpen,
                      player.mode === "fullscreen",
                      activeSideTab,
                    )}
                    statusText={danmakuStatusText}
                    className="min-h-0 flex-1"
                  />
                  {inlineCompactSidePanel && (
                    <DanmakuComposer
                      siteId={siteId}
                      roomId={roomId}
                      roomTitle={roomTitle}
                      roomUserName={roomUserName}
                    />
                  )}
                </div>
                <div
                  role="tabpanel"
                  aria-label="关注"
                  aria-hidden={activeSideTab === "follow" ? undefined : true}
                  inert={activeSideTab === "follow" ? undefined : true}
                  data-room-side-tab-panel="follow"
                  className="min-h-0 min-w-0 shrink-0"
                  style={{ width: `${100 / ROOM_SIDE_TABS.length}%` }}
                >
                  <FollowPanel className="h-full" />
                </div>
                <div
                  role="tabpanel"
                  aria-label="设置"
                  aria-hidden={activeSideTab === "settings" ? undefined : true}
                  inert={activeSideTab === "settings" ? undefined : true}
                  data-room-side-tab-panel="settings"
                  className="min-h-0 min-w-0 shrink-0"
                  style={{ width: `${100 / ROOM_SIDE_TABS.length}%` }}
                >
                  <DanmakuSettingsPanel
                    className="h-full"
                    autoSend={autoDanmakuSend}
                    siteId={siteId}
                  />
                </div>
              </div>
            </div>
          </Tabs>
        </aside>
      )}
    </div>
  );
}
