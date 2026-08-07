import {
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
  MessageCircle,
  MessageCircleOff,
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
  audioOnlyControlPresentation,
  danmakuControlPresentation,
  PlayerControls,
} from "@/shared/components/player/PlayerControls";
import { AudioOnlyIndicator } from "@/shared/components/player/AudioOnlyIndicator";
import { CanvasDanmaku } from "./canvas/CanvasDanmaku";
import { useAutoDanmakuSend } from "./danmaku/useAutoDanmakuSend";
import { useAsrCaptions } from "@/features/asr/useAsrCaptions";
import { useWebPlayer } from "./player/useWebPlayer";
import { androidPlayerControlStep, useAndroidPlayerControls } from "./player/androidPlayerControls";
import { useAndroidFullscreenOrientation } from "./player/androidOrientation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useScreenWakeLock } from "@/shared/hooks/useScreenWakeLock";
import {
  useCompactLandscapePlayerViewport,
  useCompactPlayerViewport,
} from "@/shared/hooks/usePlayerViewport";
import { useHorizontalSwipe } from "@/shared/hooks/useHorizontalSwipe";
import type { PlayerEvent } from "@/shared/types/player";
import { useSettingsStore } from "@/shared/stores/settingsStore";
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

// Android uses a native bridge for the media stream and Activity brightness.
// Browser previews keep the same gesture with a video/CSS fallback.
export const PLAYER_EDGE_GESTURE_MIN_DISTANCE_PX = 12;
const PLAYER_EDGE_GESTURE_DIRECTION_RATIO = 1.25;
const PLAYER_EDGE_GESTURE_MIN_STAGE_HEIGHT_PX = 160;
// Simple Live maps a full 0–100 sweep to half the player height so a short
// vertical drag remains responsive without needing a full-screen swipe.
const PLAYER_EDGE_GESTURE_DRAG_HEIGHT_RATIO = 0.5;
const PLAYER_EDGE_GESTURE_FEEDBACK_DURATION_MS = 900;
const PLAYER_EDGE_GESTURE_START_MIN_Y_RATIO = 0.25;
const PLAYER_EDGE_GESTURE_START_MAX_Y_RATIO = 0.75;
// Match Simple Live's mobile stage interactions: a short tap toggles the
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

/**
 * Drag distance that maps to a full 0–100 adjustment. Simple Live uses half
 * the player height so volume/brightness remain reachable with a short swipe.
 */
export function playerEdgeGestureDragExtent(stageHeight: number): number {
  return (
    Math.max(PLAYER_EDGE_GESTURE_MIN_STAGE_HEIGHT_PX, stageHeight) *
    PLAYER_EDGE_GESTURE_DRAG_HEIGHT_RATIO
  );
}

/** Dragging half a player-height up/down maps to a full 0–100 adjustment. */
export function playerEdgeGestureValue(
  startValue: number,
  deltaY: number,
  stageHeight: number,
): number {
  const height = playerEdgeGestureDragExtent(stageHeight);
  return Math.max(0, Math.min(100, Math.round(startValue - (deltaY / height) * 100)));
}

/**
 * Reserve the top/bottom quarters for Android system chrome and the playback
 * controls. This prevents accidental volume changes while reaching for an
 * overlay, matching the touch target used by Simple Live.
 */
