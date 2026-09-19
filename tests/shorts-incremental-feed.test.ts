import { describe, expect, test } from "bun:test";
import { createShortsFeedMerger } from "../src/features/shorts/shortsFeed";
import type { VideoItem } from "../src/shared/types/video";

const item = (id: number) => ({ bvid: `BV${id}`, cid: id, aid: String(id) }) as VideoItem;

describe("推荐 Feed 增量合并", () => {
  test("追加只读取新页，跨页去重且不修改手势持有的旧数组", () => {
    const merge = createShortsFeedMerger();
    let reads = 0;
    const first = {
      get items() {
        reads++;
        return [item(1), item(2)];
      },
    };
    const initial = merge([first]);
    const next = merge([first, { items: [item(2), item(3), item(0)] }]);
    expect(reads).toBe(1);
    expect(initial.map((i) => i.cid)).toEqual([1, 2]);
    expect(next.map((i) => i.cid)).toEqual([1, 2, 3]);
    expect(next).not.toBe(initial);
  });
  test("相同页和全重复追加保持数组引用；刷新、替换、截断重建", () => {
    const merge = createShortsFeedMerger();
    const first = { items: [item(1)] };
    const initial = merge([first]);
    expect(merge([first])).toBe(initial);
    expect(merge([first, { items: [item(1)] }])).toBe(initial);
    expect(merge([{ items: [item(2)] }]).map((i) => i.cid)).toEqual([2]);
    expect(merge([])).toEqual([]);
    expect(merge([first]).map((i) => i.cid)).toEqual([1]);
  });
});
