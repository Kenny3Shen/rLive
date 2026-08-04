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

export function groupHistoryByDate<T extends { site_id: SiteId }>(
  items: readonly T[],
  getTimestamp: (item: T) => number,
  platformFilter: HistoryPlatformFilter,
  disabledSiteIds: unknown,
  now = Date.now(),
): HistoryDateGroup<T>[] {
  const visibleSiteIds = new Set(enabledSiteIds(disabledSiteIds));
  const sortedItems = items
    .filter(
      (item) =>
        visibleSiteIds.has(item.site_id) &&
        (platformFilter === "all" || item.site_id === platformFilter),
    )
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
