import type { VideoItem, VideoListPage } from "../src/shared/types/video";
import { describe, expect, test } from "bun:test";
import { nextRecommendPage } from "../src/features/video/videoFeed";
import { videoItem } from "./helpers/video";
const item = (bvid: string, cid = 1): VideoItem =>
  videoItem({
    bvid,
    cid,
  });
const page = (...items: VideoItem[]): VideoListPage => ({
  items,
  has_more: true,
});
describe("APP 推荐轮换分页", () => {
  test("有新内容才继续；不是按条数猜尾页", () => {
    expect(nextRecommendPage([page(item("a"))])).toBe(2);
    expect(nextRecommendPage([page(item("a")), page(item("a"), item("b"))])).toBe(3);
    expect(nextRecommendPage([page(item("a", 1)), page(item("a", 2))])).toBe(3);
  });
  test("空批、后端停止、全重复批不会无限补货", () => {
    expect(nextRecommendPage([])).toBeUndefined();
    expect(nextRecommendPage([page()])).toBeUndefined();
    expect(
      nextRecommendPage([
        {
          ...page(item("a")),
          has_more: false,
        },
      ]),
    ).toBeUndefined();
    expect(nextRecommendPage([page(item("a")), page(item("a"))])).toBeUndefined();
  });
});