export function canStartPlayerEdgeGesture(
  clientY: number,
  stageTop: number,
  stageHeight: number,
): boolean {
  if (stageHeight <= 0) return false;
  const ratio = (clientY - stageTop) / stageHeight;
  return (
    ratio >= PLAYER_EDGE_GESTURE_START_MIN_Y_RATIO && ratio <= PLAYER_EDGE_GESTURE_START_MAX_Y_RATIO
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
type OverlayInteractionSource = "controls" | "composer";

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
      '[data-player-controls], button, input, select, textarea, [role="button"], [role="combobox"], [role="slider"], [contenteditable="true"]',
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
  onMobileRoomActionsChange,
}: PlayerPaneProps) {
  const compactViewport = useCompactPlayerViewport();
  const compactLandscapeViewport = useCompactLandscapePlayerViewport();
  const androidClient = getClientPlatform() === "android";
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
  const shouldMountSidePanel = sidePanelOpen || !compactViewport;
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
  const playbackStallAutoSwitchEnabled = useSettingsStore(
    (state) => state.playbackStallAutoSwitchEnabled,
  );
  const setAsrTranslationEnabled = useSettingsStore((state) => state.setAsrTranslationEnabled);
  const setAsrTranslationFrom = useSettingsStore((state) => state.setAsrTranslationFrom);
  const setAsrTranslationTo = useSettingsStore((state) => state.setAsrTranslationTo);
  const setAsrSpeakerDiarizationEnabled = useSettingsStore(
    (state) => state.setAsrSpeakerDiarizationEnabled,
  );
  const setPlaybackStallAutoSwitchEnabled = useSettingsStore(
    (state) => state.setPlaybackStallAutoSwitchEnabled,
  );
  const controlsHideTimerRef = useRef<number | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
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
  });
  const playerBrightnessRef = useRef(100);
  const brightnessShadeRef = useRef<HTMLDivElement | null>(null);
  const playerEdgeGestureRef = useRef<PlayerEdgeGestureState | null>(null);
  const playerEdgeGestureFeedbackRef = useRef<HTMLDivElement | null>(null);
  const playerEdgeGestureBrightnessIconRef = useRef<SVGSVGElement | null>(null);
  const playerEdgeGestureVolumeIconRef = useRef<SVGSVGElement | null>(null);
  const playerEdgeGestureLabelRef = useRef<HTMLSpanElement | null>(null);
  const playerEdgeGestureValueRef = useRef<HTMLElement | null>(null);
  const playerEdgeGestureFeedbackTimerRef = useRef<number | null>(null);
  const playerStageTapRef = useRef<PlayerStageTapState | null>(null);
  const playerStageTapTimerRef = useRef<number | null>(null);
  const lastPlayerStageTapAtRef = useRef(0);
  const player = useWebPlayer({
    playUrl,
    siteId,
    quality: qualities[qualityIndex]?.quality ?? null,
    sessionKey: roomSessionKey,
    reloadToken,
    onMediaFailure: onPlayerMediaFailure,
    onPlaying: onPlayerPlaying,
  });
  const androidPlayerControls = useAndroidPlayerControls(androidClient);
  // Landscape streams auto-rotate on Android fullscreen; portrait ones stay
  // upright because the lock is derived from the decoded frame size.
  useAndroidFullscreenOrientation({
    enabled: androidClient,
    fullscreen: player.mode === "fullscreen",
    aspectRatio: player.aspectRatio,
  });
  const changePlayerVolume = player.changeVolume;
  const toggleAndroidMediaMute = androidPlayerControls.toggleMediaMute;
  const togglePlayerMute = player.toggleMute;
  const togglePlayerPictureInPicture = player.togglePictureInPicture;
  const togglePlayerFullscreen = player.toggleFullscreen;
  useScreenWakeLock(player.running && !player.paused && !audioOnly);
  // This stays above the conditional side panel, so hiding that panel never
  // silently stops a session the user explicitly enabled.
  const autoDanmakuSend = useAutoDanmakuSend({ siteId, roomId, roomSessionKey });

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
  const handleToggleMute = useCallback(() => {
    if (androidClient) {
      toggleAndroidMediaMute();
      return;
    }
    togglePlayerMute();
  }, [androidClient, toggleAndroidMediaMute, togglePlayerMute]);
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
        icon: danmakuControl.icon === "message-circle" ? MessageCircle : MessageCircleOff,
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

  // Entering short landscape switches to an overlay drawer; rotating back to
  // portrait restores the immediately useful video + danmaku stack.
  useEffect(() => {
    setSidePanelOpen(sidePanelStartsOpen(compactLandscapeViewport));
  }, [compactLandscapeViewport]);

  // Simple Live keeps the player element at full level on mobile and only
  // adjusts the system media stream. Without this, Android would stack a
  // reduced <video>.volume on top of STREAM_MUSIC and make system volume
  // gestures feel broken.
  useEffect(() => {
    if (!androidClient) return;
    if (player.volume === 100 && !player.muted) return;
    changePlayerVolume(100);
  }, [androidClient, changePlayerVolume, player.muted, player.volume]);

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

  // Prefer exiting HTML/WebView fullscreen before room navigation. Native
  // custom-view fullscreen is already handled in MainActivity; this covers
  // the rare path where the browser reports fullscreen without a custom view.
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
    const controls = controlsRef.current;
    if (!controls) return;
    controls.dataset.visible = visible ? "true" : "false";
    controls.setAttribute("aria-hidden", String(!visible));
    controls.toggleAttribute("inert", !visible);
  }, []);

  const markControlsActivity = useCallback(() => {
    lastControlsActivityAtRef.current = Date.now();
  }, []);

  const hasKeyboardFocusWithinControls = useCallback(() => {
    if (!controlsFocusWithinRef.current) return false;
    const activeElement = document.activeElement;
    return (
      activeElement instanceof HTMLElement &&
      controlsRef.current?.contains(activeElement) === true &&
      activeElement.matches(":focus-visible")
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
        overlayInteractionSourcesRef.current.composer;
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
  });

  const clearPlayerEdgeGestureFeedbackTimer = useCallback(() => {
    if (playerEdgeGestureFeedbackTimerRef.current !== null) {
      window.clearTimeout(playerEdgeGestureFeedbackTimerRef.current);
      playerEdgeGestureFeedbackTimerRef.current = null;
    }
  }, []);

  const showPlayerEdgeGestureFeedback = useCallback(
    (kind: PlayerEdgeGesture, value: number) => {
      const feedback = playerEdgeGestureFeedbackRef.current;
      const brightnessIcon = playerEdgeGestureBrightnessIconRef.current;
      const volumeIcon = playerEdgeGestureVolumeIconRef.current;
      const label = playerEdgeGestureLabelRef.current;
      const valueNode = playerEdgeGestureValueRef.current;
      if (feedback) {
        feedback.dataset.kind = kind;
        feedback.dataset.playerEdgeGestureFeedback = kind;
        feedback.dataset.visible = "true";
      }
      if (brightnessIcon) brightnessIcon.style.display = kind === "brightness" ? "" : "none";
      if (volumeIcon) volumeIcon.style.display = kind === "volume" ? "" : "none";
      if (label) label.textContent = kind === "brightness" ? "亮度" : "音量";
      if (valueNode) valueNode.textContent = `${value}%`;
      clearPlayerEdgeGestureFeedbackTimer();
      playerEdgeGestureFeedbackTimerRef.current = window.setTimeout(() => {
        playerEdgeGestureFeedbackTimerRef.current = null;
        if (playerEdgeGestureFeedbackRef.current) {
          playerEdgeGestureFeedbackRef.current.dataset.visible = "false";
        }
      }, PLAYER_EDGE_GESTURE_FEEDBACK_DURATION_MS);
    },
    [clearPlayerEdgeGestureFeedbackTimer],
  );

  const setClampedPlayerBrightness = useCallback((value: number) => {
    const nextValue = Math.max(0, Math.min(100, Math.round(value)));
    if (playerBrightnessRef.current === nextValue) return;
    playerBrightnessRef.current = nextValue;
    if (brightnessShadeRef.current) {
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
        !androidClient ||
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
      const native = nativePlayerControlsActive;
      let startValue: number;
      if (kind === "brightness") {
        startValue = native
          ? (nativePlayerControlState?.brightness ?? playerBrightnessRef.current)
          : playerBrightnessRef.current;
      } else if (native) {
        // Prefer the last known system volume; never seed from <video>.volume
        // (forced to 100% on Android) or a first swipe jumps to full loudness.
        startValue = nativePlayerControlState?.mediaVolume ?? 50;
      } else {
        startValue = player.muted || player.volume === 0 ? 0 : player.volume;
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
      // Capturing keeps an adjustment continuous when the finger reaches a
      // stage edge in Android WebView fullscreen.
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [
      androidClient,
      nativePlayerControlState,
      nativePlayerControlsActive,
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
      const horizontalDistance = Math.abs(deltaX);
      const verticalDistance = Math.abs(deltaY);
      let beganAdjustment = false;

      if (!gesture.active) {
        if (
          horizontalDistance < PLAYER_EDGE_GESTURE_MIN_DISTANCE_PX &&
          verticalDistance < PLAYER_EDGE_GESTURE_MIN_DISTANCE_PX
        ) {
          return true;
        }
        if (!isVerticalPlayerEdgeGesture(deltaX, deltaY)) {
          playerEdgeGestureRef.current = null;
          releasePlayerEdgeGesturePointer(event.currentTarget, event.pointerId);
          return false;
        }
        gesture.active = true;
        beganAdjustment = true;
        // A recognised volume/brightness drag cancels any pending stage tap.
        clearPlayerStageTapTimer();
        lastPlayerStageTapAtRef.current = 0;
        playerStageTapRef.current = null;
      }

      event.preventDefault();
      const nextValue = androidPlayerControlStep(
        playerEdgeGestureValue(gesture.startValue, deltaY, gesture.stageHeight),
      );
      if (beganAdjustment || nextValue !== gesture.lastValue) {
        gesture.lastValue = nextValue;
        if (gesture.kind === "brightness") {
          if (gesture.native) {
            androidPlayerControls.setBrightness(nextValue);
          } else {
            setClampedPlayerBrightness(nextValue);
          }
        } else {
          if (gesture.native) {
            androidPlayerControls.setMediaVolume(nextValue);
          } else {
            changePlayerVolume(nextValue);
          }
        }
        showPlayerEdgeGestureFeedback(gesture.kind, nextValue);
      }
      return true;
    },
    [
      androidPlayerControls,
      changePlayerVolume,
      clearPlayerStageTapTimer,
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
        event.preventDefault();
      }
      return gesture.active;
    },
    [androidPlayerControls, releasePlayerEdgeGesturePointer],
  );

  const handlePlayerEdgeGestureCancel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const gesture = playerEdgeGestureRef.current;
      if (gesture && gesture.pointerId === event.pointerId) {
        playerEdgeGestureRef.current = null;
        releasePlayerEdgeGesturePointer(event.currentTarget, event.pointerId);
      }
      if (playerStageTapRef.current?.pointerId === event.pointerId) {
        playerStageTapRef.current = null;
      }
      clearPlayerStageTapTimer();
    },
    [clearPlayerStageTapTimer, releasePlayerEdgeGesturePointer],
  );

  const handleStagePointerActivity = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.type === "pointerdown") {
        event.currentTarget.focus({ preventScroll: true });
      }
      // Desktop/mouse keeps the always-reveal behaviour. Android touch uses an
      // explicit single-tap toggle so a second tap can hide the chrome again,
      // matching Simple Live rather than only resetting the auto-hide timer.
      if (androidClient && isTouchPointer(event.pointerType)) return;
      revealControls();
    },
    [androidClient, revealControls],
  );

  const handleStagePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.type === "pointerdown") {
        event.currentTarget.focus({ preventScroll: true });
      }

      if (
        androidClient &&
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
    [androidClient, handlePlayerEdgeGestureStart, handleStagePointerActivity],
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
      if (gestureConsumed) return;
      if (
        !androidClient ||
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
        // Double-tap toggles fullscreen the way Simple Live does on Android.
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
      androidClient,
      clearPlayerStageTapTimer,
      handlePlayerEdgeGestureEnd,
      showHost,
      toggleControls,
      togglePlayerFullscreen,
    ],
  );

  useEffect(() => clearPlayerEdgeGestureFeedbackTimer, [clearPlayerEdgeGestureFeedbackTimer]);
  useEffect(() => clearPlayerStageTapTimer, [clearPlayerStageTapTimer]);

  useEffect(() => {
    if (!androidClient || !androidPlayerControls.supported) return;
    playerBrightnessRef.current = 100;
    if (brightnessShadeRef.current) brightnessShadeRef.current.style.opacity = "0";
  }, [androidClient, androidPlayerControls.supported]);

  const focusFirstControl = useCallback(() => {
    // A hidden transparent bar must not be in the tab sequence.  After Tab
    // reveals it, explicitly put focus on its first usable control instead of
    // relying on an asynchronous React state update to affect this key's
    // native tab traversal.
    window.requestAnimationFrame(() => {
      const target = controlsRef.current?.querySelector<HTMLElement>(
        'button:not(:disabled), [role="combobox"]:not([aria-disabled="true"])',
      );
      target?.focus({ preventScroll: true });
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

  useEffect(() => {
    const onFullscreenChange = () => revealControls();
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, [revealControls]);

  return (
    <div
      className={cn(
        "relative flex h-full min-h-0 w-full bg-black",
        inlineCompactSidePanel && "flex-col",
      )}
    >
      <div
        className={cn(
          "relative flex min-w-0 flex-col bg-black",
          inlineCompactSidePanel && sidePanelOpen ? "w-full flex-none aspect-video" : "flex-1",
        )}
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <div
            ref={player.stageRef}
            data-player-stage
            data-fullscreen={player.mode === "fullscreen" ? "true" : undefined}
            data-audio-only={audioOnly ? "true" : undefined}
            className={cn(
              "relative min-h-0 flex-1 overflow-hidden bg-black",
              androidClient && showHost && "touch-none",
            )}
            tabIndex={0}
            aria-label={
              androidClient
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
                  className="z-10"
                />
              )}
              {/* Dimming only needs alpha composition. A full-surface CSS
                  brightness filter would re-filter both video and Canvas on
                  every gesture step in browser/bridge-fallback playback. */}
              <div
                ref={brightnessShadeRef}
                className="pointer-events-none absolute inset-0 z-[11] bg-black opacity-0"
                aria-hidden="true"
              />
            </div>

            {showHost && audioOnly && player.running && <AudioOnlyIndicator />}

            {showHost && !audioOnly && superChatEnabled && siteSupportsSuperChat(siteId) && (
              <SuperChatOverlay
                key={`sc:${roomSessionKey ?? "room"}`}
                active={danmakuActive}
                className="absolute bottom-[calc(4.75rem+env(safe-area-inset-bottom))] left-[max(0.75rem,env(safe-area-inset-left))] z-20 max-h-[calc(100%_-_5.5rem_-_env(safe-area-inset-bottom))] w-[min(240px,calc(100%-1.5rem))]"
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
                  className="pointer-events-none absolute inset-x-4 bottom-[calc(4.25rem+env(safe-area-inset-bottom))] z-20 flex justify-center"
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
              className="pointer-events-none absolute top-1/2 z-20 -translate-y-1/2 opacity-0 transition-opacity duration-100 ease-out data-[kind=brightness]:left-[max(1.25rem,env(safe-area-inset-left))] data-[kind=volume]:right-[max(1.25rem,env(safe-area-inset-right))] data-[visible=true]:opacity-100 motion-reduce:transition-none"
            >
              <div className="flex min-w-20 flex-col items-center gap-1 rounded-2xl border border-white/12 bg-black/72 px-3 py-2.5 text-white shadow-lg">
                <SunMedium ref={playerEdgeGestureBrightnessIconRef} className="size-5" />
                <Volume2
                  ref={playerEdgeGestureVolumeIconRef}
                  className="size-5"
                  style={{ display: "none" }}
                />
                <span ref={playerEdgeGestureLabelRef} className="text-[11px] text-white/70">
                  亮度
                </span>
                <strong
                  ref={playerEdgeGestureValueRef}
                  className="text-sm font-semibold tabular-nums"
                >
                  100%
                </strong>
              </div>
            </div>

            <div
              ref={controlsRef}
              data-player-controls
              data-visible="true"
              className={cn(
                // Keep the filtered surface stationary: moving backdrop blur
                // would resample the video on every transition frame. The data
                // attribute changes imperatively, so this compositor-only fade
                // also avoids reconciling the video, canvas and side panels.
                "absolute inset-x-0 bottom-0 z-30 [will-change:opacity] transition-opacity duration-150 ease-out motion-reduce:transition-none data-[visible=false]:pointer-events-none data-[visible=false]:opacity-0",
              )}
              onPointerEnter={holdControlsVisible}
              onPointerDown={(event) => {
                event.stopPropagation();
                holdControlsVisible();
              }}
              onPointerLeave={resumeControlsAutoHide}
              onFocusCapture={() => {
                controlsFocusWithinRef.current = true;
                holdControlsVisible();
              }}
              onBlurCapture={(event) => {
                const nextFocused = event.relatedTarget;
                if (nextFocused instanceof Node && event.currentTarget.contains(nextFocused)) {
                  controlsFocusWithinRef.current = true;
                  holdControlsVisible();
                  return;
                }
                controlsFocusWithinRef.current = false;
                resumeControlsAutoHide();
              }}
            >
              <PlayerControls
                paused={player.paused}
                volume={playerControlVolume}
                muted={playerControlMuted}
                audioOnly={audioOnly}
                sidePanelOpen={sidePanelOpen}
                sidePanelLabel={
                  compactViewport
                    ? sidePanelOpen
                      ? "收起直播间面板"
                      : "打开直播间面板"
                    : undefined
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
                stallAutoSwitchEnabled={playbackStallAutoSwitchEnabled}
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
                compact={compactViewport}
                portalContainer={player.stageRef}
                centerSlot={
                  !inlineCompactSidePanel ? (
                    <DanmakuComposer
                      siteId={siteId}
                      roomId={roomId}
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
                  // Android always targets STREAM_MUSIC. Falling back to the
                  // HTML element would only dim the WebView relative to the
                  // system volume the user already expects from live apps.
                  if (androidClient) {
                    androidPlayerControls.setMediaVolume(value);
                    return;
                  }
                  player.changeVolume(value);
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
                onStallAutoSwitchEnabledChange={setPlaybackStallAutoSwitchEnabled}
                onTogglePictureInPicture={handleTogglePictureInPicture}
                onToggleFullscreen={() => void player.toggleFullscreen()}
              />
            </div>
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
            "flex shrink-0 flex-col overflow-hidden bg-sidebar touch-pan-y overscroll-y-contain",
            inlineCompactSidePanel
              ? "min-h-0 w-full flex-1 border-t border-border/80"
              : compactLandscapeViewport
                ? compactLandscapeSidePanelClassName
                : "w-[300px] border-l border-border/80 lg:w-[320px]",
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
            <div
              ref={sideTabSwipe.pageRef as React.Ref<HTMLDivElement>}
              data-slot="horizontal-swipe-page"
              className="relative flex min-h-0 flex-1"
            >
              <TabsContent
                value="chat"
                keepMounted
                className="mt-0 min-h-0 flex-1 data-[hidden]:hidden"
              >
                <div className="flex h-full min-h-0 flex-col">
                  <DanmakuPanel
                    key={`chat:${roomSessionKey ?? "room"}`}
                    active={danmakuActive}
                    siteId={siteId}
                    roomId={roomId}
                    visible={sidePanelOpen && activeSideTab === "chat"}
                    statusText={danmakuStatusText}
                    className="min-h-0 flex-1"
                  />
                  {inlineCompactSidePanel && <DanmakuComposer siteId={siteId} roomId={roomId} />}
                </div>
              </TabsContent>
              <TabsContent
                value="follow"
                keepMounted
                className="mt-0 min-h-0 flex-1 data-[hidden]:hidden"
              >
                <FollowPanel className="h-full" />
              </TabsContent>
              <TabsContent
                value="settings"
                keepMounted
                className="mt-0 min-h-0 flex-1 data-[hidden]:hidden"
              >
                <DanmakuSettingsPanel
                  className="h-full"
                  autoSend={autoDanmakuSend}
                  siteId={siteId}
                />
              </TabsContent>
            </div>
          </Tabs>
        </aside>
      )}
    </div>
  );
}
