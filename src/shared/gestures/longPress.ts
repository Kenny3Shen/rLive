/**
 * 共享的触摸长按手势判定。
 *
 * 浏览列表卡片用它把「按住不动」翻译为打开操作抽屉一类的次级操作。
 * 与 ContextMenu 依赖的原生 contextmenu 事件互补：Android WebView 会在
 * 系统长按点派发该事件，iOS WebView 则不可靠，需要自持计时器。
 */

/** 按住多久判定为长按，与系统原生长按（约 400–500ms）同量级。 */
export const LONG_PRESS_TRIGGER_MS = 500;

/** 按住期间手指漂移超过该半径视为滑动或滚动，长按取消。 */
export const LONG_PRESS_CANCEL_SLOP_PX = 10;

const LONG_PRESS_CANCEL_SLOP_SQ = LONG_PRESS_CANCEL_SLOP_PX ** 2;

/** 只有触摸与触控笔主指针可能是长按；鼠标交给右键菜单。 */
export function isLongPressPointer(pointerType: string | undefined, isPrimary: boolean): boolean {
  return isPrimary && (pointerType === "touch" || pointerType === "pen");
}

/** 按住期间指针是否已移出容忍半径。 */
export function hasLongPressMovedBeyondSlop(
  startX: number,
  startY: number,
  x: number,
  y: number,
): boolean {
  const dx = x - startX;
  const dy = y - startY;
  return dx * dx + dy * dy > LONG_PRESS_CANCEL_SLOP_SQ;
}
