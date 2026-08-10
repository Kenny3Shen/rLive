import { describe, expect, test } from "bun:test";
import {
  filterHistoryItems,
  historyDateFilterFromSearch,
  historyDateWindow,
  matchesHistoryKeyword,
  withHistoryDateFilter,
  withHistorySearch,
} from "../src/features/history/historyFilter";
import { historyViewFromSearch, withHistoryView } from "../src/features/history/historyRoute";

const now = new Date(2026, 7, 10, 12, 0, 0).getTime();

describe("history date filters", () => {
  test("resolves relative presets to local calendar-day windows", () => {
    expect(historyDateWindow("today", now)).toEqual({
      from: new Date(2026, 7, 10).getTime(),
      to: new Date(2026, 7, 11).getTime(),
    });
    expect(historyDateWindow("yesterday", now)).toEqual({
      from: new Date(2026, 7, 9).getTime(),
      to: new Date(2026, 7, 10).getTime(),
    });
    expect(historyDateWindow("7d", now)).toEqual({
      from: new Date(2026, 7, 4).getTime(),
      to: new Date(2026, 7, 11).getTime(),
    });
  });

  test("accepts real specific dates and rejects malformed or impossible dates", () => {
    expect(historyDateFilterFromSearch("2026-08-04")).toBe("2026-08-04");
    expect(historyDateWindow("2026-08-04", now)).toEqual({
      from: new Date(2026, 7, 4).getTime(),
      to: new Date(2026, 7, 5).getTime(),
    });
    expect(historyDateFilterFromSearch("2026-02-30")).toBe("all");
    expect(historyDateFilterFromSearch("last-week")).toBe("all");
  });
});

describe("history search", () => {
  test("matches case-insensitively across the visible record fields", () => {
    expect(matchesHistoryKeyword(["晚间直播", "StreamerABC", "123"], "streamerabc")).toBe(true);
    expect(matchesHistoryKeyword(["晚间直播", "StreamerABC", "123"], "  直播  ")).toBe(true);
    expect(matchesHistoryKeyword(["晚间直播", undefined, "123"], "不存在")).toBe(false);
  });

  test("combines keyword and date filters before grouping", () => {
    const records = [
      { title: "昨天的游戏", timestamp: new Date(2026, 7, 9, 20).getTime() },
      { title: "今天的游戏", timestamp: new Date(2026, 7, 10, 8).getTime() },
      { title: "今天的音乐", timestamp: new Date(2026, 7, 10, 9).getTime() },
    ];

    expect(
      filterHistoryItems(records, {
        keyword: "游戏",
        dateFilter: "today",
        getTimestamp: (record) => record.timestamp,
        getSearchFields: (record) => [record.title],
        now,
      }),
    ).toEqual([records[1]]);
  });
});

describe("history route parameters", () => {
  test("writes compact search, date, and view parameters without dropping unrelated state", () => {
    const initial = new URLSearchParams("source=sidebar");
    const next = withHistoryView(
      withHistoryDateFilter(withHistorySearch(initial, "  主播名  "), "30d"),
      "danmaku",
    );
    expect(next.toString()).toBe(
      "source=sidebar&q=%E4%B8%BB%E6%92%AD%E5%90%8D&date=30d&view=danmaku",
    );
    expect(historyViewFromSearch(next.get("view"))).toBe("danmaku");

    expect(withHistoryView(next, "watch").has("view")).toBe(false);
    expect(withHistoryDateFilter(next, "all").has("date")).toBe(false);
    expect(withHistorySearch(next, "").has("q")).toBe(false);
  });
});
