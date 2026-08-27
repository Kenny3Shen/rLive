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

/**
 * 计时器触发后多长时间内到达的 contextmenu 仍视为同一次长按。
 *
 * Android WebView 的系统长按（contextmenu）与我们的计时器都约在按下后
 * 500ms 触发，先后顺序不定：若计时器先触发，紧随其后的 contextmenu 仍
 * 属于同一手势（幂等重触发无害）；超过该宽限仍未配对的 contextmenu 则
 * 大概率是「手指落在退出中的遮罩上、系统长按重定向到下层卡片」的伪信号，
 * 必须忽略，否则抽屉刚被收起就会立即弹出。
 */
export const LONG_PRESS_CONTEXTMENU_GRACE_MS = 300;

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

/**
 * 判定 contextmenu 是否归属本元素上的一次按压。
 *
 * `armed`：计时器仍在计时的按压（contextmenu 比计时器先到）。
 * `lastTriggeredAt`：计时器 / 上次 contextmenu 触发的时刻（毫秒时间戳，
 * 0 表示从未触发）；计时器先触发时，随后的 contextmenu 在宽限期内到达
 * 仍算同一次手势。
 *
 * 返回 false 的典型场景：手指按在「正在退出动画中的抽屉遮罩」上，系统
 * 长按把 contextmenu 重定向到下层卡片——此时该卡片上并没有进行中的
 * 按压，若照单全收会把用户刚收起的抽屉再次弹开。
 */
export function isContextMenuOwnedByPress(
  armed: boolean,
  lastTriggeredAt: number,
  now: number,
): boolean {
  if (armed) return true;
  if (lastTriggeredAt <= 0) return false;
  return now - lastTriggeredAt < LONG_PRESS_CONTEXTMENU_GRACE_MS;
}
