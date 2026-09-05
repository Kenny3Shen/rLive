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
  Lock,
  MessageSquareOff,
  MessageSquareText,
  PictureInPicture2,
  SunMedium,
  Unlock,
  VideoOff,
  Volume2,
  VolumeX,
  type LucideIcon,
} from "lucide-react";
import { ANDROID_BACK_EVENT } from "@/app/androidBackNavigation";
import { getClientPlatform } from "@/shared/clientPlatform";
import type { PlayUrl, SiteId } from "@/shared/types/live";
import { readPlayerVolume, rememberPlayerVolume } from "@/shared/playerVolume";
import { ErrorState } from "@/shared/components/ErrorState";
import { DanmakuPanel } from "./DanmakuPanel";
import { DanmakuSettingsPanel } from "./DanmakuSettingsPanel";
import { FollowPanel } from "./FollowPanel";
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
  PLAYER_CONTROL_BUTTON_CLASS,
  PLAYER_CONTROL_ICON_CLASS,
  PLAYER_OVERLAY_CONTROL_BUTTON_CLASS,
} from "@/shared/components/player/PlayerControls";
import { AudioOnlyIndicator } from "@/shared/components/player/AudioOnlyIndicator";
import { DanmuJsDanmaku } from "./danmaku/DanmuJsDanmaku";
import type { AutoDanmakuSendController } from "./danmaku/useAutoDanmakuSend";
import type { SleepTimerController } from "./useSleepTimer";
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
import { commitTween, killTweensOf, settleTween, tween } from "@/shared/motion/tween";

export type RoomSideTab = "chat" | "settings" | "follow";

export type PlayerMobileRoomAction = {
  id: "mute" | "audio-only" | "danmaku" | "asr" | "picture-in-picture";
  label: string;
  icon: LucideIcon;
  pressed?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

/** 把视觉页签顺序与触摸导航顺序保持在同一处。 */
export const ROOM_SIDE_TABS: readonly RoomSideTab[] = ["chat", "follow", "settings"];

// Android 经原生桥控制 Activity 亮度。其他移动客户端通过合成器阴影兜底
// 实现同样的画面局部手势。
export const PLAYER_EDGE_GESTURE_MIN_DISTANCE_PX = 12;
const PLAYER_EDGE_GESTURE_DIRECTION_RATIO = 1.25;
const PLAYER_EDGE_GESTURE_MIN_STAGE_HEIGHT_PX = 160;
// Bilibili 风格的调节让手指在整个画面高度上连续跟踪，
// 而不是按粗粒度的固定档位跳变。
const PLAYER_EDGE_GESTURE_DRAG_HEIGHT_RATIO = 1;
const PLAYER_EDGE_GESTURE_HUD_LINGER_MS = 520;
const PLAYER_EDGE_GESTURE_START_GUTTER_RATIO = 0.08;
// 对齐常见的移动端舞台交互：短按切换 chrome，
// 在此窗口内的第二次按击进入/退出全屏。
export const PLAYER_STAGE_TAP_MAX_DISTANCE_PX = 14;
export const PLAYER_STAGE_TAP_MAX_DURATION_MS = 320;
export const PLAYER_STAGE_DOUBLE_TAP_MS = 280;

/** 全屏桌面画面需要更大的目标；移动端保持紧凑胶囊，
 * 使三个操作不会遮住不成比例的视频区域。 */
export function shouldUseLargeDanmakuActionMenu(
  fullscreen: boolean,
  mobileClient: boolean,
): boolean {
  return fullscreen && !mobileClient;
}

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
  /** 快照原生可用性，使延迟到来的桥失败无法改变滑动路由。 */
  native: boolean;
};

type PlayerStageTapState = {
  pointerId: number;
  startX: number;
  startY: number;
  startedAt: number;
};

/** 左半边调节画面亮度；右半边调节音量。 */
export function playerEdgeGestureForStart(
  clientX: number,
  stageLeft: number,
  stageWidth: number,
): PlayerEdgeGesture {
  return clientX - stageLeft < Math.max(0, stageWidth) / 2 ? "brightness" : "volume";
}

/** 把 0-100 的兜底亮度转换为仅合成器的黑色叠加层。 */
export function playerBrightnessShadeOpacity(value: number): number {
  const brightness = Math.max(0, Math.min(100, value));
  return (100 - brightness) / 100;
}

/** 刻意的纵向拖拽优先于斜向或横向手势。 */
export function isVerticalPlayerEdgeGesture(deltaX: number, deltaY: number): boolean {
  const verticalDistance = Math.abs(deltaY);
  return (
    verticalDistance >= PLAYER_EDGE_GESTURE_MIN_DISTANCE_PX &&
    verticalDistance > Math.abs(deltaX) * PLAYER_EDGE_GESTURE_DIRECTION_RATIO
  );
}

export type PlayerEdgeGestureIntent = "pending" | "adjust" | "reject";

/**
 * 让短促的接触保持其原始的画面目标，直到它要么变成纵向调节、
 * 要么明确转变为其他手势。这对直播弹幕浮层尤其重要：
 * 它需要对应的 pointerup 来完成触摸命中测试。
 */
