import { describe, expect, test } from "bun:test";
import {
  DOUYIN_FEED_MAX_BATCHES,
  mergeDouyinFeed,
  nextDouyinFeedBatch,
} from "../src/features/shorts/douyinFeed";
import type { DouyinVideoFeedPage, DouyinVideoItem } from "../src/features/shorts/douyinVideoApi";

const item = (id: string): DouyinVideoItem => ({
  id,
  title: id,
  author: "作者",
  cover: "",
  width: 1080,
  height: 1920,
  duration: 10,
  share_url: `https://www.douyin.com/video/${id}`,
});
const page = (ids: string[], more = true): DouyinVideoFeedPage => ({
  items: ids.map(item),
  has_more: more,
});
const A = "7520000000000000001";
const B = "7520000000000000002";
const C = "7520000000000000003";

describe("抖音 Cookie 推荐批次", () => {
  test("保留顺序和字符串大 ID，跨批去重不修改输入", () => {
    const pages = [page([A, B]), page([B, C, C])];
    expect(mergeDouyinFeed(pages).map((item) => item.id)).toEqual([A, B, C]);
    expect(pages[1].items).toHaveLength(3);
    expect(mergeDouyinFeed([])).toEqual([]);
  });
  test("只在本批有新作品且上游允许时继续", () => {
    const first = page([A, B]);
    const next = page([B, C]);
    expect(nextDouyinFeedBatch(first, [first])).toBe(2);
    expect(nextDouyinFeedBatch(next, [first, next])).toBe(3);
    expect(nextDouyinFeedBatch(first, [first, first])).toBeUndefined();
    expect(nextDouyinFeedBatch(page([]), [first, page([])])).toBeUndefined();
    const end = page([C], false);
    expect(nextDouyinFeedBatch(end, [first, end])).toBeUndefined();
  });
  test("单轮批次到上限后必须由用户刷新", () => {
    const pages = Array.from({ length: DOUYIN_FEED_MAX_BATCHES }, (_, index) =>
      page([String(7520000000000000000n + BigInt(index))]),
    );
    expect(nextDouyinFeedBatch(pages.at(-1)!, pages)).toBeUndefined();
  });
});
