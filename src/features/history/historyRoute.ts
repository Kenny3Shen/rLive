export const HISTORY_VIEW_PARAM = "view";

/** 页面在其间翻页的三条时间线。 */
export type HistoryView = "watch" | "video" | "danmaku";

export const HISTORY_VIEWS: readonly HistoryView[] = ["watch", "video", "danmaku"];

/**
 * 活动时间线保存在地址栏而不是页面状态里：应用头部拥有切换器而页面拥有列表，
 * search 参数是双方都能读取、又互不导入对方状态的唯一位置。
 */
export function historyViewFromSearch(value: string | null | undefined): HistoryView {
  if (value === "video" || value === "danmaku") return value;
  return "watch";
}

export function withHistoryView(current: URLSearchParams, view: HistoryView): URLSearchParams {
  const next = new URLSearchParams(current);
  if (view === "watch") next.delete(HISTORY_VIEW_PARAM);
  else next.set(HISTORY_VIEW_PARAM, view);
  return next;
}