export function playerEdgeGestureIntent(deltaX: number, deltaY: number): PlayerEdgeGestureIntent {
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
 * 映射到完整 0–100 调节的拖拽距离。使用整个舞台使小幅手指移动连续可控，
 * 而不是忽跳忽停。
 */
export function playerEdgeGestureDragExtent(stageHeight: number): number {
  return (
    Math.max(PLAYER_EDGE_GESTURE_MIN_STAGE_HEIGHT_PX, stageHeight) *
    PLAYER_EDGE_GESTURE_DRAG_HEIGHT_RATIO
  );
}

/** 上下拖拽一个播放器高度对应完整的 0–100 调节。 */
export function playerEdgeGestureValue(
  startValue: number,
  deltaY: number,
  stageHeight: number,
): number {
  const height = playerEdgeGestureDragExtent(stageHeight);
  return Math.max(0, Math.min(100, startValue - (deltaY / height) * 100));
}

/**
 * 为系统边缘手势留下狭窄的上下留白。交互式播放 chrome 由
 * `isPlayerEdgeGestureIgnoredTarget` 单独排除。
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

/** 短促且基本不动的触摸是舞台点按，而不是拖拽手势。 */
export function isPlayerStageTap(deltaX: number, deltaY: number, durationMs: number): boolean {
  return (
    durationMs >= 0 &&
    durationMs <= PLAYER_STAGE_TAP_MAX_DURATION_MS &&
    Math.hypot(deltaX, deltaY) <= PLAYER_STAGE_TAP_MAX_DISTANCE_PX
  );
}

/** 双击窗口内的第二次短触摸切换全屏。 */
export function isPlayerStageDoubleTap(lastTapAt: number, now: number): boolean {
  return lastTapAt > 0 && now - lastTapAt <= PLAYER_STAGE_DOUBLE_TAP_MS;
}

/** 方向键每次调节的音量百分点。 */
export const PLAYER_VOLUME_KEY_STEP = 5;

/**
 * 上/下方向键的下一个音量值。静音时按上键从 0 起步，
 * 因此一次按键就能出声，而不是先要求手动取消静音。
 */
export function playerVolumeForKeyStep(volume: number, muted: boolean, direction: 1 | -1): number {
  const current = muted ? 0 : volume;
  const next = current + direction * PLAYER_VOLUME_KEY_STEP;
  return Math.max(0, Math.min(100, Math.round(next)));
}

/**
 * 全屏锁定只在移动端全屏出现：它要挡掉的正是单击/双击/边缘滑动这套触摸手势，
 * 桌面端没有误触问题，窗口化时也随时可以直接离开。
 */
export function showPlayerFullscreenLock(mobileClient: boolean, fullscreen: boolean): boolean {
  return mobileClient && fullscreen;
}

/**
 * 锁定期间画面手势全部让位给锁定按钮本身，否则用户既解不开锁、
 * 又会继续误触发音量和全屏。
 */
export function playerStageGesturesEnabled(fullscreenLocked: boolean): boolean {
  return !fullscreenLocked;
}

/**
 * 锁定期间两层 chrome 始终保持收起：画面手势已全部屏蔽，控制条露出来也无从操作。
 * 空闲唤醒态因此只作用于锁定按钮那一层。
 */
export function playerChromeVisible(visible: boolean, fullscreenLocked: boolean): boolean {
  return visible && !fullscreenLocked;
}

function isRoomSideTab(value: string): value is RoomSideTab {
  return ROOM_SIDE_TABS.includes(value as RoomSideTab);
}

const CONTROLS_HIDE_DELAY_MS = 2_600;
const OVERLAY_FOCUS_RESTORE_DELAY_MS = 160;
type OverlayInteractionSource = "controls" | "composer" | "hud";

function isTouchPointer(pointerType: string): boolean {
  // 少数 Android WebView 对手指输入暴露空的 pointerType。
  return pointerType === "touch" || pointerType === "";
}

/** 只在浮层确实遮住视频帧时才暂停浮动层。 */
export function shouldRunFloatingDanmaku({
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

/** 竖屏手机首次进入时把聊天直接显示在画面下方。 */
export function sidePanelStartsOpen(compactLandscapeViewport: boolean): boolean {
  return !compactLandscapeViewport;
}

/** 面板一旦打开就保持存活，使隐藏/全屏聊天能保留其队列。 */
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
 * 右侧栏是否可见。
 *
 * 只看网页全屏：原生全屏下舞台已经盘据浏览器 top layer，侧栏自然被盖住，
 * 无需（也不应）再给它加 `hidden` —— 那会把已挂载面板变成零尺寸，
 * 干扰弹幕列表的高度测量与钉住判定。网页全屏没有这层覆盖，必须真的从布局里拿掉。
 *
 * 隐藏不等于卸载：挂载仍由 `shouldRetainRoomSidePanel` 控制，因此退出后弹幕队列与滚动位置都还在。
 */
export function showRoomSidePanel(sidePanelOpen: boolean, webFullscreen: boolean): boolean {
  return sidePanelOpen && !webFullscreen;
}

/**
 * 舞台是否已经吃掉了 `RoomTopBar`，因此需要 HUD 把房间身份与工具补回画面内。
 *
 * 两种方式都算，缺口是同一个：原生全屏把顶栏盖在 top layer 之下，
 * 桌面网页全屏直接把它从布局里卸载。
 */
export function stageOwnsRoomTopBar(fullscreen: boolean, webFullscreen: boolean): boolean {
  return fullscreen || webFullscreen;
}

/**
 * HUD 返回箭头先退哪一层全屏。与 Escape 的按键习惯一致：原生全屏优先，
 * 两种全屏叠加时一次点击只收一层，网页全屏留给下一次。
 */
export function nextFullscreenLayerToExit(
  fullscreen: boolean,
  webFullscreen: boolean,
): "fullscreen" | "webFullscreen" | null {
  if (fullscreen) return "fullscreen";
  if (webFullscreen) return "webFullscreen";
  return null;
}

/**
 * 窗口化时该播放器是否把画面堆叠在聊天上方。
 *
 * 刻意与全屏无关。`player.mode` 派生自 `fullscreenchange` 状态更新，
 * 比浏览器自身的 `:fullscreen` 晚一帧；弥补这一差距的 CSS
 * （见 styles.css 的 `data-portrait-stack`）
 * 需要一个在过渡期间就已经正确的标记。
 */
export function usesPortraitStackLayout(
  inlineCompactSidePanel: boolean,
  sidePanelOpen: boolean,
): boolean {
  return inlineCompactSidePanel && sidePanelOpen;
}

/** 堆叠只适用于窗口化状态；全屏时画面拥有整个屏幕。 */
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
 * 播放器边缘滑动必须始于画面本身。特别是，起始于底部控制条的触摸
 * 绝不能在离开按钮命中目标后变成音量手势。
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
  /** 侧页签上方展示的紧凑主播身份。 */
  sideHeader?: ReactNode;
  danmakuActive?: boolean;
  danmakuStatusText?: string | null;
  qualities?: { quality: string }[];
  qualityIndex?: number;
  onQualityChange?: (index: number) => void;
  lines?: PlayUrl[];
  lineIndex?: number;
  onLineChange?: (index: number) => void;
  /** 刷新活动流元数据并重建 MSE 会话。 */
  onRefresh?: () => void;
  loadError?: string | null;
  reloadToken?: number;
  onPlayerMediaFailure?: (event: PlayerEvent) => void;
  onPlayerPlaying?: () => void;
  /** 稳定的房间身份，用于直接切换房间时丢弃消息。 */
  roomSessionKey?: string;
  /** 由 RoomPage 控制，使关注列表切换房间时保持该页签打开。 */
  sideTab?: RoomSideTab;
  onSideTabChange?: (tab: RoomSideTab) => void;
  /** 规范的房间身份，供平台专属的聊天控件使用。 */
  siteId?: SiteId;
  roomId?: string;
  roomTitle?: string;
  roomUserName?: string;
  roomUserAvatar?: string;
  roomOnline?: number;
  /** 由标题栏和全屏 HUD 渲染的房间级工具。 */
  autoDanmakuSend?: AutoDanmakuSendController;
  sleepTimer?: SleepTimerController;
  /**
   * 全屏 HUD 溢出菜单的房间级条目（复制链接、关注、多房间）。
   * 通常承载它们的应用 chrome 被全屏舞台覆盖，
   * 因此由页面把它们传递下来。
   */
  fullscreenRoomActions?: readonly PlayerHudRoomAction[];
  /**
   * 网页全屏（桌面）：画面占满应用窗口但不进入原生全屏。
   * 由 RoomPage 持有，因为一同让位的上下两条栏属于那一层；这里只负责隐藏右侧栏与提供开关。
   */
  webFullscreen?: boolean;
  onWebFullscreenChange?: (webFullscreen: boolean) => void;
  /**
   * 网页全屏时补进 HUD 的房间页控件（录制）。
   *
   * 刻意不在原生全屏使用：这些控件的 popover 默认 portal 到 `<body>`，
   * 会被位于 top layer 的 stage 压住，因此原生全屏仍只提供溢出菜单里的条目。
   */
  hudToolsSlot?: ReactNode;
  /** 把仅竖屏显示的次要控件发布到 RoomPage 的房间操作菜单。 */
  onMobileRoomActionsChange?: (actions: readonly PlayerMobileRoomAction[]) => void;
};

/**
 * 房间播放器 —— **xgplayer Web MSE 路径**（协议插件 + 本机代理）。
 *
 * 不使用 mpv / 原生 HWND / 伴随浮层窗口。视频与滚动弹幕共享同一 DOM 栈；
 * 离开房间卸载时全部干净停止。
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
  autoDanmakuSend,
  sleepTimer,
  fullscreenRoomActions = [],
  webFullscreen = false,
  onWebFullscreenChange,
  hudToolsSlot,
  onMobileRoomActionsChange,
}: PlayerPaneProps) {
  const compactViewport = useCompactPlayerViewport();
  const compactLandscapeViewport = useCompactLandscapePlayerViewport();
  const clientPlatform = getClientPlatform();
  const mobileClient = clientPlatform !== "desktop";
  const androidClient = clientPlatform === "android";
  // 竖屏手机使用常规的视频+聊天堆叠，新房间立即展示弹幕列表。较矮的横屏保持
  // 观看优先，改用可关闭的浮层抽屉。
  const [sidePanelOpen, setSidePanelOpen] = useState(() =>
    sidePanelStartsOpen(compactLandscapeViewport),
  );
  // PlayerPane 通常由 RoomPage 受控，但保留本地取值可为内嵌/非受控调用方维持
  // 同样的页签行为，并让触摸手势无需依赖 Base UI 内部即可选择页签。
  const [uncontrolledSideTab, setUncontrolledSideTab] = useState<RoomSideTab>("chat");
  const [castingDevice, setCastingDevice] = useState<string | null>(null);
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
  const [fullscreenLocked, setFullscreenLocked] = useState(false);
  // Android Back 监听器在 effect 中注册，读 state 会捕获注册时的旧值；
  // 锁定状态改由 ref 读取，使监听器身份保持稳定。
  const fullscreenLockedRef = useRef(false);
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
  // 全屏顶部 HUD 是同一空闲计时器上的第二层 chrome。
  const hudRef = useRef<HTMLDivElement | null>(null);
  // 移动端全屏锁定按钮是第三层：它同样跟随空闲计时器休眠，
  // 锁定只是把另两层强制留在收起态。
  const lockRef = useRef<HTMLDivElement | null>(null);
  const controlsVisibleRef = useRef(true);
  // 已写入 DOM 的锁定态。上锁与解锁都会改写 chrome 的目标可见性，
  // 因此唤醒态没变也必须重算一次。
  const appliedFullscreenLockRef = useRef(false);
  // 跟踪底部 chrome 内的焦点。点击的按钮也会取得 DOM 焦点，因此下方的空闲守卫
  // 在把焦点当作必须保持显示的键盘交互之前，还会额外检查 :focus-visible。
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
  // 音量记忆跨会话共享：只读一次 localStorage，作为网页层音量/静音的初值。
  const [initialAudio] = useState(readPlayerVolume);
  const player = useWebPlayer({
    playUrl,
    siteId,
    quality: qualities[qualityIndex]?.quality ?? null,
    // Android 音量经原生桥由 STREAM_MUSIC 控制；让 WebView 媒体元素保持单位增益，
    // 避免出现两层音量。也因此 Android 不参与音量记忆：系统媒体音量由 OS 自己
    // 记住，这里固定 100，读写这份记忆只会污染桌面端。
    initialVolume: androidClient ? 100 : initialAudio.volume,
    initialMuted: androidClient ? false : initialAudio.muted,
    sessionKey: roomSessionKey,
    reloadToken,
    onMediaFailure: onPlayerMediaFailure,
    onPlaying: onPlayerPlaying,
  });
  const androidPlayerControls = useAndroidPlayerControls(androidClient, roomSessionKey);
  // 横屏流在 Android 全屏时自动旋转；竖屏流保持直立，因为方向锁由解码后的帧尺寸决定。
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
  // 失败的 MSE 会话仍有流地址且必须可刷新；错误状态正是这个控件最有用的地方。
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

  // 音量记忆共享给所有播放表面；原生音量生效时真实音量是系统媒体音量，由 OS
  // 自己记住，这里不落盘以免把 100 写进桌面端的记忆。
  useEffect(() => {
    if (nativePlayerControlsActive) return;
    rememberPlayerVolume(player.volume, player.muted);
  }, [nativePlayerControlsActive, player.muted, player.volume]);
  /**
   * 键盘调节音量。刻意不复用 `handlePlayerVolumeChange`：它底下的 `changeVolume`
   * 在 video 处于 paused 时会补一次 `play()`（用于协议插件就绪但尚未起播的情况），
   * 于是暂停看画面时按方向键会意外恢复播放。这里改用 `setAudio`，
   * 与边缘滑动手势落盘时相同 —— 只写音量，不碰播放状态。
   */
  const handlePlayerVolumeKeyStep = useCallback(
    (direction: 1 | -1) => {
      const next = playerVolumeForKeyStep(playerControlVolume, playerControlMuted, direction);
      if (nativePlayerControlsActive && androidPlayerControls.setMediaVolume(next)) return;
      setPlayerAudio(next, next === 0);
    },
    [
      androidPlayerControls,
      nativePlayerControlsActive,
      playerControlMuted,
      playerControlVolume,
      setPlayerAudio,
    ],
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
        label: asr.captionsOn ? "关闭字幕" : "开启字幕",
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
  // 锁定按钮只在移动端全屏存在，因此它的层随全屏挂载与卸载。
  const fullscreenLockMounted = showPlayerFullscreenLock(
    mobileClient,
    player.mode === "fullscreen",
  );
  // 三层 chrome 的显隐是命令式的，渲染只负责给出与 DOM 当前值相同的初始/重渲染值。
  const fullscreenChromeVisible = playerChromeVisible(controlsVisibleRef.current, fullscreenLocked);
  const inlineCompactSidePanel = compactViewport && !compactLandscapeViewport;
  const mobileDrawerOpen = compactLandscapeViewport && sidePanelOpen;
  // 网页全屏要让出右侧栏。只影响可见性，不影响挂载，因此退出后弹幕队列与滚动位置都还在。
  const sidePanelVisible = showRoomSidePanel(sidePanelOpen, webFullscreen);
  const floatingDanmakuActive = shouldRunFloatingDanmaku({
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
  // 网页全屏卸载了 `RoomTopBar`，与原生全屏盖住它是同一处缺口：房间身份与工具都得在画面内补回。
  const stageOwnsTopBar = stageOwnsRoomTopBar(player.mode === "fullscreen", webFullscreen);
  const fullscreenHudVisible = showPlayerFullscreenHud({
    fullscreen: stageOwnsTopBar,
    hasRoomIdentity: Boolean(roomTitle?.trim() || roomUserName?.trim()),
    hasActions:
      fullscreenRoomActions.length > 0 ||
      mobileRoomActions.length > 0 ||
      autoDanmakuSend !== undefined ||
      sleepTimer !== undefined ||
      hudToolsSlot !== undefined,
  });

  // 进入较矮横屏时切换为浮层抽屉；转回竖屏恢复立即可用的视频+弹幕堆叠。
  useEffect(() => {
    setSidePanelOpen(sidePanelStartsOpen(compactLandscapeViewport));
  }, [compactLandscapeViewport]);

  // 新房间从头开始：清除保留标志，若此视口仍会挂载面板，
  // 让下方副作用在下一次渲染中再次置位。用清除而不是重新计算，
  // 可以保持依赖列表诚实 —— 重算出的值正是那个副作用推导的内容。
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

  // 网页全屏没有浏览器代管的退出路径（原生全屏由 UA 自己响应 Escape），
  // 因此在这里补上同一个按键习惯。
  //
  // 刻意跳过 `player.mode === "fullscreen"`：那种情况下 `useWebPlayer` 已经监听 Escape 去退出原生全屏，
  // 两个监听器同时响应会让一次按键连退两层。此时先退原生全屏，网页全屏留给下一次按键。
  useEffect(() => {
    if (!webFullscreen || player.mode === "fullscreen") return;
    const exitOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onWebFullscreenChange?.(false);
    };
    window.addEventListener("keydown", exitOnEscape);
    return () => window.removeEventListener("keydown", exitOnEscape);
  }, [onWebFullscreenChange, player.mode, webFullscreen]);

  // toast 默认经 `<body>` portal，两条路径下都会被全屏舞台盖住
  // （浏览器 top layer，以及桌面原生窗口使用的页面内固定层）。
  // 只要本播放器拥有屏幕，就把 viewport 迁移过去，
  // 使复制/关注反馈保持可见。
  useEffect(() => {
    if (player.mode !== "fullscreen") return;
    const stage = player.stageRef.current;
    if (!stage) return;
    setToastPortalContainer(stage);
    return () => setToastPortalContainer(null);
  }, [player.mode, player.stageRef]);

  // 锁定属于全屏会话。离开全屏（含直接切房、路由变更）必须解锁，
  // 否则窗口化播放器会带着一个不可见的手势屏蔽状态。
  useEffect(() => {
    if (player.mode !== "fullscreen") setFullscreenLocked(false);
  }, [player.mode]);

  // 切房是新的观看会话，不继承上一间的锁定。
  useEffect(() => {
    setFullscreenLocked(false);
  }, [roomSessionKey]);

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

  const applyFullscreenLockVisibility = useCallback((visible: boolean) => {
    const lock = lockRef.current;
    if (!lock) return;
    lock.dataset.visible = visible ? "true" : "false";
    lock.setAttribute("aria-hidden", String(!visible));
    lock.toggleAttribute("inert", !visible);
  }, []);

  const setControlVisibility = useCallback(
    (visible: boolean) => {
      const locked = fullscreenLockedRef.current;
      if (controlsVisibleRef.current === visible && appliedFullscreenLockRef.current === locked) {
        return;
      }
      controlsVisibleRef.current = visible;
      appliedFullscreenLockRef.current = locked;

      // 隐藏控件过去会更新 PlayerPane 状态。那会在动画开始的瞬间重渲染直播弹幕层
      // 和每个保活的侧页签，繁忙弹幕流中可以感知到。这块仅限 DOM 的小状态刻意隔离在
      // 浮层内：CSS 仍然执行合成淡出，
      // 而视频、弹幕层和列表无需 React 协调即可继续现有工作。
      //
      // 两层 chrome 都从这里驱动，使全屏顶部 HUD 与底部控制条
      // 始终作为一个整体表面出现和淡出；锁定期间它们被强制留在收起态。
      const chromeVisible = playerChromeVisible(visible, locked);
      for (const layer of [controlsRef.current, hudRef.current]) {
        if (!layer) continue;
        layer.dataset.visible = chromeVisible ? "true" : "false";
        layer.setAttribute("aria-hidden", String(!chromeVisible));
        layer.toggleAttribute("inert", !chromeVisible);
      }

      // 锁定按钮同样跟随唤醒态休眠，不再长期遮挡画面。锁定时它是唯一的解锁入口，
      // 因此休眠后由舞台触摸单独唤回（见 `handleStagePointerDown` / `handleStagePointerUp`），
      // 否则用户会被困在全屏里。
      applyFullscreenLockVisibility(visible);
    },
    [applyFullscreenLockVisibility],
  );

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
      hudRef.current?.contains(activeElement) === true ||
      // 锁定按钮层也算：键盘用户把焦点停在它上面时，它是唯一的解锁入口，
      // 不能被 idle timer 加上 `inert` 强制 blur。
      lockRef.current?.contains(activeElement) === true
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

    // 指针事件可能以屏幕刷新率触发。与其为每次事件都重置一个超时，
    // 不如只保留一个计时器，唤醒时检查最新的活动时间戳。
    // 这使视频/弹幕主线程保持空闲，
    // 同时维持精确的空闲延迟契约。
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

  /** Simple Live 式单击：隐藏时显示，已可见时隐藏。 */
  const toggleControls = useCallback(() => {
    if (controlsVisibleRef.current) {
      hideControls();
      return;
    }
    revealControls();
  }, [hideControls, revealControls]);

  /**
   * 上锁时收起两层 chrome 只留锁定按钮，解锁时把 chrome 带回来。
   * 两个方向都走 `revealControls`：锁定态已写入 ref，`setControlVisibility` 会据此
   * 把 chrome 强制留在收起态，而锁定按钮先保持唤醒并重新排定空闲倒计时——
   * 手刚离开按钮它就消失会让人以为点错了。
   */
  const handleToggleFullscreenLock = useCallback(() => {
    // 不变量：置为锁定只走这里，且 ref 必须先于 state 赋值。渲染期的
    // `fullscreenChromeVisible` 读 state，命令式写入读 ref，反向分叉（state 已锁定而 ref 未锁定）
    // 会把 chrome 错误地钉在隐藏态。
    const nextLocked = !fullscreenLockedRef.current;
    fullscreenLockedRef.current = nextLocked;
    setFullscreenLocked(nextLocked);
    revealControls();
  }, [revealControls]);

  // 锁定态同时决定两层 chrome 的目标可见性，而解锁不只来自点按：离开全屏与切房
  // 都会复位。因此同步 ref 后还要重算一次，否则 chrome 会停在锁定期间的收起态。
  // Back 监听器也认这个 ref（注册在 effect 内，读 state 会捕获注册时的旧值）。
  useEffect(() => {
    const wasLocked = fullscreenLockedRef.current;
    fullscreenLockedRef.current = fullscreenLocked;
    if (fullscreenLocked || !wasLocked) return;
    revealControls();
  }, [fullscreenLocked, revealControls]);

  // 锁定按钮层随进入全屏挂载，而双击进入全屏不经过 `revealControls`：那时两层
  // chrome 可能已经休眠。挂载后同步一次，否则按钮会以 `data-visible="true"` 孤立常驻。
  useEffect(() => {
    if (!fullscreenLockMounted) return;
    applyFullscreenLockVisibility(controlsVisibleRef.current);
  }, [applyFullscreenLockVisibility, fullscreenLockMounted]);

  // 房间导航前先退出全屏。这是 Android 页面内全屏唯一的 Back 处理：
  // Activity 刻意不为它消费 Back，
  // 使上方的浮层监听器（HUD 菜单、音量面板）能在同一事件中获得自己的机会。
  useEffect(() => {
    if (player.mode !== "fullscreen") return;
    const exitOnAndroidBack = (event: Event) => {
      event.preventDefault();
      // 锁定就是为了屏蔽误触，Back 也不例外：消费掉事件但不退出全屏，
      // 只把休眠中的锁定按钮唤回来，告知用户解锁入口在哪里。
      if (fullscreenLockedRef.current) {
        revealControls();
        return;
      }
      void togglePlayerFullscreen();
    };
    window.addEventListener(ANDROID_BACK_EVENT, exitOnAndroidBack);
    return () => window.removeEventListener(ANDROID_BACK_EVENT, exitOnAndroidBack);
  }, [player.mode, revealControls, togglePlayerFullscreen]);

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

  /**
   * 带 `exitsFullscreen` 的 HUD 动作要靠应用层 chrome（对话框、toast、另一条路由）应答，
   * 因此必须退出「当前那一种」全屏：原生全屏交给播放器，网页全屏交给 RoomPage 把两条栏装回来。
   * 只退其中一种会让确认框继续被另一种盖住。
   */
  const handleExitAnyFullscreen = useCallback(async () => {
    if (webFullscreen) onWebFullscreenChange?.(false);
    await player.exitFullscreen();
  }, [onWebFullscreenChange, player, webFullscreen]);

  /**
   * HUD 返回箭头：按层退出全屏，与 Escape 的习惯一致 —— 原生全屏先退，
   * 两种全屏叠加时网页全屏留给下一次点击，避免一次点击连退两层。
   */
  const handleHudBack = useCallback(() => {
    const layer = nextFullscreenLayerToExit(player.mode === "fullscreen", webFullscreen);
    if (layer === "fullscreen") {
      void player.exitFullscreen();
      return;
    }
    if (layer === "webFullscreen") onWebFullscreenChange?.(false);
  }, [onWebFullscreenChange, player, webFullscreen]);

  // 指针或键盘焦点位于其中时，两层 chrome 保持自身可见，
  // 且在两者之间 Tab 不得重启空闲倒计时。
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
          hudRef.current?.contains(nextFocused) === true ||
          lockRef.current?.contains(nextFocused) === true)
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
    () => () => {
      const feedback = playerEdgeGestureFeedbackRef.current;
      const panel = playerEdgeGesturePanelRef.current;
      if (!feedback) return;
      const wasVisible = feedback.dataset.visible === "true";
      feedback.dataset.visible = "true";
      if (wasVisible) return;

      if (prefersReducedMotion()) {
        killTweensOf(feedback);
        if (panel) killTweensOf(panel);
        feedback.style.opacity = "1";
        if (panel) panel.style.transform = "scale(1)";
        return;
      }
      // 提示层的自然态是 opacity-0 / scale(0.97)，展开后的终态由 commitTween 固化为
      // 内联样式持有；隐藏补间的结束帧才回到自然态，由 settleTween 归还。
      // 不能用 fill 持有展开态：已完成的填充动画会被部分 WebView 从
      // getAnimations() 移除而效果仍挂在级联上，之后任何 cancel 都无法清除，
      // 隐藏淡出结束的瞬间会跳回旧效果并永久卡在展开态（提示卡不消失）。
      // 起点读当前计算值而不是固定常量：隐藏中途再次手势时从当前透明度/缩放
      // 平滑接续（GSAP `.to` 的语义），不跳回起点。
      const feedbackFrom = getComputedStyle(feedback).opacity;
      const panelFrom = panel ? getComputedStyle(panel).transform : null;
      commitTween(
        tween(feedback, [{ opacity: feedbackFrom }, { opacity: "1" }], {
          duration: 160,
          easing: EASE_OUT,
          fill: "both",
        }),
      );
      if (panel && panelFrom) {
        commitTween(
          tween(panel, [{ transform: panelFrom }, { transform: "scale(1)" }], {
            duration: 160,
            easing: EASE_OUT,
            fill: "both",
          }),
        );
      }
    },
    [],
  );

  const hidePlayerEdgeGestureFeedback = useMemo(
    () => () => {
      const feedback = playerEdgeGestureFeedbackRef.current;
      const panel = playerEdgeGesturePanelRef.current;
      if (!feedback || feedback.dataset.visible !== "true") return;
      feedback.dataset.visible = "false";

      if (prefersReducedMotion()) {
        killTweensOf(feedback);
        if (panel) killTweensOf(panel);
        feedback.style.opacity = "0";
        if (panel) panel.style.transform = "";
        return;
      }
      const feedbackFrom = getComputedStyle(feedback).opacity;
      const panelFrom = panel ? getComputedStyle(panel).transform : null;
      settleTween(
        feedback,
        tween(feedback, [{ opacity: feedbackFrom }, { opacity: "0" }], {
          duration: 140,
          easing: EASE_OUT,
          fill: "both",
        }),
      );
      if (panel && panelFrom) {
        settleTween(
          panel,
          tween(panel, [{ transform: panelFrom }, { transform: "scale(0.97)" }], {
            duration: 140,
            easing: EASE_OUT,
            fill: "both",
          }),
        );
      }
    },
    [],
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
        !playerStageGesturesEnabled(fullscreenLocked) ||
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
      // Android 经原生桥同时控制亮度与音量。
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
      fullscreenLocked,
      mobileClient,
      nativePlayerControlsActive,
      nativePlayerControlState,
      player.muted,
      player.volume,
      showHost,
    ],
  );

  /** 返回该指针是否属于一次待处理/进行中的边缘手势。 */
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
        // 不要在 pointerdown 时捕获：短触摸必须保持其原始目标，
        // 使弹幕层能收到 pointerup 并完成命中测试。一旦接触被确认是真正的调节，
        // 捕获可以在 Android WebView 全屏中手指到达舞台边缘时保持连续。
        event.currentTarget.setPointerCapture(event.pointerId);
        // 识别出的音量/亮度拖拽会取消任何待处理的舞台点按。
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
      // 桌面/鼠标保持"总是显示"的行为。移动端触摸使用显式的单击切换，
      // 使第二次点击可以再次隐藏 chrome，
      // 对齐常见移动播放器，而不只是重置计时器。
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
        // 锁定期间按下的第一时间就把休眠的锁定按钮唤回来：这时没有别的手势会跟这次
        // 触摸抢，慢按一下也该立刻有反应，而不是等抬手后再判定是否算点按。
        if (!playerStageGesturesEnabled(fullscreenLocked)) revealControls();
        handlePlayerEdgeGestureStart(event);
        return;
      }

      handleStagePointerActivity(event);
      handlePlayerEdgeGestureStart(event);
    },
    [
      fullscreenLocked,
      handlePlayerEdgeGestureStart,
      handleStagePointerActivity,
      mobileClient,
      revealControls,
    ],
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
      if (
        !mobileClient ||
        !isTouchPointer(event.pointerType) ||
        isPlayerEdgeGestureIgnoredTarget(event.target)
      ) {
        return;
      }

      const durationMs = Date.now() - tap.startedAt;
      const isTap = isPlayerStageTap(
        event.clientX - tap.startX,
        event.clientY - tap.startY,
        durationMs,
      );

      // 锁定期间点按不得切换 chrome 或全屏，但必须能把休眠的锁定按钮叫回来：
      // 画面手势已全部失效时它是唯一的解锁入口。弹幕层等子级浮层认领过的点按同样
      // 放行唤醒，否则落在弹幕上的一次点按会静默丢失。
      // 唤醒刻意不看 `showHost`：加载/报错态下锁定按钮仍然挂载，此时更不能让它睡死。
      if (!playerStageGesturesEnabled(fullscreenLocked)) {
        // 长按与拖动同样算有意交互：从抬手时刻重排倒计时，避免手指还在屏上按钮就先睡回去。
        // 只有点按需要 preventDefault 认领，免得祖先层把它当成自己的手势。
        if (isTap) event.preventDefault();
        revealControls();
        return;
      }

      if (!showHost) return;

      // 子级画面浮层用 preventDefault 认领已完成的点按。仍让事件到达这里以清理
      // 待处理的边缘/点按状态，
      // 但绝不能把那次已认领的按压变成播放或全屏 chrome 操作。
      if (gestureConsumed || event.defaultPrevented) return;
      if (!isTap) return;

      event.preventDefault();
      const now = Date.now();
      if (isPlayerStageDoubleTap(lastPlayerStageTapAtRef.current, now)) {
        clearPlayerStageTapTimer();
        lastPlayerStageTapAtRef.current = 0;
        // 双击切换全屏，与其他移动视频播放器一致。
        void togglePlayerFullscreen();
        return;
      }

      lastPlayerStageTapAtRef.current = now;
      clearPlayerStageTapTimer();
      // 延迟单击动作，使第二次点按能够认领双击全屏，
      // 而不会先闪一下控制条。
      playerStageTapTimerRef.current = window.setTimeout(() => {
        playerStageTapTimerRef.current = null;
        lastPlayerStageTapAtRef.current = 0;
        toggleControls();
      }, PLAYER_STAGE_DOUBLE_TAP_MS);
    },
    [
      clearPlayerStageTapTimer,
      fullscreenLocked,
      handlePlayerEdgeGestureEnd,
      mobileClient,
      revealControls,
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
    // 隐藏的透明 chrome 不得进入 Tab 序列。Tab 揭示它之后，
    // 显式把焦点放到其第一个可用控件上，
    // 而不是依赖异步 React 状态更新来影响此 key 的原生 Tab 遍历。
    //
    // 各层按 DOM 顺序访问，因此全屏会话从顶部 HUD 进入，
    // Tab 自然向下继续到底部控制条。
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

      // 音量键在 repeat 守卫之前处理：按住方向键连续调节是音量控件的预期行为，
      // 而播放/静音/全屏这类切换必须每次按下只触发一次。
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        if (transportDisabled) return;
        event.preventDefault();
        revealControls();
        handlePlayerVolumeKeyStep(event.key === "ArrowUp" ? 1 : -1);
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
    [focusFirstControl, handlePlayerVolumeKeyStep, player, revealControls, transportDisabled],
  );

  // 直播播放默认不受遮挡，而任何指针、触摸或键盘交互都会立即带回底部 chrome。
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
    // 直接切换房间会卸载 popover，但仍重置来源围栏作为兜底，
    // 使正在关闭的 portal 绝不可能为下一个房间钉住控件。
    overlayInteractionSourcesRef.current.controls = false;
    overlayInteractionSourcesRef.current.composer = false;
    overlayInteractionSourcesRef.current.hud = false;
    overlayInteractionOpenRef.current = false;
    controlsFocusWithinRef.current = false;
    setOverlayInteractionOpen(false);
  }, [roomSessionKey]);

  useEffect(() => {
    if (overlayInteractionOpen) return;
    // Base UI 会把经 portal 的 Select/Popover 焦点归还给其触发器。它的退出过渡为
    // 100ms，因此在焦点恢复之后再调度，
    // 避免那个焦点处理器清掉空闲计时器。
    const timer = window.setTimeout(resumeControlsAutoHide, OVERLAY_FOCUS_RESTORE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [overlayInteractionOpen, resumeControlsAutoHide]);

  // 每次全屏切换之后都显示控件，无论由哪种实现执行。以 `player.mode` 为 key
  // 而不是 `fullscreenchange`，
  // 因为桌面与 Android 页面内固定层从不触发该事件。
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
          // 与全屏无关，使 CSS 能在浏览器离开全屏的同一帧恢复 16:9 堆叠。
          data-portrait-stack={portraitStackLayout ? "true" : undefined}
          data-audio-only={audioOnly ? "true" : undefined}
          // 锚定在控件上方的浮层（超级留言、字幕）必须清出与 chrome 相同的手势栏预留，
          // 且仅在 chrome 真正预留时生效。
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
              ? "直播播放器；单击显示或隐藏控制条，双击全屏；左侧上下滑动调节亮度，右侧上下滑动调节音量；按空格或 K 播放或暂停，M 静音，F 全屏，上下方向键调节音量"
              : "直播播放器；按空格或 K 播放或暂停，M 静音，F 全屏，上下方向键调节音量"
          }
          aria-keyshortcuts="Space K M F ArrowUp ArrowDown"
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
                {/* key=mediaKey 在离开/重进后强制一个干净的 <video>（MSE）。 */}
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

              {/* 悬浮弹幕跟随画面亮度，
                  而控件与房间信息保持正常对比度。 */}
              {showHost && osdOn && !audioOnly && (
                <DanmuJsDanmaku
                  active={floatingDanmakuActive}
                  sessionKey={danmakuSessionKey}
                  siteId={siteId}
                  roomId={roomId}
                  roomTitle={roomTitle}
                  roomUserName={roomUserName}
                  large={shouldUseLargeDanmakuActionMenu(
                    player.mode === "fullscreen",
                    mobileClient,
                  )}
                  className="z-10"
                />
              )}
              {/* 调暗只需要 alpha 合成。整面 CSS brightness 滤镜会在浏览器/桥兜底播放中
                  于每一步手势时对视频和弹幕层重复滤波。 */}
              <div
                ref={brightnessShadeRef}
                data-player-brightness-shade
                className="pointer-events-none absolute inset-0 z-[11] bg-black opacity-0"
                aria-hidden="true"
              />
            </div>

            {showHost && audioOnly && player.running && <AudioOnlyIndicator />}

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
              className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center opacity-0 [will-change:opacity]"
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
              /* 渲染值必须与 `setControlVisibility` 写入的目标值一致：React 只在渲染值
                 变化时改写属性，两者一旦分叉，锁定期间的任何一次重渲染都会把 chrome
                 patch 回可见。 */
              data-visible={fullscreenChromeVisible ? "true" : "false"}
              aria-hidden={!fullscreenChromeVisible}
              className={cn(
                // 底部 chrome 的镜像：视频表面的 fixed 定位兄弟节点，悬浮于顶边而不占布局
                // 高度，由同一个命令式 data 属性驱动淡入淡出，
                // 使空闲计时器不会引发 React 协调。
                "absolute inset-x-0 top-0 z-30 [will-change:opacity] transition-opacity duration-150 ease-out motion-reduced:transition-none data-[visible=false]:pointer-events-none data-[visible=false]:opacity-0",
              )}
              onPointerEnter={holdControlsVisible}
              onPointerDown={handleChromePointerDown}
              onPointerLeave={resumeControlsAutoHide}
              onFocusCapture={handleChromeFocusCapture}
              onBlurCapture={handleChromeBlurCapture}
            >
              <PlayerFullscreenHud
                onBack={handleHudBack}
                backLabel={player.mode === "fullscreen" ? "退出全屏" : "退出网页全屏"}
                siteId={siteId}
                roomId={roomId}
                roomTitle={roomTitle}
                roomUserName={roomUserName}
                roomUserAvatar={roomUserAvatar}
                roomOnline={roomOnline}
                roomActions={fullscreenRoomActions}
                playerActions={mobileRoomActions}
                autoSend={autoDanmakuSend}
                sleepTimer={sleepTimer}
                cast={{
                  url: playUrl?.url ?? null,
                  headers: playUrl?.headers ?? {},
                  title: roomTitle || roomUserName || "rLive 直播",
                  device: castingDevice,
                  onDeviceChange: setCastingDevice,
                }}
                toolsSlot={webFullscreen ? hudToolsSlot : undefined}
                compact={compactViewport}
                // 只有原生全屏需要把菜单塞进 stage：它位于 top layer，portal 到 `<body>`
                // 会被整个压住。网页全屏没有这层，走默认 portal 反而不会被 stage 的
                // `overflow-hidden` 裁掉。
                portalContainer={player.mode === "fullscreen" ? player.stageRef : undefined}
                onOverlayInteractionChange={handleHudOverlayInteractionChange}
                onExitFullscreen={handleExitAnyFullscreen}
              />
            </div>
          )}

          <div
            ref={controlsRef}
            data-player-controls
            data-visible={fullscreenChromeVisible ? "true" : "false"}
            aria-hidden={!fullscreenChromeVisible}
            className={cn(
              // chrome 悬浮于画面底边而不消耗布局高度，隐藏它即把整个舞台还给视频。
              // 保持被滤镜的表面静止：移动的背景模糊会在过渡的每一帧重新采样视频。
              // data 属性以命令式变更，
              // 这种仅合成器的淡出也避免了对视频、弹幕层和侧面板的协调。
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
              webFullscreen={webFullscreen}
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
              // 能力是设备级且稳定的；保持控件挂载，
              // 使重连循环（loading 反复切换）无法让 chrome 闪烁。
              // transportDisabled 覆盖不可用状态。
              pictureInPictureSupported={player.pictureInPictureSupported}
              pictureInPictureActive={player.pictureInPictureActive}
              pictureInPictureDisabled={
                !player.running || player.mode === "fullscreen" || audioOnly
              }
              loadError={loadError}
              disabled={transportDisabled}
              // 竖屏把弹幕面板堆叠在画面之下，控件悬浮于视频底边而非窗口底边 ——
              // 那里没有手势栏 inset。
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
                    // 输入框位于播放器 chrome 内部，其快捷选择器必须 portal 进舞台而不是 `<body>`：
                    // 全屏会把舞台放入 top layer（Tauri 客户端则是固定 z-index 层），
                    // body 级弹窗会被压在其下。
                    portalContainer={player.stageRef}
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
              onToggleWebFullscreen={
                onWebFullscreenChange ? () => onWebFullscreenChange(!webFullscreen) : undefined
              }
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

          {fullscreenLockMounted && (
            <div
              ref={lockRef}
              data-player-fullscreen-lock
              data-visible={controlsVisibleRef.current ? "true" : "false"}
              aria-hidden={!controlsVisibleRef.current}
              /* 锁定按钮是画面手势之外的独立表面，但它与两层 chrome 共享同一个空闲
                 计时器：锁定期间也会休眠淡出，随后由舞台点按唤回。 */
              className="absolute top-1/2 left-[max(0.5rem,env(safe-area-inset-left))] z-40 -translate-y-1/2 [will-change:opacity] transition-opacity duration-150 ease-out motion-reduced:transition-none data-[visible=false]:pointer-events-none data-[visible=false]:opacity-0"
              onPointerEnter={holdControlsVisible}
              onPointerDown={handleChromePointerDown}
              onPointerLeave={resumeControlsAutoHide}
              onFocusCapture={handleChromeFocusCapture}
              onBlurCapture={handleChromeBlurCapture}
            >
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={fullscreenLocked ? "解锁全屏手势" : "锁定全屏手势"}
                aria-pressed={fullscreenLocked}
                className={cn(
                  PLAYER_CONTROL_BUTTON_CLASS,
                  PLAYER_CONTROL_ICON_CLASS,
                  PLAYER_OVERLAY_CONTROL_BUTTON_CLASS,
                  "bg-black/40 hover:bg-black/55",
                  fullscreenLocked && "bg-black/60",
                )}
                onClick={handleToggleFullscreenLock}
              >
                {fullscreenLocked ? <Lock /> : <Unlock />}
              </Button>
            </div>
          )}
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
          aria-hidden={!sidePanelVisible}
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
            !sidePanelVisible && "hidden",
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
                      sidePanelVisible,
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
                  <DanmakuSettingsPanel className="h-full" siteId={siteId} />
                </div>
              </div>
            </div>
          </Tabs>
        </aside>
      )}
    </div>
  );
}
