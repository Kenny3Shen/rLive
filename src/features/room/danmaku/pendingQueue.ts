import type { DanmakuEvent } from "@/shared/types/live";

/**
 * 直播弹幕的待投队列：渲染器实例尚未建立（首次异步加载引擎）或舞台尺寸为零时，
 * 事件先暂存在这里，等实例就绪后重放。
 *
 * 库自身的 `limits.stash` 接不住这段窗口——没有 `Manager` 实例就没有可投的对象，
 * 且库的 stash 只有条数上限、没有时间语义，尺寸恢复后会把几秒前的陈旧弹幕
 * 一次性倒出来。因此「过时即弃」由这里的时间上限表达。
 */
export const DANMAKU_MAX_PENDING_COMMENTS = 80;
/** 超出此年龄的待投事件不再重放：画面恢复后补投陈旧弹幕没有意义。 */
export const DANMAKU_PENDING_MAX_AGE_MS = 5_000;

export type DanmakuPendingEvent = {
  event: DanmakuEvent;
  queuedAt: number;
};

/** 入队并保留最新的一批：溢出时丢弃最旧的事件。 */
export function enqueueDanmakuPending(
  queue: DanmakuPendingEvent[],
  events: readonly DanmakuEvent[],
  queuedAt = Date.now(),
  capacity = DANMAKU_MAX_PENDING_COMMENTS,
): void {
  for (const event of events) queue.push({ event, queuedAt });
  const safeCapacity = Number.isFinite(capacity)
    ? Math.max(0, Math.floor(capacity))
    : DANMAKU_MAX_PENDING_COMMENTS;
  const overflow = queue.length - safeCapacity;
  if (overflow > 0) queue.splice(0, overflow);
}

/** 取空队列并滤掉超龄事件；`queuedAt` 恰好等于上限时仍算有效。 */
export function flushDanmakuPending(
  queue: DanmakuPendingEvent[],
  now = Date.now(),
  maxAge = DANMAKU_PENDING_MAX_AGE_MS,
): DanmakuEvent[] {
  const safeMaxAge = Math.max(0, Number.isFinite(maxAge) ? maxAge : DANMAKU_PENDING_MAX_AGE_MS);
  return queue
    .splice(0)
    .filter((pending) => now - pending.queuedAt <= safeMaxAge)
    .map((pending) => pending.event);
}
