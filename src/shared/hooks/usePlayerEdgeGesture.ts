import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import {
  canStartPlayerEdgeGesture,
  playerBrightnessShadeOpacity,
  playerEdgeGestureForStart,
  playerEdgeGestureIntent,
  playerEdgeGestureValue,
  isTouchLikePointer,
  PLAYER_EDGE_GESTURE_HUD_LINGER_MS,
  type PlayerEdgeGesture,
} from "@/shared/gestures/playerEdgeGesture";
import { EASE_OUT, prefersReducedMotion } from "@/shared/motion/tokens";
import { commitTween, killTweensOf, settleTween, tween } from "@/shared/motion/tween";
import type { AndroidPlayerControlsState } from "@/features/room/player/androidPlayerControls";

/**
 * 反馈卡内部各节点的 ref 集合。手势每帧只写这几个节点的文本/transform，
 * 不经 React 状态 —— 拖动期间弹幕层与视频都在动，逐帧协调会被感知到。
 */
export type PlayerEdgeGestureFeedbackRefs = {
  root: RefObject<HTMLDivElement | null>;
  panel: RefObject<HTMLDivElement | null>;
  brightnessIcon: RefObject<SVGSVGElement | null>;
  volumeIcon: RefObject<SVGSVGElement | null>;
  label: RefObject<HTMLSpanElement | null>;
  value: RefObject<HTMLElement | null>;
  progress: RefObject<HTMLSpanElement | null>;
};

/** 原生桥的最小契约：Android 用它同时控制系统媒体音量与 Activity 亮度。 */
export type PlayerEdgeGestureNativeBridge = {
  setBrightness: (value: number) => boolean;
  setMediaVolume: (value: number) => boolean;
  flush: () => void;
};

