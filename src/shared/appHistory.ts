/**
 * React Router 把应用内位置的下标记在浏览器历史状态里。只有该状态证明存在更早的
 * 应用内页面时才使用浏览器 Back；否则（直链、外部跳入）退回发现页，
 * 免得一次「返回」把用户送出应用。
 *
 * 判断依据是 history state 而不是 `history.length`：后者把同一标签页里此前访问过的
 * 站外页面也算进去，直链进来时会误判成「有上一页」。
 */
export function canNavigateBackInApp(historyState: unknown): boolean {
  return (
    !!historyState &&
    typeof historyState === "object" &&
    "idx" in historyState &&
    typeof historyState.idx === "number" &&
    historyState.idx > 0
  );
}

/**
 * 读取与当前已提交 Router location 对齐的历史索引。
 *
 * 浏览器 POP 会先改写 `history.state`，React Router 随后才提交新的 location。
 * 两次提交之间不能把新索引用于旧页面，否则同路径播放页会被误判为换片并重播
 * 入场动画。`state.key` 与 `entryKey` 不匹配时沿用调用方已经提交的索引。
 *
 * React Router 对初始记录使用 `"default"`，且初始 history state 可能尚未写入 key。
 */
export function readAppHistoryIndex(
  historyState: unknown,
  entryKey: string,
  fallback = 0,
): number {
  if (!historyState || typeof historyState !== "object" || Array.isArray(historyState)) {
    return fallback;
  }

  const state = historyState as { key?: unknown; idx?: unknown };
  const rawKey = state.key;
  if (rawKey !== undefined && rawKey !== null && typeof rawKey !== "string") return fallback;

  const stateKey = typeof rawKey === "string" && rawKey.length > 0 ? rawKey : "default";
  if (stateKey !== entryKey) return fallback;
  if (typeof state.idx !== "number" || !Number.isInteger(state.idx) || state.idx < 0) {
    return fallback;
  }

  return state.idx;
}
