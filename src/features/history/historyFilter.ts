export const HISTORY_QUERY_PARAM = "q";
export const HISTORY_DATE_PARAM = "date";

/** Relative presets plus `YYYY-MM-DD` for one specific local day. */
export type HistoryDateFilter = "all" | "today" | "yesterday" | "7d" | "30d" | (string & {});

export const HISTORY_DATE_PRESETS = ["all", "today", "yesterday", "7d", "30d"] as const;

const SPECIFIC_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isSpecificDayFilter(value: string): boolean {
  if (!SPECIFIC_DAY.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const parsed = new Date(year, month - 1, day);
  return (
    parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day
  );
}

/**
 * A filter the address bar can carry. Anything unrecognised degrades to `all`
 * so a hand-edited or stale URL still renders the full timeline.
 */
export function historyDateFilterFromSearch(value: string | null | undefined): HistoryDateFilter {
  if (!value) return "all";
  if ((HISTORY_DATE_PRESETS as readonly string[]).includes(value)) {
    return value as HistoryDateFilter;
  }
  return isSpecificDayFilter(value) ? value : "all";
}

export function historyDateFilterLabel(filter: HistoryDateFilter): string {
  switch (filter) {
    case "all":
      return "全部时间";
    case "today":
      return "今天";
    case "yesterday":
      return "昨天";
    case "7d":
      return "近 7 天";
    case "30d":
      return "近 30 天";
    default:
      return isSpecificDayFilter(filter) ? filter.replaceAll("-", "/") : "全部时间";
  }
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function shiftLocalDay(timestamp: number, days: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime();
}

/**
 * Half-open `[from, to)` window in local time, or `null` for no date bound.
 * Presets are day-aligned rather than "now minus N hours" so "近 7 天" keeps
 * meaning seven calendar days regardless of the time of day.
 */
export function historyDateWindow(
  filter: HistoryDateFilter,
  now: number,
): { from: number; to: number } | null {
  const today = startOfLocalDay(now);
  switch (filter) {
    case "all":
      return null;
    case "today":
      return { from: today, to: shiftLocalDay(today, 1) };
    case "yesterday":
      return { from: shiftLocalDay(today, -1), to: today };
    case "7d":
      return { from: shiftLocalDay(today, -6), to: shiftLocalDay(today, 1) };
    case "30d":
      return { from: shiftLocalDay(today, -29), to: shiftLocalDay(today, 1) };
    default: {
      if (!isSpecificDayFilter(filter)) return null;
      const [year, month, day] = filter.split("-").map(Number) as [number, number, number];
      const from = new Date(year, month - 1, day).getTime();
      return { from, to: new Date(year, month - 1, day + 1).getTime() };
    }
  }
}

/** Case-insensitive match over the fields a record exposes to search. */
export function matchesHistoryKeyword(fields: readonly (string | undefined)[], keyword: string) {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((field) => !!field && field.toLowerCase().includes(needle));
}

export type HistoryFilterOptions<T> = {
  keyword: string;
  dateFilter: HistoryDateFilter;
  getTimestamp: (item: T) => number;
  getSearchFields: (item: T) => readonly (string | undefined)[];
  now?: number;
};

/**
 * Narrows a timeline by free-text and date before it is grouped. Records whose
 * timestamp is unusable stay visible unless a date bound is active, so a bad
 * clock never silently hides history.
 */
export function filterHistoryItems<T>(
  items: readonly T[],
  { keyword, dateFilter, getTimestamp, getSearchFields, now = Date.now() }: HistoryFilterOptions<T>,
): T[] {
  const window = historyDateWindow(dateFilter, now);
  return items.filter((item) => {
    if (!matchesHistoryKeyword(getSearchFields(item), keyword)) return false;
    if (!window) return true;
    const timestamp = getTimestamp(item);
    if (!Number.isFinite(timestamp)) return false;
    return timestamp >= window.from && timestamp < window.to;
  });
}

export function withHistorySearch(current: URLSearchParams, keyword: string): URLSearchParams {
  const next = new URLSearchParams(current);
  const trimmed = keyword.trim();
  if (trimmed) next.set(HISTORY_QUERY_PARAM, trimmed);
  else next.delete(HISTORY_QUERY_PARAM);
  return next;
}

export function withHistoryDateFilter(
  current: URLSearchParams,
  filter: HistoryDateFilter,
): URLSearchParams {
  const next = new URLSearchParams(current);
  if (filter === "all") next.delete(HISTORY_DATE_PARAM);
  else next.set(HISTORY_DATE_PARAM, filter);
  return next;
}
