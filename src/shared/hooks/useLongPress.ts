import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import {
  LONG_PRESS_TRIGGER_MS,
  hasLongPressMovedBeyondSlop,
  isContextMenuOwnedByPress,
  isLongPressPointer,
} from "@/shared/gestures/longPress";

type UseLongPressOptions = {
  /** 关闭时完全不参与指针事件（桌面交给右键菜单）。 */
  enabled: boolean;
  /** 长按达成时触发。Android 的原生 contextmenu 与计时器都可能到达，
      重复触发需要幂等。 */
  onTrigger: () => void;
};

/**
 * 触摸长按检测。按下后原地按住约半秒触发一次；
 * 抬起、取消（滚动接管）或移出容忍半径都会终止。
 *
 * Android WebView 在系统长按点会派发原生 contextmenu，调用方应同时监听它
 * （preventDefault 并经 `triggerNow()` 立即触发）；本 hook 的计时器承担
 * iOS WebView 与兜底路径。触发后松手可能合成一次 click，
 * 由调用方自行抑制。
 *
 * 取消判定除了挂在卡片自身的 pointermove/up/cancel 上，还镜像到 window
 * 的捕获阶段。祖先手势层（首页/关注页的横向翻页）锁定手势后会对它的表面
 * `setPointerCapture` 并 `stopPropagation`，卡片从此收不到任何后续指针事件，
 * 自身的取消路径整个失明；若没有 window 守卫，滑动切走平台后 500ms
 * 计时器照常到期，上一平台那张卡片的抽屉会凭空弹出。window 捕获阶段先于
 * 一切祖先的处理器执行，指针被谁捕获、传播被谁拦断都照样可见。
 */
export function useLongPress({ enabled, onTrigger }: UseLongPressOptions) {
  const timerRef = useRef<number | null>(null);
  const startRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  /** 最近一次长按触发时刻，用于判定稍后到达的 contextmenu 是否归属同一手势。 */
  const lastTriggeredAtRef = useRef(0);
  /** 解除 window 守卫监听的函数；null 表示当前没有武装中的按压。 */
  const detachWindowGuardRef = useRef<(() => void) | null>(null);
  const onTriggerRef = useRef(onTrigger);
  onTriggerRef.current = onTrigger;

  const detachWindowGuard = useCallback(() => {
    detachWindowGuardRef.current?.();
    detachWindowGuardRef.current = null;
  }, []);

  const cancel = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startRef.current = null;
    detachWindowGuard();
  }, [detachWindowGuard]);

  // 卡片可能随列表刷新卸载，挂起的计时器不应再触发。
  useEffect(() => cancel, [cancel]);

  /**
   * 把本次按压的取消判定镜像到 window 捕获阶段。
   *
   * 只处理与武装时相同的 pointerId（比对 startRef）：其它指针（如触摸旁移动
   * 的鼠标）不得影响进行中的长按。监听随 cancel 一并解除。
   */
  const armWindowGuard = useCallback(() => {
    detachWindowGuard();
    const onMove = (event: PointerEvent) => {
      const start = startRef.current;
      if (!start || event.pointerId !== start.pointerId) return;
      if (hasLongPressMovedBeyondSlop(start.x, start.y, event.clientX, event.clientY)) {
        cancel();
      }
    };
    const onEnd = (event: PointerEvent) => {
      const start = startRef.current;
      if (!start || event.pointerId !== start.pointerId) return;
      cancel();
    };
    window.addEventListener("pointermove", onMove, { capture: true });
    window.addEventListener("pointerup", onEnd, { capture: true });
    window.addEventListener("pointercancel", onEnd, { capture: true });
    detachWindowGuardRef.current = () => {
      window.removeEventListener("pointermove", onMove, { capture: true });
      window.removeEventListener("pointerup", onEnd, { capture: true });
      window.removeEventListener("pointercancel", onEnd, { capture: true });
    };
  }, [cancel, detachWindowGuard]);

  /** 立即终止计时并触发，供原生 contextmenu 等外部长按信号复用。 */
  const triggerNow = useCallback(() => {
    cancel();
    lastTriggeredAtRef.current = performance.now();
    onTriggerRef.current();
  }, [cancel]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      if (!enabled || !isLongPressPointer(event.pointerType, event.isPrimary)) return;
      cancel();
      startRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      armWindowGuard();
      timerRef.current = window.setTimeout(triggerNow, LONG_PRESS_TRIGGER_MS);
    },
    [armWindowGuard, cancel, enabled, triggerNow],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent) => {
      const start = startRef.current;
      if (!start || event.pointerId !== start.pointerId) return;
      if (hasLongPressMovedBeyondSlop(start.x, start.y, event.clientX, event.clientY)) {
        cancel();
      }
    },
    [cancel],
  );

  const onPointerUp = useCallback(() => cancel(), [cancel]);
  const onPointerCancel = useCallback(() => cancel(), [cancel]);

  /**
   * contextmenu 是否归属本元素上进行中（或刚刚触发）的按压。
   * 详见 `isContextMenuOwnedByPress` 的说明：非本元素按压产生的
   * contextmenu（如遮罩退出期间的重定向信号）不应再触发长按。
   */
  const ownsActivePress = useCallback(
    () =>
      isContextMenuOwnedByPress(
        startRef.current != null,
        lastTriggeredAtRef.current,
        performance.now(),
      ),
    [],
  );

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    triggerNow,
    ownsActivePress,
  };
}
