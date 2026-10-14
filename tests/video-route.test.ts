import { describe, expect, test } from "bun:test";
import {
  DEFAULT_VIDEO_SEARCH_FILTERS,
  parseVideoPlayParams,
  parseVideoSearchFilters,
  resolveVideoZoneKey,
  videoPlayPath,
  videoSearchPath,
  videoZoneChips,
} from "../src/features/video/videoRoute";
import {
  filterVideoDanmakuEntries,
  firstVideoDanmakuAtOrAfter,
  mergeVideoDanmakuEntries,
  videoDanmakuComment,
  videoDanmakuEntries,
  videoDanmakuSegmentsFor,
} from "../src/features/video/videoDanmaku";
import {
  isVideoDanmakuSeek,
  isVideoDanmakuUserScroll,
  isVideoDanmakuVerticalDrag,
  videoDanmakuFollowIndex,
  videoDanmakuFollowScrollTop,
} from "../src/features/video/videoDanmakuFollow";
import type { VideoDanmakuItem } from "../src/shared/types/video";

describe("VOD 路由解析", () => {
  test.each([
    { bvid: "BV1xx", cid: 42, title: "标题", aid: "117075725000671" },
    { bvid: "BV2yy", cid: 7, epId: "ep99", title: "第 1 话" },
    { seasonId: "367", title: "某番剧" },
    { bvid: "BV4ww", title: "待补 cid" },
  ])("取流身份往返：%j", (target) => {
    const path = videoPlayPath(target);
    expect(parseVideoPlayParams(new URLSearchParams(path.split("?")[1]))).toEqual({
      cid: 0,
      bvid: null,
      epId: null,
      seasonId: null,
      title: null,
      aid: null,
      ...target,
    });
  });

  test.each(["", "cid=abc", "cid=0", "cid=-3", "ep_id=ep42"])(
    "无可用取流身份不进入：%s",
    (query) => {
      expect(parseVideoPlayParams(new URLSearchParams(query))).toBeNull();
    },
  );

  test("非法 cid 可由 bvid 补齐；跨页签分区不能串给另一个接口", () => {
    expect(parseVideoPlayParams(new URLSearchParams("cid=abc&bvid=BV4ww"))).toMatchObject({
      cid: 0,
      bvid: "BV4ww",
    });
    const chips = videoZoneChips("anime", [["动画", 1005]]);
    expect(resolveVideoZoneKey("anime", "1005", chips)).toBe("1");
    expect(resolveVideoZoneKey("anime", "4", chips)).toBe("4");
  });

  test("搜索筛选往返且深链非法参数退回默认", () => {
    const filters = { order: "click", duration: 2, zone: 4, pubTime: "week" } as const;
    const path = videoSearchPath("猫猫", filters);
    expect(new URLSearchParams(path.split("?")[1]).get("q")).toBe("猫猫");
    expect(parseVideoSearchFilters(new URLSearchParams(path.split("?")[1]))).toEqual(filters);
    expect(
      parseVideoSearchFilters(new URLSearchParams("order=hack&duration=9&zone=-3&pubtime=month")),
    ).toEqual(DEFAULT_VIDEO_SEARCH_FILTERS);
  });
});

function item(progress: number, content = `d${progress}`, pool = 0): VideoDanmakuItem {
  return { progress, content, pool, mode: 1, fontsize: 25, color: 0xffffff, weight: 5 };
}
const entry = (progress: number, pool = 0) =>
  videoDanmakuEntries([item(progress, undefined, pool)], 1)[0]!;

describe("VOD 弹幕时间轴", () => {
  test.each([
    [0, [1, 2]],
    [359_999, [1, 2]],
    [360_000, [2, 3]],
    [NaN, [1, 2]],
  ] as const)("跨六分钟边界预取下一段：%s", (time, expected) => {
    expect(videoDanmakuSegmentsFor(time)).toEqual(expected);
  });

  test("分段合并按时间排序、丢空白，同内容不同段身份独立", () => {
    const first = videoDanmakuEntries([item(900, "后"), item(300, "  "), item(100, "先")], 1);
    const second = videoDanmakuEntries([item(100, "先")], 2);
    expect(first.map((value) => value.content)).toEqual(["先", "后"]);
    expect(first[0]!.id).not.toBe(second[0]!.id);
    expect(mergeVideoDanmakuEntries([first, second]).map((value) => value.progressMs)).toEqual([
      100, 100, 900,
    ]);
    const filtered = filterVideoDanmakuEntries(
      [entry(100), entry(200), entry(300, 1), entry(400, 2)],
      (text) => text === "d100",
    );
    expect(filtered.map((value) => value.content)).toEqual(["d200"]);
  });

  test.each([
    ["scroll", false, "scroll", undefined],
    ["top", false, "top", 15_000],
    ["bottom", false, "bottom", 15_000],
    ["scroll", true, "top", 15_000],
  ] as const)(
    "弹幕用媒体秒定位，固定/减少动态效果按媒体时长到期：%s/%s",
    (mode, reducedMotion, expectedMode, duration) => {
      const comment = videoDanmakuComment(
        { ...entry(1_250), mode },
        {
          fontSize: 24,
          fontStroke: 0,
          opacity: 1,
          reducedMotion,
        },
      );
      expect(comment.time).toBe(1.25);
      expect(comment.mode).toBe(expectedMode);
      expect(comment.duration).toBe(duration);
    },
  );

  test("双向跳转定位已出现的行，空表不产生跟随目标", () => {
    const timeline = [entry(0), entry(1_000), entry(2_000), entry(3_000)];
    for (const [time, insertion, follow] of [
      [9_999, 4, 3],
      [1_500, 2, 1],
      [0, 0, 0],
      [2_000, 2, 1],
    ]) {
      expect(firstVideoDanmakuAtOrAfter(timeline, time!)).toBe(insertion);
      expect(videoDanmakuFollowIndex(timeline, time!)).toBe(follow);
    }
    expect(firstVideoDanmakuAtOrAfter([], 0)).toBe(0);
    expect(videoDanmakuFollowIndex([], 0)).toBe(-1);
  });

  test("跟随居中目标有界，慢拖相对固定锚点累积，不因滚到底恢复跟随", () => {
    const metrics = { rowHeight: 28, viewportHeight: 200, scrollHeight: 1_000 };
    for (const [rowTop, expected] of [
      [500, 414],
      [0, 0],
      [990, 800],
      [NaN, 0],
    ]) {
      expect(videoDanmakuFollowScrollTop({ rowTop: rowTop!, ...metrics })).toBe(expected);
    }
    expect([410, 420, 430, 440, 450].map((top) => isVideoDanmakuUserScroll(top, 400))).toEqual([
      false,
      false,
      false,
      true,
      true,
    ]);
    expect(isVideoDanmakuUserScroll(0, 414)).toBe(true);
    expect(isVideoDanmakuVerticalDrag(0, 40)).toBe(true);
    expect(isVideoDanmakuVerticalDrag(60, 20)).toBe(false);
    expect(isVideoDanmakuVerticalDrag(0, 0)).toBe(false);
  });

  test.each([
    [10_000, 10_250, false],
    [10_000, 60_000, true],
    [60_000, 10_000, true],
    [NaN, 1_000, false],
  ])("seek 与自然播放区分：%s → %s", (from, to, expected) => {
    expect(isVideoDanmakuSeek(from as number, to as number)).toBe(expected);
  });
});
