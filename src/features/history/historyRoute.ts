export const HISTORY_VIEW_PARAM = "view";

/** The two timelines the page pages between. */
export type HistoryView = "watch" | "danmaku";

export const HISTORY_VIEWS: readonly HistoryView[] = ["watch", "danmaku"];

/**
 * The active timeline lives in the address bar rather than in page state: the
 * application header owns the switcher while the page owns the lists, and a
 * search param is the one place both can read without either importing the
 * other's state.
 */
export function historyViewFromSearch(value: string | null | undefined): HistoryView {
  return value === "danmaku" ? "danmaku" : "watch";
}

export function withHistoryView(current: URLSearchParams, view: HistoryView): URLSearchParams {
  const next = new URLSearchParams(current);
  if (view === "watch") next.delete(HISTORY_VIEW_PARAM);
  else next.set(HISTORY_VIEW_PARAM, view);
  return next;
}
