import { describe, expect, test } from "bun:test";
import { aggregateViewingRecordStatistics } from "../src/features/statistics/statistics";
import type { HistoryItem } from "../src/shared/types/live";

function historyItem(overrides: Partial<HistoryItem> = {}): HistoryItem {
  return {
    site_id: "bilibili",
    room_id: "100",
    title: "直播间",
    user_name: "主播",
    watched_at: Date.parse("2026-07-27T01:00:00+08:00"),
    ...overrides,
  };
}

describe("viewing-record statistics", () => {
  test("zero-fills the last seven China calendar days across date boundaries", () => {
    const statistics = aggregateViewingRecordStatistics(
      [
        // 2026-07-20 23:59:59.999 in China: just before the seven-day window.
        historyItem({
          room_id: "outside-window",
          watched_at: Date.parse("2026-07-20T15:59:59.999Z"),
        }),
        // 2026-07-21 00:00:00 in China: first day of the window.
        historyItem({
          site_id: "douyu",
          room_id: "first-day",
          watched_at: Date.parse("2026-07-20T16:00:00.000Z"),
        }),
        // 2026-07-26 23:59:59 in China.
        historyItem({
          site_id: "huya",
          room_id: "yesterday",
          watched_at: Date.parse("2026-07-26T15:59:59.000Z"),
        }),
        // 2026-07-27 00:00:00 in China: today, despite still being 7/26 UTC.
        historyItem({
          room_id: "today",
          watched_at: Date.parse("2026-07-26T16:00:00.000Z"),
        }),
      ],
      new Date("2026-07-27T00:30:00+08:00"),
    );

    expect(statistics.last7Days).toEqual([
      { date: "2026-07-21", recordCount: 1 },
      { date: "2026-07-22", recordCount: 0 },
      { date: "2026-07-23", recordCount: 0 },
      { date: "2026-07-24", recordCount: 0 },
      { date: "2026-07-25", recordCount: 0 },
      { date: "2026-07-26", recordCount: 1 },
      { date: "2026-07-27", recordCount: 1 },
    ]);
    expect(statistics.todayRecords).toBe(1);
    // The overview remains an all-history record count, rather than only the
    // currently charted seven-day window.
    expect(statistics.totalRecords).toBe(4);
  });

  test("counts distinct rooms by platform and provides a stable platform distribution", () => {
    const statistics = aggregateViewingRecordStatistics(
      [
        historyItem({ room_id: "100", watched_at: Date.parse("2026-07-27T01:00:00+08:00") }),
        historyItem({ room_id: "100", watched_at: Date.parse("2026-07-26T01:00:00+08:00") }),
        historyItem({
          site_id: "douyu",
          room_id: "100",
          watched_at: Date.parse("2026-07-27T02:00:00+08:00"),
        }),
        historyItem({
          site_id: "huya",
          room_id: "200",
          watched_at: Date.parse("2026-07-19T02:00:00+08:00"),
        }),
      ],
      new Date("2026-07-27T10:00:00+08:00"),
    );

    expect(statistics).toMatchObject({
      totalRecords: 4,
      distinctRooms: 3,
      distinctPlatforms: 3,
      todayRecords: 2,
    });
    expect(statistics.platformDistribution).toEqual([
      { siteId: "bilibili", recordCount: 2 },
      { siteId: "douyu", recordCount: 1 },
      { siteId: "huya", recordCount: 1 },
    ]);
  });

  test("ignores malformed timestamps instead of assigning them to a calendar day", () => {
    const statistics = aggregateViewingRecordStatistics(
      [
        historyItem({ room_id: "valid" }),
        historyItem({ room_id: "nan", watched_at: Number.NaN }),
        historyItem({ room_id: "out-of-range", watched_at: Number.MAX_VALUE }),
      ],
      new Date("2026-07-27T10:00:00+08:00"),
    );

    expect(statistics.totalRecords).toBe(1);
    expect(statistics.distinctRooms).toBe(1);
    expect(statistics.todayRecords).toBe(1);
    expect(statistics.last7Days.at(-1)).toEqual({ date: "2026-07-27", recordCount: 1 });
  });
});
