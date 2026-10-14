import { describe, expect, test } from "bun:test";
import {
  filterHistoryItems,
  historyDateFilterFromSearch,
  historyDateWindow,
  historyDayRange,
} from "../src/features/history/historyFilter";
const day = (year: number, month: number, date: number) => new Date(year, month - 1, date);
describe("history date range filter", () => {
  test("includes both ends of the range and nothing past them", () => {
    const window = historyDateWindow("2026-09-10~2026-09-12", Date.now());
    expect(window).toEqual({
      from: day(2026, 9, 10).getTime(),
      to: day(2026, 9, 13).getTime(),
    });
    // 终点当天 23:59 仍在范围内：右界是「结束日 + 1 天」的零点。
    expect(new Date(2026, 8, 12, 23, 59, 59).getTime()).toBeLessThan(window!.to);
  });
  test("normalizes a reversed range instead of dropping it", () => {
    expect(historyDateFilterFromSearch("2026-09-12~2026-09-10")).toBe("2026-09-10~2026-09-12");
    expect(historyDayRange("2026-09-12~2026-09-10")).toEqual({
      from: day(2026, 9, 10),
      to: day(2026, 9, 12),
    });
  });
  test("degrades unusable ranges to the full timeline", () => {
    for (const value of [
      "2026-02-30",
      "2026-09-10~",
      "2026-09-10~nope",
      "2026-09-10~2026-09-11~2026-09-12",
    ]) {
      expect(historyDateFilterFromSearch(value)).toBe("all");
      expect(historyDateWindow(value, Date.now())).toBeNull();
    }
  });
  test("narrows a timeline to the selected range", () => {
    const items = [
      {
        at: new Date(2026, 8, 9, 23, 30).getTime(),
      },
      {
        at: new Date(2026, 8, 10, 0, 5).getTime(),
      },
      {
        at: new Date(2026, 8, 12, 23, 30).getTime(),
      },
      {
        at: new Date(2026, 8, 13, 0, 5).getTime(),
      },
    ];
    expect(
      filterHistoryItems(items, {
        keyword: "",
        dateFilter: "2026-09-10~2026-09-12",
        getTimestamp: (item) => item.at,
        getSearchFields: () => [],
      }),
    ).toEqual([items[1]!, items[2]!]);
  });
});
