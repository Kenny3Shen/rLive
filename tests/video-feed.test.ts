import { describe, expect, test } from "bun:test";
import { videoCoverAspect, videoDimensionAspect } from "../src/shared/videoDimension";
import { videoMasonryRowSpan } from "../src/features/video/VideoMasonry";
import { nextRecommendPage } from "../src/features/video/videoFeed";
import type { VideoItem, VideoListPage } from "../src/shared/types/video";

const item = (bvid: string, cid = 1): VideoItem => ({
  bvid,
  aid: "1",
  cid,
  title: "测试视频",
  cover: "",
  author: "作者",
  author_face: null,
  duration: 30,
  view: 0,
  danmaku: 0,
  pubdate: 0,
  rcmd_reason: null,
});
const page = (...items: VideoItem[]): VideoListPage => ({ items, has_more: true });

describe("VideoCard 画幅", () => {
  test("横屏、竖屏、方形遵循 dimension", () => {
    expect(videoCoverAspect({ width: 1920, height: 1080, rotate: 0 })).toBe(16 / 9);
    expect(videoCoverAspect({ width: 1080, height: 1920, rotate: 0 })).toBe(9 / 16);
    expect(videoCoverAspect({ width: 100, height: 100, rotate: 0 })).toBe(1);
    expect(videoCoverAspect({ width: 1440, height: 1080, rotate: 0 })).toBe(4 / 3);
  });
  test("旋转标记交换宽高", () => {
    expect(videoCoverAspect({ width: 1920, height: 1080, rotate: 1 })).toBe(9 / 16);
  });
  test("尺寸未知或非法保持原有 16:9，不错误判为竖屏", () => {
    for (const dimension of [
      null,
      undefined,
      { width: 0, height: 1, rotate: 0 },
      { width: -1, height: 1, rotate: 0 },
      { width: Infinity, height: 1, rotate: 0 },
      { width: 1, height: NaN, rotate: 0 },
    ]) {
      expect(videoDimensionAspect(dimension)).toBeNull();
      expect(videoCoverAspect(dimension)).toBe(16 / 9);
    }
  });
});

describe("VOD 瀑布流跨度", () => {
  test("高度向上取整，不截断卡片与底部间距", () => {
    expect(videoMasonryRowSpan(204)).toBe(51);
    expect(videoMasonryRowSpan(204.1)).toBe(52);
    expect(videoMasonryRowSpan(1)).toBe(1);
    for (const height of [125.7, 398.25, 999.9]) {
      const allocated = videoMasonryRowSpan(height) * 4;
      expect(allocated).toBeGreaterThanOrEqual(height);
      expect(allocated - height).toBeLessThan(4);
    }
  });
  test("隐藏、空内容与异常测量保留合法行跨度", () => {
    for (const height of [0, -1, NaN, Infinity]) expect(videoMasonryRowSpan(height)).toBe(1);
  });
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
    expect(nextRecommendPage([{ ...page(item("a")), has_more: false }])).toBeUndefined();
    expect(nextRecommendPage([page(item("a")), page(item("a"))])).toBeUndefined();
  });
});
