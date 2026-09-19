import { describe, expect, test } from "bun:test";
import type { VideoUploaderStoryItem, VideoUploaderStoryPage } from "../src/shared/types/video";
import {
  shortsActiveSlot,
  shortsNextSlots,
  shortsTrackOffset,
  type ShortsSlots,
} from "../src/features/shorts/shortsFeed";
import {
  shortsAnchoredIndex,
  shortsStableSlotPadding,
  shortsUnpadSlots,
  shortsUploaderCounter,
  shortsUploaderCursor,
  shortsUploaderInitialIndex,
  shortsUploaderItems,
  shortsValidateUploaderPage,
} from "../src/features/shorts/shortsUploaderFeed";

function item(
  index: number,
  overrides: Partial<VideoUploaderStoryItem> = {},
): VideoUploaderStoryItem {
  return {
    aid: String(index),
    bvid: `BV${index}`,
    cid: index,
    title: `稿件 ${index}`,
    cover: "",
    author: "测试 UP",
    author_mid: "100",
    author_face: null,
    duration: 10,
    view: 0,
    danmaku: 0,
    pubdate: 0,
    rcmd_reason: null,
    index,
    ...overrides,
  };
}
function page(
  indexes: number[],
  overrides: Partial<VideoUploaderStoryPage> = {},
): VideoUploaderStoryPage {
  return {
    items: indexes.map((index) => item(index)),
    total: 100,
    next_cursor: null,
    prev_cursor: null,
    ...overrides,
  };
}
const emptySlots: ShortsSlots = { held: { a: null, b: null, c: null }, active: "a" };

describe("UP story 初始定位与真实计数", () => {
  test("从当前稿件而非第一条开始，56/100 不取本地序号", () => {
    const items = page([54, 55, 56, 57]).items;
    const index = shortsUploaderInitialIndex(items, "56");
    expect(index).toBe(2);
    expect(shortsUploaderCounter(items[index], 100)).toBe("56/100");
    expect(shortsUploaderCounter(page([56]).items[0], 100)).toBe("56/100");
  });
  test("seed 缺失不静默跳第一条", () => {
    expect(() => shortsUploaderInitialIndex(page([1]).items, "56")).toThrow("不在此 UP 主");
    expect(() =>
      shortsValidateUploaderPage(page([]), { direction: "initial", cursor: "56" }),
    ).toThrow();
  });
  test("无合法上游位置时不伪造计数", () => {
    expect(shortsUploaderCounter(undefined, 100)).toBeNull();
    expect(shortsUploaderCounter(item(0), 100)).toBeNull();
    expect(shortsUploaderCounter(item(56), 0)).toBeNull();
    expect(shortsUploaderCounter(item(56), 50)).toBeNull();
  });
  test("不按画幅或 cid 过滤，也不共享推荐去重状态", () => {
    const source = page([56]);
    source.items.push(item(57, { cid: null, dimension: { width: 1920, height: 1080, rotate: 0 } }));
    expect(shortsUploaderItems([source])).toEqual(source.items);
    expect(shortsUploaderItems([source])).toEqual(source.items);
  });
});

