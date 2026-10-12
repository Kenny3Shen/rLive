/**
 * 虚拟列表的数据上限，与实际 DOM 行数无关。钉底和阅读历史共用有界窗口；
 * TanStack Virtual 通过稳定行键和 anchorTo 保持仍在窗口内的阅读锚点，
 * 不再测量整段 scrollHeight 或分两次提交补偿裁剪。锚点本身被淘汰时退到窗口开头。
 */
export const DANMAKU_LIST_CAPACITY = 1_200;

/** 追加批次并保留最近的有限数据；空批次保持引用，避免无效提交。 */
export function appendWithinDanmakuListWindow<T>(
  previous: readonly T[],
  batch: readonly T[],
  capacity = DANMAKU_LIST_CAPACITY,
): readonly T[] {
  if (batch.length === 0) return previous;
  if (batch.length >= capacity) return batch.slice(-capacity);
  return previous.slice(Math.max(0, previous.length + batch.length - capacity)).concat(batch);
}
