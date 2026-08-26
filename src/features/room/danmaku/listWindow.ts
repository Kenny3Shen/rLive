/**
 * 聊天列表渲染行的保留窗口。
 *
 * 滚动视口由从内容顶部度量的 `scrollTop` 定位。移除最旧的行会让所有剩余行上移
 * 被移除的高度。读者钉在最新消息上时这一位移不可见：内容底部不动，
 * 浏览器把 `scrollTop` 钳制到更短的内容上。读者停在历史里时则非常明显：
 * 每次冲刷列表都从脚下溜走，且在 `scrollTop === 0` 时看起来像信息流在自己滚动，
 * 尽管滚动条动不了。
 *
 * 因此只有钉住时才激进裁剪。向上滚动期间改为让列表生长，
 * 面板的布局副作用配合显式滚动补偿执行更大的窗口限制。
 */

/** 信息流钉在最新消息时保留的行数。 */
export const DANMAKU_LIST_MAX_PINNED = 300;

/**
 * 读者停在历史里时保留的行数。它限制了在极繁忙房间中把面板留在上滚状态的读者的
 * DOM 规模；超过后最旧的行必须离开，否则就是无限增长。
 */
export const DANMAKU_LIST_MAX_SCROLLED_UP = 1_200;

/**
 * 追加已冲刷批次的容量上限。
 *
 * 向上滚动时刻意无界：那里的裁剪必须测量被移除行的高度才能保住阅读位置，
 * 只有面板的布局副作用能做到。它在同一帧内把列表限制到
 * `DANMAKU_LIST_MAX_SCROLLED_UP`，
 * 超出它的增长永远不会到达屏幕。
 */
export function danmakuListAppendCapacity(pinnedToBottom: boolean): number {
  return pinnedToBottom ? DANMAKU_LIST_MAX_PINNED : Number.POSITIVE_INFINITY;
}

/**
 * 追加一批冲刷数据，仅在超过 `capacity` 后丢弃最旧的行。
 *
 * 没有东西可追加时原样返回之前的数组，
 * 使把它传给 `setItems` 的调用方不会调度一次空重渲染。
 */
export function appendWithinDanmakuListWindow<T>(
  previous: readonly T[],
  batch: readonly T[],
  capacity: number,
): readonly T[] {
  if (batch.length === 0) return previous;
  const next = previous.concat(batch);
  return next.length <= capacity ? next : next.slice(next.length - capacity);
}

/**
 * 把列表收缩回 `capacity`，保留最新的行。
 *
 * 已经满足容量时返回同一引用，避免调用方的 `setItems`
 * 提交一棵完全相同的树。
 */
export function trimToDanmakuListWindow<T>(items: readonly T[], capacity: number): readonly T[] {
  return items.length <= capacity ? items : items.slice(items.length - capacity);
}

/**
 * 上方行被移除后，保持阅读位置的 `scrollTop`；参数为裁剪前后视口的内容高度。
 *
 * 行只会从列表顶部移除，因此整个高度差都位于读者上方，必须从滚动偏移中扣除。
 * 内容高度变大或不变说明什么都没移除，
 * 偏移保持原样而不去猜测。
 */
export function scrollTopAfterDanmakuListTrim(
  scrollTop: number,
  heightBeforeTrim: number,
  heightAfterTrim: number,
): number {
  const removed = heightBeforeTrim - heightAfterTrim;
  if (!(removed > 0)) return scrollTop;
  return Math.max(0, scrollTop - removed);
}