describe("双向拼接与分页边界", () => {
  test("prev 升序前插、next 后接，只合并重复 aid", () => {
    const merged = shortsUploaderItems([page([53, 54, 55, 56]), page([56, 57]), page([57, 58])]);
    expect(merged.map((value) => value.index)).toEqual([53, 54, 55, 56, 57, 58]);
    expect(shortsAnchoredIndex(merged, item(56), 0)).toBe(3);
    expect(shortsUploaderCounter(merged[3], 100)).toBe("56/100");
  });
  test("前插不改变当前稿件身份与舞台停靠", () => {
    const before = page([56, 57]).items;
    const after = shortsUploaderItems([page([54, 55]), page([56, 57])]);
    const index = shortsAnchoredIndex(after, before[0], 0);
    expect(after[index]?.aid).toBe("56");
    expect(shortsTrackOffset(index, 800) + index * 800).toBe(0);
  });
  test("缺失游标即边界，空终止页不制造下一页", () => {
    expect(shortsUploaderCursor(page([1]), "prev")).toBeUndefined();
    expect(shortsUploaderCursor(page([100]), "next")).toBeUndefined();
    expect(
      shortsValidateUploaderPage(page([]), { direction: "next", cursor: "100" }, [page([100])]),
    ).toEqual(page([]));
  });
  test("只使用该方向边缘的返回游标", () => {
    const value = page([56], { next_cursor: "next-token", prev_cursor: "prev-token" });
    expect(shortsUploaderCursor(value, "next")).toBe("next-token");
    expect(shortsUploaderCursor(value, "prev")).toBe("prev-token");
  });
  test("游标不推进或回环时抛可重试错误", () => {
    expect(() =>
      shortsValidateUploaderPage(
        page([57], { next_cursor: "56" }),
        { direction: "next", cursor: "56" },
        [page([56])],
      ),
    ).toThrow("分页未前进");
    expect(() =>
      shortsValidateUploaderPage(
        page([58], { next_cursor: "55" }),
        { direction: "next", cursor: "57" },
        [page([56, 57])],
        [{ direction: "next", cursor: "55" }],
      ),
    ).toThrow("分页未前进");
  });
  test("重复页带新游标也不能自动重试死循环", () => {
    expect(() =>
      shortsValidateUploaderPage(
        page([56], { prev_cursor: "55" }),
        { direction: "prev", cursor: "56" },
        [page([56])],
      ),
    ).toThrow("分页未前进");
  });
  test("合法重叠页能前进，initial 的 seed 游标不阻止 prev", () => {
    const previous = page([55, 56], { prev_cursor: "55" });
    expect(
      shortsValidateUploaderPage(
        previous,
        { direction: "prev", cursor: "56" },
        [page([56])],
        [{ direction: "initial", cursor: "56" }],
      ),
    ).toBe(previous);
  });
  test("回推荐按原视频身份恢复，下标越界有界收回", () => {
    const original = page([10, 11, 12]).items;
    expect(shortsAnchoredIndex(original, original[1], 0)).toBe(1);
    expect(shortsAnchoredIndex(original, item(999), 100)).toBe(2);
    expect(shortsAnchoredIndex([], undefined, 0)).toBe(0);
  });
});

describe("前插与切模式保持三槽播放器所有权", () => {
  test("任意原下标、前插数都保留活动槽位，不换播放器", () => {
    for (let before = 0; before < 9; before++) {
      for (let prefix = 0; prefix < 3; prefix++) {
        for (let added = 0; added < 12; added++) {
          const after = before + added;
          const padding = shortsStableSlotPadding(before, prefix, after);
          expect(shortsActiveSlot(after + padding)).toBe(shortsActiveSlot(before + prefix));
          expect(padding).toBeGreaterThanOrEqual(0);
          expect(padding).toBeLessThan(3);
        }
      }
    }
  });
  test("进入 UP 从本地下标 8 切到 0，也留在原媒体槽位", () => {
    const padding = shortsStableSlotPadding(8, 0, 0);
    const padded = shortsNextSlots(padding, padding + 11, 1, emptySlots);
    const slots = shortsUnpadSlots(padded, padding);
    expect(slots.active).toBe(shortsActiveSlot(8));
    expect(slots.held[slots.active]).toBe(0);
    expect(
      Object.values(slots.held)
        .filter((value) => value !== null)
        .sort(),
    ).toEqual([0, 1]);
  });
  test("前插后邻居也留在原槽位，空前缀不进入浏览范围", () => {
    const before = shortsNextSlots(1, 5, 1, emptySlots);
    const afterIndex = 6;
    const padding = shortsStableSlotPadding(1, 0, afterIndex);
    const after = shortsUnpadSlots(
      shortsNextSlots(afterIndex + padding, 10 + padding, 1, before),
      padding,
    );
    for (const id of ["a", "b", "c"] as const) {
      expect(after.held[id]).toBe(before.held[id]! + 5);
    }
    expect(after.active).toBe(before.active);
  });
});
