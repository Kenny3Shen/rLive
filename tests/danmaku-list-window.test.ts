import { describe, expect, test } from "bun:test";
import {
  appendWithinDanmakuListWindow,
  danmakuListAppendCapacity,
  DANMAKU_LIST_MAX_PINNED,
  DANMAKU_LIST_MAX_SCROLLED_UP,
  scrollTopAfterDanmakuListTrim,
  trimToDanmakuListWindow,
} from "../src/features/room/danmaku/listWindow";

const range = (from: number, count: number) =>
  Array.from({ length: count }, (_unused, index) => from + index);

describe("danmaku list retention window", () => {
  test("trims to the pinned window while the feed is pinned", () => {
    const capacity = danmakuListAppendCapacity(true);
    expect(capacity).toBe(DANMAKU_LIST_MAX_PINNED);

    const full = range(0, DANMAKU_LIST_MAX_PINNED);
    const next = appendWithinDanmakuListWindow(full, [1_000, 1_001], capacity);

    expect(next.length).toBe(DANMAKU_LIST_MAX_PINNED);
    expect(next.at(-1)).toBe(1_001);
    // 被淘汰的正是最旧的两行；它们造成的位移之所以不可见，
    // 只是因为读者钉在底部。
    expect(next[0]).toBe(2);
  });

  test("does not evict rows on append while the reader is scrolled up", () => {
    const capacity = danmakuListAppendCapacity(false);
    expect(capacity).toBe(Number.POSITIVE_INFINITY);

    const full = range(0, DANMAKU_LIST_MAX_PINNED);
    const next = appendWithinDanmakuListWindow(full, [1_000, 1_001], capacity);

    // 顶部没有丢弃任何东西，读者正在看的行保持偏移不变，
    // 列表不会在脚下抖动。
    expect(next.length).toBe(DANMAKU_LIST_MAX_PINNED + 2);
    expect(next[0]).toBe(0);
    expect(next.at(-1)).toBe(1_001);
  });

  test("keeps the identical array when a flush had nothing to append", () => {
    const items = range(0, 3);
    expect(appendWithinDanmakuListWindow(items, [], DANMAKU_LIST_MAX_PINNED)).toBe(items);
  });

  test("re-pinning gives back the history rows and keeps the newest", () => {
    const grown = range(0, DANMAKU_LIST_MAX_PINNED + 120);
    const trimmed = trimToDanmakuListWindow(grown, DANMAKU_LIST_MAX_PINNED);

    expect(trimmed.length).toBe(DANMAKU_LIST_MAX_PINNED);
    expect(trimmed.at(-1)).toBe(grown.at(-1));
    expect(trimmed[0]).toBe(120);
  });

  test("keeps the identical array when the list already fits the window", () => {
    const items = range(0, DANMAKU_LIST_MAX_PINNED);
    expect(trimToDanmakuListWindow(items, DANMAKU_LIST_MAX_PINNED)).toBe(items);
    expect(trimToDanmakuListWindow(items, DANMAKU_LIST_MAX_SCROLLED_UP)).toBe(items);
  });

  test("bounds a long stay in history to the scrolled-up window", () => {
    let items: readonly number[] = [];
    const capacity = danmakuListAppendCapacity(false);
    for (let batch = 0; batch < 400; batch += 1) {
      items = appendWithinDanmakuListWindow(items, range(batch * 32, 32), capacity);
      items = trimToDanmakuListWindow(items, DANMAKU_LIST_MAX_SCROLLED_UP);
    }

    expect(items.length).toBe(DANMAKU_LIST_MAX_SCROLLED_UP);
    expect(items.at(-1)).toBe(400 * 32 - 1);
  });
});

describe("scroll compensation for a scrolled-up trim", () => {
  test("subtracts the removed height so the reading position holds", () => {
    // 停在 5_000 时，40_000px 列表顶部移走了 900px 的行。
    expect(scrollTopAfterDanmakuListTrim(5_000, 40_000, 39_100)).toBe(4_100);
  });

  test("clamps at the top instead of going negative", () => {
    expect(scrollTopAfterDanmakuListTrim(300, 40_000, 39_100)).toBe(0);
  });

  test("holds the top of the list still at scrollTop 0", () => {
    // 报告的 bug：在最顶部偏移无法吸收位移，
    // 补偿绝不能自行编造移动量。
    expect(scrollTopAfterDanmakuListTrim(0, 40_000, 39_100)).toBe(0);
  });

  test("keeps the offset when the content did not shrink", () => {
    expect(scrollTopAfterDanmakuListTrim(5_000, 39_100, 40_000)).toBe(5_000);
    expect(scrollTopAfterDanmakuListTrim(5_000, 40_000, 40_000)).toBe(5_000);
  });
});
