import { isSiteId } from "@/shared/siteId";
import type { HistoryPlatformFilter } from "./historyGrouping";

export const HISTORY_QUERY_PARAM = "q";
export const HISTORY_DATE_PARAM = "date";
export const HISTORY_PLATFORM_PARAM = "platform";

/** 相对预设加上表示某个本地日期的 `YYYY-MM-DD`。 */
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
 * 地址栏能够承载的过滤器。无法识别的内容一律降级为 `all`，
 * 使手工编辑或过期的 URL 仍能渲染完整时间线。
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

/** 地址栏能承载的平台过滤；过期取值显示全部站点。 */
export function historyPlatformFilterFromSearch(
  value: string | null | undefined,
): HistoryPlatformFilter {
  return value && isSiteId(value) ? value : "all";
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
 * 本地时间的半开 `[from, to)` 窗口，无日期限制时为 `null`。
 * 预设按自然日对齐而不是"现在减 N 小时"，
 * 使"近 7 天"无论几点都表示七个日历日。
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

/** 对记录暴露给搜索的字段做不区分大小写的匹配。 */
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
 * 在分组之前先用自由文本和日期收窄时间线。时间戳不可用的记录保持可见，
 * 除非日期限制生效，避免坏时钟悄悄藏起历史。
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

export function withHistoryPlatformFilter(
  current: URLSearchParams,
  filter: HistoryPlatformFilter,
): URLSearchParams {
  const next = new URLSearchParams(current);
  if (filter === "all") next.delete(HISTORY_PLATFORM_PARAM);
  else next.set(HISTORY_PLATFORM_PARAM, filter);
  return next;
}
