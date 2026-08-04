import { describe, expect, test } from "bun:test";
import { groupHistoryByDate } from "../src/features/history/historyGrouping";
import type { SiteId } from "../src/shared/types/live";

type TestHistoryItem = {
  id: string;
  site_id: SiteId;
  timestamp: number;
};

const now = new Date(2026, 7, 4, 12, 0, 0).getTime();
const items: TestHistoryItem[] = [
  { id: "bilibili-middle", site_id: "bilibili", timestamp: now - 20_000 },
  { id: "douyu-yesterday", site_id: "douyu", timestamp: now - 86_400_000 },
  { id: "huya-newest", site_id: "huya", timestamp: now - 10_000 },
  { id: "bilibili-oldest-today", site_id: "bilibili", timestamp: now - 30_000 },
];

function groupedIds(platform: "all" | SiteId, disabledSiteIds: unknown = []): string[][] {
  return groupHistoryByDate(items, (item) => item.timestamp, platform, disabledSiteIds, now).map(
    (group) => group.items.map((item) => item.id),
  );
}

describe("history timeline grouping", () => {
  test("mixes platforms in descending timestamp order", () => {
    expect(groupedIds("all")).toEqual([
      ["huya-newest", "bilibili-middle", "bilibili-oldest-today"],
      ["douyu-yesterday"],
    ]);
  });

  test("filters through platform tabs and disabled platform settings", () => {
    expect(groupedIds("bilibili")).toEqual([["bilibili-middle", "bilibili-oldest-today"]]);
    expect(groupedIds("all", ["huya"])).toEqual([
      ["bilibili-middle", "bilibili-oldest-today"],
      ["douyu-yesterday"],
    ]);
  });
});
