import { isSiteId } from "@/shared/siteId";
import type { HistoryPlatformFilter } from "./historyGrouping";

export const HISTORY_QUERY_PARAM = "q";
export const HISTORY_DATE_PARAM = "date";
export const HISTORY_PLATFORM_PARAM = "platform";

/** 相对预设，加上 `YYYY-MM-DD` 单日或 `YYYY-MM-DD~YYYY-MM-DD` 日期范围。 */
export type HistoryDateFilter = "all" | "today" | "yesterday" | "7d" | "30d" | (string & {});

export const HISTORY_DATE_PRESETS = ["all", "today", "yesterday", "7d", "30d"] as const;

/** 范围分隔符。`~` 在 query 里无需转义，地址栏因此保持可读。 */
const RANGE_SEPARATOR = "~";

const LOCAL_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** 首尾都含的本地日期范围，两端对齐到当天零点。 */
export type HistoryDayRange = { from: Date; to: Date };

function parseLocalDay(value: string): Date | null {
  if (!LOCAL_DAY.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const parsed = new Date(year, month - 1, day);
  // `new Date(2026, 1, 30)` 会滑到 3 月：逐字段比对挡掉不存在的日期。
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day
    ? parsed
    : null;
}

function toLocalDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * 自定义日期范围，不是自定义范围时为 `null`。单日写法等价于首尾同日的范围，
 * 因此旧的 `?date=YYYY-MM-DD` 链接继续可用。手工写反的范围按升序归一，
 * 而不是整段丢弃。
 */
export function historyDayRange(filter: HistoryDateFilter): HistoryDayRange | null {
  if ((HISTORY_DATE_PRESETS as readonly string[]).includes(filter)) return null;
  const [rawFrom, rawTo, ...rest] = filter.split(RANGE_SEPARATOR);
  if (rest.length > 0) return null;
  const from = parseLocalDay(rawFrom ?? "");
  const to = rawTo === undefined ? from : parseLocalDay(rawTo);
  if (!from || !to) return null;
  return from.getTime() <= to.getTime() ? { from, to } : { from: to, to: from };
}

/** 范围的规范写法；同一天折叠为单日，地址栏不出现 `X~X`。 */
export function historyDateFilterFromDays(from: Date, to: Date): HistoryDateFilter {
  const [start, end] = from.getTime() <= to.getTime() ? [from, to] : [to, from];
  const startDay = toLocalDay(start);
  const endDay = toLocalDay(end);
  return startDay === endDay ? startDay : `${startDay}${RANGE_SEPARATOR}${endDay}`;
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
  const range = historyDayRange(value);
  return range ? historyDateFilterFromDays(range.from, range.to) : "all";
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
    default: {
      const range = historyDayRange(filter);
      if (!range) return "全部时间";
      const from = toLocalDay(range.from).replaceAll("-", "/");
      if (range.from.getTime() === range.to.getTime()) return from;
      // 同年只写一次年份，触发按钮的标签不至于被两个完整日期撑开。
      const to = toLocalDay(range.to).replaceAll("-", "/");
      return `${from} - ${range.to.getFullYear() === range.from.getFullYear() ? to.slice(5) : to}`;
    }
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
      const range = historyDayRange(filter);
      if (!range) return null;
      // 范围两端都含：结束日推进一天换成半开右界。
      return { from: range.from.getTime(), to: shiftLocalDay(range.to.getTime(), 1) };
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
