import { describe, expect, test } from "bun:test";
import { Virtualizer } from "@tanstack/react-virtual";
import { historyStableRowKeys } from "../src/features/history/historyVirtual";

describe("历史虚拟器缓存与订阅", () => {
  test("同数量替换/筛选改变行键，等价序列保持引用稳定", () => {
    let keys: readonly string[] = ["heading", "a", "b", "c"];
    const v = new Virtualizer<HTMLElement, HTMLElement>({
      count: keys.length,
      getScrollElement: () => null,
      estimateSize: () => 40,
      getItemKey: (index) => keys[index]!,
      scrollToFn: () => {},
      observeElementOffset: () => {},
      observeElementRect: () => {},
      initialRect: { width: 300, height: 400 },
      anchorTo: "start",
    });
    expect(v.getVirtualItems().map((row) => row.key)).toEqual(keys);
    expect(historyStableRowKeys(keys, [...keys])).toBe(keys);
    for (const replacement of [
      ["heading", "new", "a", "b"],
      ["other-heading", "x", "y", "z"],
    ]) {
      keys = historyStableRowKeys(keys, replacement);
      const captured = keys;
      v.setOptions({ ...v.options, getItemKey: (index) => captured[index]! });
      expect(v.getVirtualItems().map((row) => row.key)).toEqual(replacement);
    }
  });

  test("隐藏断开滚动/尺寸观察但不清测量，激活重新订阅", () => {
    const scroller = {} as HTMLElement;
    let active = true;
    let subscriptions = 0;
    const v = new Virtualizer<HTMLElement, HTMLElement>({
      count: 4,
      getScrollElement: () => (active ? scroller : null),
      estimateSize: () => 40,
      getItemKey: (i) => `row-${i}`,
      scrollToFn: () => {},
      observeElementOffset: (_, cb) => {
        subscriptions++;
        cb(40, false);
        return () => {
          subscriptions--;
        };
      },
      observeElementRect: (_, cb) => {
        subscriptions++;
        cb({ width: 300, height: 100 });
        return () => {
          subscriptions--;
        };
      },
    });
    const cleanup = v._didMount();
    v._willUpdate();
    v.getVirtualItems();
    v.resizeItem(1, 77);
    expect(subscriptions).toBe(2);
    active = false;
    v._willUpdate();
    expect(subscriptions).toBe(0);
    expect(v.itemSizeCache.get("row-1")).toBe(77);
    active = true;
    v._willUpdate();
    expect(subscriptions).toBe(2);
    expect(v.getVirtualItems().find((row) => row.key === "row-1")?.size).toBe(77);
    cleanup();
    expect(subscriptions).toBe(0);
  });
});
