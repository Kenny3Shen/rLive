import { describe, expect, test } from "bun:test";
import {
  appendWithinDanmakuListWindow,
  DANMAKU_LIST_CAPACITY,
} from "../src/features/room/danmaku/listWindow";

describe("直播弹幕虚拟列表数据窗口", () => {
  test("空批次保持引用", () => {
    const previous = [{ id: 1 }];
    expect(appendWithinDanmakuListWindow(previous, [])).toBe(previous);
  });

  test("追加不改变既有行对象和顺序", () => {
    const first = { id: 1 };
    const second = { id: 2 };
    const previous = [first];
    const result = appendWithinDanmakuListWindow(previous, [second]);
    expect(result).toEqual([first, second]);
    expect(result[0]).toBe(first);
    expect(previous).toEqual([first]);
  });

  test("等容量替换保留最新条目，键和对象仍稳定", () => {
    const previous = Array.from({ length: DANMAKU_LIST_CAPACITY }, (_, id) => ({ id }));
    const batch = Array.from({ length: 32 }, (_, offset) => ({
      id: DANMAKU_LIST_CAPACITY + offset,
    }));
    const result = appendWithinDanmakuListWindow(previous, batch);
    expect(result).toHaveLength(DANMAKU_LIST_CAPACITY);
    expect(result[0]).toBe(previous[32]);
    expect(result.at(-1)).toBe(batch.at(-1));
    expect(previous).toHaveLength(DANMAKU_LIST_CAPACITY);
  });

  test("大批次只留下最新窗口，不混入过期数据", () => {
    expect(appendWithinDanmakuListWindow([1, 2], [3, 4, 5, 6], 3)).toEqual([4, 5, 6]);
    expect(appendWithinDanmakuListWindow([1, 2, 3], [4, 5], 3)).toEqual([3, 4, 5]);
  });

  test("持续流量中数据容量恒定，不因阅读历史无限增长", () => {
    let items: readonly number[] = [];
    for (let start = 0; start < 10_000; start += 32) {
      items = appendWithinDanmakuListWindow(
        items,
        Array.from({ length: 32 }, (_, i) => start + i),
      );
      expect(items.length).toBeLessThanOrEqual(DANMAKU_LIST_CAPACITY);
    }
    expect(items.at(-1)).toBe(10_015);
    expect(items[0]).toBe(10_016 - DANMAKU_LIST_CAPACITY);
  });
});
