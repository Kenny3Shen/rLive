import { describe, expect, test } from "bun:test";
import {
  flattenHistoryTimeline,
  groupHistoryByDate,
  type HistoryTimelineRow,
} from "../src/features/history/historyGrouping";

type Row = { id: string; watchedAt: number };

const rowKey = (item: Row) => item.id;
/** 行序断言：标题记作 `#标签`，记录记作 id。 */
const rowLabels = (rows: HistoryTimelineRow<Row>[]) =>
  rows.map((row) => (row.kind === "heading" ? `#${row.label}` : row.item.id));

describe("history timeline rows", () => {
  test("interleaves one heading before each group's items in group order", () => {
    const rows = flattenHistoryTimeline(
      [
        {
          key: "2026-9-14",
          label: "今天",
          items: [
            { id: "a", watchedAt: 3 },
            { id: "b", watchedAt: 2 },
          ],
        },
        { key: "2026-9-13", label: "昨天", items: [{ id: "c", watchedAt: 1 }] },
      ],
      rowKey,
    );

    expect(rowLabels(rows)).toEqual(["#今天", "a", "b", "#昨天", "c"]);
  });

  test("keeps heading keys out of the item key space", () => {
    // 记录 id 与日期键同字面量：撞键会让虚拟列表把标题的已测高度复用到记录行上。
    const rows = flattenHistoryTimeline(
      [{ key: "2026-9-14", label: "今天", items: [{ id: "2026-9-14", watchedAt: 1 }] }],
      rowKey,
    );

    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });

  test("row order follows the grouped timeline for real timestamps", () => {
    const now = new Date(2026, 8, 14, 12, 0, 0).getTime();
    const rows = flattenHistoryTimeline(
      groupHistoryByDate(
        [
          { id: "older", watchedAt: now - 86_400_000 },
          { id: "newest", watchedAt: now },
          { id: "middle", watchedAt: now - 3_600_000 },
        ],
        (item) => item.watchedAt,
        now,
      ),
      rowKey,
    );

    expect(rowLabels(rows)).toEqual(["#今天", "newest", "middle", "#昨天", "older"]);
  });
});
