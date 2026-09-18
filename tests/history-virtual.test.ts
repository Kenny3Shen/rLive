import { afterEach, describe, expect, test } from "bun:test";
import type { VirtualItem } from "@tanstack/react-virtual";
import {
  HISTORY_LIVE_EDGE_THRESHOLD_PX,
  HISTORY_SCROLL_SNAPSHOT_LIMIT,
  clearHistoryScrollSnapshots,
  historyAnchorTo,
  historySnapshotKey,
  readHistoryScrollSnapshot,
  saveHistoryScrollSnapshot,
  type HistoryScrollSnapshot,
} from "../src/features/history/historyVirtual";

/** 造一条形态合法的测量，内容无所谓：LRU 只按键淘汰，不看测量值。 */
const measurement = (index: number): VirtualItem => ({
  key: `row-${index}`,
  index,
  start: index * 100,
  end: index * 100 + 100,
  size: 100,
  lane: 0,
});

const snapshotOf = (offset: number): HistoryScrollSnapshot => ({
  measurements: [measurement(0)],
  offset,
});

// 快照存在模块级 Map 里，跨用例共享；每个用例前清空，断言才不受上一条影响。
afterEach(clearHistoryScrollSnapshots);

describe("history scroll snapshot store", () => {
  test("reads back what was written, keyed independently", () => {
    saveHistoryScrollSnapshot("a", snapshotOf(120));
    saveHistoryScrollSnapshot("b", snapshotOf(340));

    expect(readHistoryScrollSnapshot("a")?.offset).toBe(120);
    expect(readHistoryScrollSnapshot("b")?.offset).toBe(340);
    expect(readHistoryScrollSnapshot("missing")).toBeNull();
  });

  test("overwrites in place instead of accumulating", () => {
    saveHistoryScrollSnapshot("a", snapshotOf(120));
    saveHistoryScrollSnapshot("a", snapshotOf(999));

    expect(readHistoryScrollSnapshot("a")?.offset).toBe(999);
  });

  test("ignores empty keys", () => {
    saveHistoryScrollSnapshot("", snapshotOf(120));
    expect(readHistoryScrollSnapshot("")).toBeNull();
  });

  test("clear empties the store", () => {
    saveHistoryScrollSnapshot("a", snapshotOf(120));
    clearHistoryScrollSnapshots();
    expect(readHistoryScrollSnapshot("a")).toBeNull();
  });

  test("evicts the oldest entry once past the limit", () => {
    for (let index = 0; index < HISTORY_SCROLL_SNAPSHOT_LIMIT; index += 1) {
      saveHistoryScrollSnapshot(`key-${index}`, snapshotOf(index));
    }
    // 再写一条越界：最旧的 key-0 应被淘汰，其余保留。
    saveHistoryScrollSnapshot("overflow", snapshotOf(-1));

    expect(readHistoryScrollSnapshot("key-0")).toBeNull();
    expect(readHistoryScrollSnapshot("key-1")?.offset).toBe(1);
    expect(readHistoryScrollSnapshot("overflow")?.offset).toBe(-1);
  });

  test("overwriting refreshes recency, sparing a key from eviction", () => {
    for (let index = 0; index < HISTORY_SCROLL_SNAPSHOT_LIMIT; index += 1) {
      saveHistoryScrollSnapshot(`key-${index}`, snapshotOf(index));
    }
    // 覆盖最旧的一条应把它移到末尾；下一次越界改淘汰 key-1。
    saveHistoryScrollSnapshot("key-0", snapshotOf(1000));
    saveHistoryScrollSnapshot("overflow", snapshotOf(-1));

    expect(readHistoryScrollSnapshot("key-0")?.offset).toBe(1000);
    expect(readHistoryScrollSnapshot("key-1")).toBeNull();
  });
});

describe("historyAnchorTo", () => {
  test("does not anchor at or within the live-edge threshold", () => {
    expect(historyAnchorTo(0)).toBe("start");
    expect(historyAnchorTo(HISTORY_LIVE_EDGE_THRESHOLD_PX)).toBe("start");
  });

  test("anchors to end once scrolled past the threshold", () => {
    expect(historyAnchorTo(HISTORY_LIVE_EDGE_THRESHOLD_PX + 1)).toBe("end");
    expect(historyAnchorTo(4000)).toBe("end");
  });
});

describe("historySnapshotKey", () => {
  test("combines entry key and view without colliding across views", () => {
    const keys = new Set([
      historySnapshotKey("abc123", "watch"),
      historySnapshotKey("abc123", "video"),
      historySnapshotKey("abc123", "danmaku"),
    ]);
    expect(keys.size).toBe(3);
    expect(historySnapshotKey("abc123", "watch")).toBe("abc123:watch");
  });

  test("separates the same view across different history entries", () => {
    expect(historySnapshotKey("abc123", "watch")).not.toBe(historySnapshotKey("def456", "watch"));
  });

  test("is deterministic for the same inputs", () => {
    expect(historySnapshotKey("k", "video")).toBe(historySnapshotKey("k", "video"));
  });
});
