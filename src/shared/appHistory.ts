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
