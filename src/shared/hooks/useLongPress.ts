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
 */
export function useLongPress({ enabled, onTrigger }: UseLongPressOptions) {
  const timerRef = useRef<number | null>(null);
  const startRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  /** 最近一次长按触发时刻，用于判定稍后到达的 contextmenu 是否归属同一手势。 */
  const lastTriggeredAtRef = useRef(0);
  const onTriggerRef = useRef(onTrigger);
  onTriggerRef.current = onTrigger;

  const cancel = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startRef.current = null;
  }, []);

  // 卡片可能随列表刷新卸载，挂起的计时器不应再触发。
  useEffect(() => cancel, [cancel]);

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
      timerRef.current = window.setTimeout(triggerNow, LONG_PRESS_TRIGGER_MS);
    },
    [cancel, enabled, triggerNow],
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
    () => isContextMenuOwnedByPress(startRef.current != null, lastTriggeredAtRef.current, performance.now()),
    [],
  );

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, triggerNow, ownsActivePress };
}
