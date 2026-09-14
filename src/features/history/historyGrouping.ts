import { enabledSiteIds } from "@/shared/siteId";
import type { SiteId } from "@/shared/types/live";

export type HistoryDateGroup<T> = {
  key: string;
  label: string;
  items: T[];
};

export type HistoryPlatformFilter = "all" | SiteId;

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function dateKey(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return `invalid:${timestamp}`;
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function dateLabel(timestamp: number, today: number, yesterday: number): string {
  const day = startOfLocalDay(timestamp);
  if (day === today) return "今天";
  if (day === yesterday) return "昨天";
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? "未知日期"
    : date.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
}

/**
 * 按平台页签与「已禁用平台」设置过滤。
 * 只有带 `site_id` 的历史（直播、弹幕）需要它；视频历史只有 B 站一个来源。
 */
export function filterHistoryBySite<T extends { site_id: SiteId }>(
  items: readonly T[],
  platformFilter: HistoryPlatformFilter,
  disabledSiteIds: unknown,
): T[] {
  const visibleSiteIds = new Set(enabledSiteIds(disabledSiteIds));
  return items.filter(
    (item) =>
      visibleSiteIds.has(item.site_id) &&
      (platformFilter === "all" || item.site_id === platformFilter),
  );
}

/** 按本地日分组，组内按时间戳倒序。与平台无关。 */
export function groupHistoryByDate<T>(
  items: readonly T[],
  getTimestamp: (item: T) => number,
  now = Date.now(),
): HistoryDateGroup<T>[] {
  const sortedItems = items
    .map((item, originalIndex) => ({ item, originalIndex, timestamp: getTimestamp(item) }))
    .sort((left, right) => {
      const leftValid = Number.isFinite(left.timestamp);
      const rightValid = Number.isFinite(right.timestamp);
      if (leftValid !== rightValid) return leftValid ? -1 : 1;
      return right.timestamp - left.timestamp || left.originalIndex - right.originalIndex;
    });

  const today = startOfLocalDay(now);
  const yesterday = today - 86_400_000;
  const groups = new Map<string, HistoryDateGroup<T>>();

  for (const { item, timestamp } of sortedItems) {
    const key = dateKey(timestamp);
    const group = groups.get(key) ?? {
      key,
      label: dateLabel(timestamp, today, yesterday),
      items: [],
    };
    group.items.push(item);
    groups.set(key, group);
  }

  return [...groups.values()];
}

/**
 * 窗口化渲染的一行：日期标题，或一条记录。
 *
 * 时间线按日分组，虚拟列表却只认线性下标——分组必须先拍平成行序列，标题才能和
 * 记录一起参与同一次窗口计算（否则标题要么全量渲染，要么无法定位）。
 */
export type HistoryTimelineRow<T> =
  | { kind: "heading"; key: string; label: string }
  | { kind: "item"; key: string; item: T };

/**
 * 按组序、组内序拍平成行。标题键带 `date:` 前缀与记录键分开：两者同处一个键空间，
 * 撞键会让虚拟列表把标题的测量结果复用到记录上。
 */
export function flattenHistoryTimeline<T>(
  groups: readonly HistoryDateGroup<T>[],
  itemKey: (item: T) => string,
): HistoryTimelineRow<T>[] {
  const rows: HistoryTimelineRow<T>[] = [];
  for (const group of groups) {
    rows.push({ kind: "heading", key: `date:${group.key}`, label: group.label });
    for (const item of group.items) {
      rows.push({ kind: "item", key: itemKey(item), item });
    }
  }
  return rows;
}