type PlayerEdgeGestureState = {
  pointerId: number;
  target: HTMLElement;
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

export type PlayerEdgeGestureOptions = {
  /** 手势总闸：移动端 + 有画面 + 未锁定全屏时为 true。 */
  enabled: boolean;
  /** 元素音量 0–100 与静音态，用于非原生路径的起始值。 */
  volume: number;
  muted: boolean;
  /** 拖动中的音量预览（不落盘、不记忆）。 */
  onPreviewVolume: (value: number) => void;
  /** 松手时提交音量（写入媒体元素并记忆）。 */
  onCommitVolume: (value: number, muted: boolean) => void;
  /** 原生桥可用时的实例；不可用传 null，手势回落元素音量 + 合成器亮度罩。 */
  native: PlayerEdgeGestureNativeBridge | null;
  /** 原生桥上报的系统音量/亮度快照，用于起始值与外部变更同步。 */
  nativeState: AndroidPlayerControlsState | null;
  /** 起点落在播放 chrome 上时不启动手势。 */
  isIgnoredTarget: (target: EventTarget | null) => boolean;
  /** 手势确认为调节的那一刻通知宿主（取消待定点按/长按）。 */
  onAdjustStart?: () => void;
  /** 会话 key 变化时把兜底亮度复位（换房间、换视频）。 */
  sessionKey?: string;
};

/**
 * 画面左右半边纵向滑动调节亮度/音量的命令式实现。
 *
 * 直播页与视频页共用：两页只需把返回的四个处理器接到自己的舞台指针事件上，
 * 并渲染 `PlayerEdgeGestureFeedback` 与亮度罩两层。`move`/`end` 返回布尔值
 * 表示本次指针是否已被手势认领，宿主据此跳过自己的点按/换片判定。
 */
export function usePlayerEdgeGesture({
  enabled,
  volume,
  muted,
  onPreviewVolume,
  onCommitVolume,
  native,
  nativeState,
  isIgnoredTarget,
  onAdjustStart,
  sessionKey = "",
}: PlayerEdgeGestureOptions) {
  const gestureRef = useRef<PlayerEdgeGestureState | null>(null);
  const brightnessRef = useRef(100);
  const brightnessShadeRef = useRef<HTMLDivElement | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const brightnessIcon = useRef<SVGSVGElement | null>(null);
  const volumeIcon = useRef<SVGSVGElement | null>(null);
  const label = useRef<HTMLSpanElement | null>(null);
  const value = useRef<HTMLElement | null>(null);
  const progress = useRef<HTMLSpanElement | null>(null);
  // 反馈层每渲染都拿同一个容器：它作为 prop 传给记忆化的反馈组件，
  // 每帧换新对象会让拖动期间的舞台反复重渲染。
  const feedback = useMemo<PlayerEdgeGestureFeedbackRefs>(
    () => ({ root, panel, brightnessIcon, volumeIcon, label, value, progress }),
    [],
  );

  // 原生桥对象身份会随节流回读变化；处理器读 ref，避免拖动中重建回调。
  // 渲染期不写 ref：提交后同步 latest 值，而读者全部在事件/效果里，时序等价。
  const nativeRef = useRef(native);
  const nativeStateRef = useRef(nativeState);
  const volumeRef = useRef(volume);
  const mutedRef = useRef(muted);
  useLayoutEffect(() => {
    nativeRef.current = native;
    nativeStateRef.current = nativeState;
    volumeRef.current = volume;
    mutedRef.current = muted;
  });
  const nativeActive = native !== null;

  const clearFeedbackTimer = useCallback(() => {
    if (feedbackTimerRef.current !== null) {
      window.clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = null;
    }
  }, []);

  const revealFeedback = useCallback(() => {
    const rootEl = root.current;
    const panelEl = panel.current;
    if (!rootEl) return;
    const wasVisible = rootEl.dataset.visible === "true";
    rootEl.dataset.visible = "true";
    if (wasVisible) return;

    if (prefersReducedMotion()) {
      killTweensOf(rootEl);
      if (panelEl) killTweensOf(panelEl);
      rootEl.style.opacity = "1";
      if (panelEl) panelEl.style.transform = "scale(1)";
      return;
    }
    // 提示层的自然态是 opacity-0 / scale(0.97)，展开后的终态由 commitTween 固化为
    // 内联样式持有；隐藏补间的结束帧才回到自然态，由 settleTween 归还。
    // 不能用 fill 持有展开态：已完成的填充动画会被部分 WebView 从
    // getAnimations() 移除而效果仍挂在级联上，之后任何 cancel 都无法清除，
    // 隐藏淡出结束的瞬间会跳回旧效果并永久卡在展开态（提示卡不消失）。
    // 起点读当前计算值而不是固定常量：隐藏中途再次手势时从当前透明度/缩放
    // 平滑接续（GSAP `.to` 的语义），不跳回起点。
    const rootFrom = getComputedStyle(rootEl).opacity;
    const panelFrom = panelEl ? getComputedStyle(panelEl).transform : null;
    commitTween(
      tween(rootEl, [{ opacity: rootFrom }, { opacity: "1" }], {
        duration: 160,
        easing: EASE_OUT,
        fill: "both",
      }),
    );
    if (panelEl && panelFrom) {
      commitTween(
        tween(panelEl, [{ transform: panelFrom }, { transform: "scale(1)" }], {
          duration: 160,
          easing: EASE_OUT,
          fill: "both",
        }),
      );
    }
  }, []);

  const hideFeedback = useCallback(() => {
    const rootEl = root.current;
    const panelEl = panel.current;
    if (!rootEl || rootEl.dataset.visible !== "true") return;
    rootEl.dataset.visible = "false";

    if (prefersReducedMotion()) {
      killTweensOf(rootEl);
      if (panelEl) killTweensOf(panelEl);
      rootEl.style.opacity = "0";
      if (panelEl) panelEl.style.transform = "";
      return;
    }
    const rootFrom = getComputedStyle(rootEl).opacity;
    const panelFrom = panelEl ? getComputedStyle(panelEl).transform : null;
    settleTween(
      rootEl,
      tween(rootEl, [{ opacity: rootFrom }, { opacity: "0" }], {
        duration: 140,
        easing: EASE_OUT,
        fill: "both",
      }),
    );
    if (panelEl && panelFrom) {
      settleTween(
        panelEl,
        tween(panelEl, [{ transform: panelFrom }, { transform: "scale(0.97)" }], {
          duration: 140,
          easing: EASE_OUT,
          fill: "both",
        }),
      );
    }
  }, []);

  const showFeedback = useCallback(
    (kind: PlayerEdgeGesture, nextValue: number) => {
      const rootEl = root.current;
      if (rootEl) {
        rootEl.dataset.kind = kind;
        rootEl.dataset.playerEdgeGestureFeedback = kind;
      }
      if (brightnessIcon.current) {
        brightnessIcon.current.style.display = kind === "brightness" ? "" : "none";
      }
      if (volumeIcon.current) volumeIcon.current.style.display = kind === "volume" ? "" : "none";
      if (label.current) label.current.textContent = kind === "brightness" ? "亮度" : "音量";
      if (value.current) value.current.textContent = `${Math.round(nextValue)}%`;
      if (progress.current) {
        progress.current.style.transform = `scaleX(${Math.max(0, Math.min(1, nextValue / 100))})`;
      }
      clearFeedbackTimer();
      revealFeedback();
    },
    [clearFeedbackTimer, revealFeedback],
  );

  const scheduleFeedbackHide = useCallback(() => {
    clearFeedbackTimer();
    feedbackTimerRef.current = window.setTimeout(() => {
      feedbackTimerRef.current = null;
      hideFeedback();
    }, PLAYER_EDGE_GESTURE_HUD_LINGER_MS);
  }, [clearFeedbackTimer, hideFeedback]);

  const setClampedBrightness = useCallback((next: number, applyShade: boolean) => {
    const nextValue = Math.max(0, Math.min(100, next));
    if (brightnessRef.current === nextValue) return;
    brightnessRef.current = nextValue;
    if (applyShade && brightnessShadeRef.current) {
      brightnessShadeRef.current.style.opacity = String(playerBrightnessShadeOpacity(nextValue));
    }
  }, []);

  const releasePointer = useCallback((element: HTMLElement, pointerId: number) => {
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
  }, []);

  const start = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (
        !enabled ||
        !isTouchLikePointer(event.pointerType) ||
        !event.isPrimary ||
        isIgnoredTarget(event.target)
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
      const useNative = nativeRef.current !== null;
      let startValue: number;
      if (kind === "brightness") {
        startValue = brightnessRef.current;
      } else {
        const snapshot = nativeStateRef.current;
        startValue =
          useNative && snapshot
            ? snapshot.mediaVolume
            : mutedRef.current || volumeRef.current === 0
              ? 0
              : volumeRef.current;
      }
      gestureRef.current = {
        pointerId: event.pointerId,
        target: event.currentTarget,
        kind,
        startX: event.clientX,
        startY: event.clientY,
        stageHeight: stageBounds.height,
        startValue,
        lastValue: startValue,
        active: false,
        native: useNative,
      };
    },
    [enabled, isIgnoredTarget],
  );

  /** 返回该指针是否属于一次待处理/进行中的边缘手势。 */
  const move = useCallback(
    (event: ReactPointerEvent<HTMLElement>): boolean => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return false;

      const deltaX = event.clientX - gesture.startX;
      const deltaY = event.clientY - gesture.startY;
      let beganAdjustment = false;

      if (!gesture.active) {
        const intent = playerEdgeGestureIntent(deltaX, deltaY);
        if (intent === "pending") return true;
        if (intent === "reject") {
          gestureRef.current = null;
          releasePointer(event.currentTarget, event.pointerId);
          return false;
        }
        gesture.active = true;
        beganAdjustment = true;
        // 不要在 pointerdown 时捕获：短触摸必须保持其原始目标，
        // 使弹幕层能收到 pointerup 并完成命中测试。一旦接触被确认是真正的调节，
        // 捕获可以在 Android WebView 全屏中手指到达舞台边缘时保持连续。
        event.currentTarget.setPointerCapture(event.pointerId);
        onAdjustStart?.();
      }

      event.preventDefault();
      const nextValue = playerEdgeGestureValue(gesture.startValue, deltaY, gesture.stageHeight);
      if (beganAdjustment || nextValue !== gesture.lastValue) {
        gesture.lastValue = nextValue;
        if (gesture.kind === "brightness") {
          setClampedBrightness(nextValue, !gesture.native);
          if (gesture.native) nativeRef.current?.setBrightness(nextValue);
        } else if (gesture.native) {
          nativeRef.current?.setMediaVolume(nextValue);
        } else {
          onPreviewVolume(nextValue);
        }
        showFeedback(gesture.kind, nextValue);
      }
      return true;
    },
    [onAdjustStart, onPreviewVolume, releasePointer, setClampedBrightness, showFeedback],
  );

  /** 返回本次指针是否被已生效的调节认领（宿主据此跳过点按/换片）。 */
  const end = useCallback(
    (event: ReactPointerEvent<HTMLElement>): boolean => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return false;

      gestureRef.current = null;
      releasePointer(event.currentTarget, event.pointerId);
      if (gesture.active) {
        if (gesture.native) nativeRef.current?.flush();
        if (gesture.kind === "volume" && !gesture.native) {
          onCommitVolume(gesture.lastValue, gesture.lastValue === 0);
        }
        scheduleFeedbackHide();
        event.preventDefault();
      }
      return gesture.active;
    },
    [onCommitVolume, releasePointer, scheduleFeedbackHide],
  );

  const cancel = useCallback(
    (event?: ReactPointerEvent<HTMLElement>) => {
      const gesture = gestureRef.current;
      if (!gesture || (event && gesture.pointerId !== event.pointerId)) return;
      gestureRef.current = null;
      releasePointer(gesture.target, gesture.pointerId);
      if (!gesture.active) return;
      if (gesture.native) nativeRef.current?.flush();
      if (gesture.kind === "volume" && !gesture.native) {
        onCommitVolume(gesture.lastValue, gesture.lastValue === 0);
      }
      scheduleFeedbackHide();
    },
    [onCommitVolume, releasePointer, scheduleFeedbackHide],
  );

  // 旋屏、失焦、锁定或切换视频时，未抬起的旧指针不能继续调节新画面。
  useEffect(() => {
    const abort = () => cancel();
    const cancelMultiTouch = (event: PointerEvent) => {
      if (!event.isPrimary) cancel();
    };
    window.addEventListener("pointerdown", cancelMultiTouch, true);
    window.addEventListener("blur", abort);
    window.addEventListener("resize", abort);
    return () => {
      cancel();
      hideFeedback();
      clearFeedbackTimer();
      window.removeEventListener("pointerdown", cancelMultiTouch, true);
      window.removeEventListener("blur", abort);
      window.removeEventListener("resize", abort);
    };
  }, [cancel, clearFeedbackTimer, enabled, hideFeedback, sessionKey]);

  useEffect(() => {
    const resetFallbackBrightness = () => {
      brightnessRef.current = 100;
      if (brightnessShadeRef.current) brightnessShadeRef.current.style.opacity = "0";
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") resetFallbackBrightness();
    };

    resetFallbackBrightness();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [sessionKey]);

  // 原生桥接管亮度后合成器罩必须归零，否则两层调暗叠加。
  useEffect(() => {
    if (!nativeActive) return;
    brightnessRef.current = 100;
    if (brightnessShadeRef.current) brightnessShadeRef.current.style.opacity = "0";
  }, [nativeActive]);

  // 桥上报的亮度是权威值（用户可能从系统面板改过）；进行中的亮度手势除外，
  // 否则拖动会被自己的回读拽回去。
  useEffect(() => {
    if (!nativeState) return;
    const gesture = gestureRef.current;
    if (gesture?.active && gesture.kind === "brightness") return;
    brightnessRef.current = nativeState.brightness;
  }, [nativeState]);

  return { start, move, cancel, end, feedback, brightnessShadeRef };
}
