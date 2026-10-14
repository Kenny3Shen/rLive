import type { HistoryScrollSnapshot } from "../src/features/history/historyVirtual";
import type { VirtualItem } from "@tanstack/react-virtual";
import { afterEach, describe, expect, test } from "bun:test";
import {
  HISTORY_SCROLL_SNAPSHOT_LIMIT,
  clearHistoryScrollSnapshots,
  historyStableRowKeys,
  readHistoryScrollSnapshot,
  registerHistoryRefreshScrollReset,
  resetHistoryScrollForRefresh,
  saveHistoryScrollSnapshot,
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
describe("history refresh scroll reset", () => {
  test("invokes every registered reset for a non-zero token", () => {
    let calls = 0;
    registerHistoryRefreshScrollReset(7, () => {
      calls += 1;
    });
    registerHistoryRefreshScrollReset(8, () => {
      calls += 10;
    });
    resetHistoryScrollForRefresh(7);
    expect(calls).toBe(11);
  });
  test("replaces a token's reset on re-registration and drops it on unregister", () => {
    let first = 0;
    let second = 0;
    registerHistoryRefreshScrollReset(8, () => {
      first += 1;
    });
    // 同一令牌再次登记＝替换：一条时间线只保留自己最近登记的回调。
    registerHistoryRefreshScrollReset(8, () => {
      second += 1;
    });
    resetHistoryScrollForRefresh(8);
    expect([first, second]).toEqual([0, 1]);

    // 传 null 即撤销登记（卸载路径）。
    registerHistoryRefreshScrollReset(8, null);
    resetHistoryScrollForRefresh(8);
    expect(second).toBe(1);
  });
  test("ignores the zero token, which means 'not participating'", () => {
    let calls = 0;
    registerHistoryRefreshScrollReset(0, () => {
      calls += 1;
    });
    resetHistoryScrollForRefresh(0);
    expect(calls).toBe(0);
  });
});
describe("historyStableRowKeys", () => {
  test("keeps an equivalent sequence by reference so measurements survive", () => {
    const keys = ["heading", "a", "b", "c"];
    expect(historyStableRowKeys(keys, [...keys])).toBe(keys);
  });
  test("replaces the sequence on any change, including a same-length swap", () => {
    // 同数量替换必须换新数组：虚拟器按数组身份判缓存，沿用旧引用会让新行的行键
    // 继续命中旧缓存（行内容换成别的记录、测量高度却还是上一条的）。
    const previous = ["heading", "a", "b", "c"];
    for (const replacement of [
      ["heading", "new", "a", "b"],
      ["other-heading", "x", "y", "z"],
    ]) {
      const next = historyStableRowKeys(previous, replacement);
      expect(next).toBe(replacement);
      expect(next).not.toBe(previous);
    }
  });
});
