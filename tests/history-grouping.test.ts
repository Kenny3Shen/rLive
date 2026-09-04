import { describe, expect, test } from "bun:test";
import { filterHistoryBySite, groupHistoryByDate } from "../src/features/history/historyGrouping";
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

describe("history timeline grouping", () => {
  test("mixes platforms in descending timestamp order", () => {
    expect(
      groupHistoryByDate(items, (item) => item.timestamp, now).map((group) => ({
        label: group.label,
        ids: group.items.map((item) => item.id),
      })),
    ).toEqual([
      { label: "今天", ids: ["huya-newest", "bilibili-middle", "bilibili-oldest-today"] },
      { label: "昨天", ids: ["douyu-yesterday"] },
    ]);
  });

  test("filters through platform tabs and disabled platform settings", () => {
    expect(filterHistoryBySite(items, "bilibili", []).map((item) => item.id)).toEqual([
      "bilibili-middle",
      "bilibili-oldest-today",
    ]);
    expect(filterHistoryBySite(items, "all", ["huya"]).map((item) => item.id)).toEqual([
      "bilibili-middle",
      "douyu-yesterday",
      "bilibili-oldest-today",
    ]);
  });

  // 视频历史没有 site_id：分组必须只依赖时间戳，否则该视图无法复用这条时间线。
  test("groups records without a site_id, such as video history", () => {
    const videoHistory = [
      { oid: "BV1", watched_at: now - 5_000 },
      { oid: "BV2", watched_at: now - 86_400_000 },
      { oid: "BV3", watched_at: now - 1_000 },
    ];

    expect(
      groupHistoryByDate(videoHistory, (item) => item.watched_at, now).map((group) =>
        group.items.map((item) => item.oid),
      ),
    ).toEqual([["BV3", "BV1"], ["BV2"]]);
  });
});
