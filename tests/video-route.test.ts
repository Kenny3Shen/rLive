import { describe, expect, test } from "bun:test";
import {
  PGC_SEASON_TYPES,
  VIDEO_POPULAR_ALL_ZONE_KEY,
  VIDEO_TABS,
  parseVideoPlayParams,
  resolveVideoZoneKey,
  videoOriginalUrl,
  videoHomePath,
  videoPlayPath,
  videoSearchPath,
  videoTabFromSearch,
  videoTabHasZoneStrip,
  videoTabUsesPgc,
  videoZoneChips,
} from "../src/features/video/videoRoute";
import {
  filterVideoDanmakuEntries,
  firstVideoDanmakuAtOrAfter,
  mergeVideoDanmakuEntries,
  nextVideoDanmakuBatch,
  videoDanmakuColor,
  videoDanmakuEntries,
  videoDanmakuMode,
  videoDanmakuSegmentIndex,
  videoDanmakuSegmentsFor,
} from "../src/features/video/videoDanmaku";
import type { VideoDanmakuItem } from "../src/shared/types/video";

const UGC_ZONES: readonly (readonly [string, number])[] = [
  ["动画", 1005],
  ["音乐", 1003],
];

describe("video tabs", () => {
  test("falls back to the recommend feed for missing and unknown tabs", () => {
    expect(videoTabFromSearch(null)).toBe("recommend");
    expect(videoTabFromSearch("nope")).toBe("recommend");
    expect(videoTabFromSearch("anime")).toBe("anime");
  });

  test("gives every tab except recommend a zone strip", () => {
    expect(videoTabHasZoneStrip("recommend")).toBe(false);
    expect(videoTabHasZoneStrip("popular")).toBe(true);
    expect(videoTabHasZoneStrip("anime")).toBe(true);
    expect(videoTabHasZoneStrip("cinema")).toBe(true);
  });

  test("separates the PGC season_type tabs from the UGC rid tab", () => {
    expect(videoTabUsesPgc("anime")).toBe(true);
    expect(videoTabUsesPgc("cinema")).toBe(true);
    expect(videoTabUsesPgc("popular")).toBe(false);
  });

  test("keeps the popular strip's first chip as the site-wide ranking", () => {
    const chips = videoZoneChips("popular", UGC_ZONES);
    expect(chips[0]).toEqual({ key: VIDEO_POPULAR_ALL_ZONE_KEY, label: "全部" });
    expect(chips.slice(1).map((chip) => chip.label)).toEqual(["动画", "音乐"]);
  });

  test("builds the PGC strips from season_type rather than the backend zone list", () => {
    expect(videoZoneChips("anime", UGC_ZONES).map((chip) => chip.key)).toEqual([
      String(PGC_SEASON_TYPES.anime),
      String(PGC_SEASON_TYPES.guochuang),
      String(PGC_SEASON_TYPES.documentary),
    ]);
    expect(videoZoneChips("cinema", UGC_ZONES).map((chip) => chip.key)).toEqual([
      String(PGC_SEASON_TYPES.movie),
      String(PGC_SEASON_TYPES.teleplay),
      String(PGC_SEASON_TYPES.variety),
    ]);
    expect(videoZoneChips("recommend", UGC_ZONES)).toEqual([]);
  });
});

describe("video zone resolution", () => {
  test("ignores a zone that does not belong to the current tab", () => {
    const animeChips = videoZoneChips("anime", UGC_ZONES);
    // 1005 是 UGC 的 rid，不是 season_type：把它喂给番剧接口会取到无关内容，
    // 因此必须回落该页签首项。
    expect(resolveVideoZoneKey("anime", "1005", animeChips)).toBe(String(PGC_SEASON_TYPES.anime));
    expect(resolveVideoZoneKey("anime", "4", animeChips)).toBe("4");
  });

  test("has no zone at all on the recommend tab", () => {
    expect(resolveVideoZoneKey("recommend", "1005", videoZoneChips("recommend", UGC_ZONES))).toBe(
      null,
    );
  });

  test("defaults the popular tab to the site-wide ranking", () => {
    const chips = videoZoneChips("popular", UGC_ZONES);
    expect(resolveVideoZoneKey("popular", null, chips)).toBe(VIDEO_POPULAR_ALL_ZONE_KEY);
    expect(resolveVideoZoneKey("popular", "1003", chips)).toBe("1003");
  });
});

describe("video paths", () => {
  test("leaves the default tab out of the query string", () => {
    expect(videoHomePath("recommend")).toBe("/video");
    expect(videoHomePath("anime")).toBe("/video?tab=anime");
    expect(videoHomePath("popular", "1005")).toBe("/video?tab=popular&zone=1005");
  });

  test("builds the search path with the keyword in the url", () => {
    expect(videoSearchPath()).toBe("/video/search");
    expect(videoSearchPath("  猫猫 ")).toBe("/video/search?q=%E7%8C%AB%E7%8C%AB");
  });

  test("round-trips a UGC play target", () => {
    const path = videoPlayPath({ bvid: "BV1xx", cid: 42, title: "标题" });
    const params = parseVideoPlayParams(new URLSearchParams(path.split("?")[1]));
    expect(params).toEqual({ cid: 42, bvid: "BV1xx", epId: null, title: "标题", aid: null });
  });

  test("round-trips a PGC play target", () => {
    const path = videoPlayPath({ bvid: "BV2yy", cid: 7, epId: "ep99", title: "第 1 话" });
    const params = parseVideoPlayParams(new URLSearchParams(path.split("?")[1]));
    expect(params).toEqual({ cid: 7, bvid: "BV2yy", epId: "ep99", title: "第 1 话", aid: null });
  });

  test("round-trips aid for the comment section", () => {
    // aid 是评论区的 oid；列表/分集链路带着它，URL 直入时可缺省。
    const path = videoPlayPath({ bvid: "BV3zz", cid: 9, title: "x", aid: "117075725000671" });
    const params = parseVideoPlayParams(new URLSearchParams(path.split("?")[1]));
    expect(params?.aid).toBe("117075725000671");
  });

  test("rejects play links without a usable cid or bvid", () => {
    // cid 与 bvid 至少一个有效；拿 NaN 去请求后端只会换来一个无法解释的失败。
    expect(parseVideoPlayParams(new URLSearchParams(""))).toBeNull();
    expect(parseVideoPlayParams(new URLSearchParams("cid=abc"))).toBeNull();
    expect(parseVideoPlayParams(new URLSearchParams("cid=0"))).toBeNull();
    expect(parseVideoPlayParams(new URLSearchParams("cid=-3"))).toBeNull();
  });

  test("round-trips a bvid-only target from search/uploader lists", () => {
    // 搜索/UP 主列表的条目没有 cid：链接只带 bvid，播放页用稿件详情补齐（P1）。
    const path = videoPlayPath({ bvid: "BV4ww", cid: null, title: "无 cid 条目" });
    expect(path).not.toContain("cid=");
    const params = parseVideoPlayParams(new URLSearchParams(path.split("?")[1]));
    expect(params).toEqual({
      cid: 0,
      bvid: "BV4ww",
      epId: null,
      title: "无 cid 条目",
      aid: null,
    });
    // 无效 cid 配 bvid 仍可进入，cid 归零待补。
    expect(parseVideoPlayParams(new URLSearchParams("cid=abc&bvid=BV4ww"))).toMatchObject({
      cid: 0,
      bvid: "BV4ww",
    });
  });

  test("keeps the tab strip order stable for the shell's pan direction", () => {
    expect([...VIDEO_TABS]).toEqual(["recommend", "popular", "anime", "cinema"]);
  });
});

describe("video original url", () => {
  test("points UGC at the bvid page and omits ?p= for P1", () => {
    expect(videoOriginalUrl("BV1Ykt46iEYW", null, 1)).toBe(
      "https://www.bilibili.com/video/BV1Ykt46iEYW/",
    );
  });

  test("keeps the part number for multi-part playback", () => {
    expect(videoOriginalUrl("BV1Ykt46iEYW", null, 7)).toBe(
      "https://www.bilibili.com/video/BV1Ykt46iEYW/?p=7",
    );
  });

  test("prefers the PGC episode path and falls back to null without identity", () => {
    expect(videoOriginalUrl("BV1xx", "123456")).toBe(
      "https://www.bilibili.com/bangumi/play/ep123456",
    );
    expect(videoOriginalUrl(null, null)).toBeNull();
  });
});

describe("VOD danmaku segmentation", () => {
  test("splits on six-minute boundaries starting at index 1", () => {
    expect(videoDanmakuSegmentIndex(0)).toBe(1);
    expect(videoDanmakuSegmentIndex(359_999)).toBe(1);
    expect(videoDanmakuSegmentIndex(360_000)).toBe(2);
    expect(videoDanmakuSegmentIndex(720_001)).toBe(3);
  });

  test("clamps negative and non-finite positions to the first segment", () => {
    expect(videoDanmakuSegmentIndex(-5)).toBe(1);
    expect(videoDanmakuSegmentIndex(Number.NaN)).toBe(1);
  });

  test("prefetches the next segment so cross-boundary bullets enter on time", () => {
    expect(videoDanmakuSegmentsFor(0)).toEqual([1, 2]);
    expect(videoDanmakuSegmentsFor(400_000)).toEqual([2, 3]);
  });
});

describe("VOD danmaku mapping", () => {
  test("maps upstream modes onto the three danmu.js forms", () => {
    expect(videoDanmakuMode(1)).toBe("scroll");
    expect(videoDanmakuMode(2)).toBe("scroll");
    expect(videoDanmakuMode(3)).toBe("scroll");
    expect(videoDanmakuMode(4)).toBe("bottom");
    expect(videoDanmakuMode(5)).toBe("top");
    // 6/7/8/9 没有对应形态，降级滚动而不是丢弃。
    expect(videoDanmakuMode(6)).toBe("scroll");
    expect(videoDanmakuMode(9)).toBe("scroll");
  });

  test("converts decimal RGB into a css hex colour", () => {
    expect(videoDanmakuColor(16_777_215)).toBe("#ffffff");
    expect(videoDanmakuColor(16_711_680)).toBe("#ff0000");
    expect(videoDanmakuColor(255)).toBe("#0000ff");
  });

  test("falls back to white for out-of-range colours", () => {
    expect(videoDanmakuColor(0)).toBe("#ffffff");
    expect(videoDanmakuColor(-1)).toBe("#ffffff");
    expect(videoDanmakuColor(16_777_216)).toBe("#ffffff");
    expect(videoDanmakuColor(Number.NaN)).toBe("#ffffff");
  });

  test("drops blank content and sorts by progress", () => {
    const items: VideoDanmakuItem[] = [
      { progress: 900, mode: 1, fontsize: 25, color: 16_777_215, content: "后", weight: 5, pool: 0 },
      { progress: 100, mode: 1, fontsize: 25, color: 16_777_215, content: "先", weight: 5, pool: 0 },
      { progress: 300, mode: 1, fontsize: 25, color: 16_777_215, content: "   ", weight: 5, pool: 0 },
    ];
    const entries = videoDanmakuEntries(items, 1);
    expect(entries.map((entry) => entry.content)).toEqual(["先", "后"]);
  });

  test("scopes entry ids to their segment", () => {
    const item: VideoDanmakuItem = {
      progress: 500,
      mode: 1,
      fontsize: 25,
      color: 16_777_215,
      content: "同",
      weight: 5,
      pool: 0,
    };
    // 不同段里 progress 可能巧合相同；id 不带段号会让 danmu.js 因冲突丢掉后来那条。
    const first = videoDanmakuEntries([item], 1);
    const second = videoDanmakuEntries([item], 2);
    expect(first[0]!.id).not.toBe(second[0]!.id);
  });

  test("merges segments back into one ordered timeline", () => {
    const early = videoDanmakuEntries(
      [{ progress: 10, mode: 1, fontsize: 25, color: 16_777_215, content: "a", weight: 5, pool: 0 }],
      1,
    );
    const late = videoDanmakuEntries(
      [{ progress: 5, mode: 1, fontsize: 25, color: 16_777_215, content: "b", weight: 5, pool: 0 }],
      2,
    );
    expect(mergeVideoDanmakuEntries([early, late]).map((entry) => entry.content)).toEqual([
      "b",
      "a",
    ]);
  });
});

function entry(progressMs: number, overrides: Partial<{ weight: number; pool: number }> = {}) {
  return videoDanmakuEntries(
    [
      {
        progress: progressMs,
        mode: 1,
        fontsize: 25,
        color: 16_777_215,
        content: `d${progressMs}`,
        weight: overrides.weight ?? 5,
        pool: overrides.pool ?? 0,
      },
    ],
    1,
  )[0]!;
}

describe("VOD danmaku filtering", () => {
  test("applies the shared shield words", () => {
    const entries = [entry(100), entry(200)];
    const filtered = filterVideoDanmakuEntries(entries, {
      isShielded: (content) => content === "d100",
      minWeight: 0,
      showSubtitlePool: false,
    });
    expect(filtered.map((item) => item.content)).toEqual(["d200"]);
  });

  test("hides the subtitle and special pools unless asked", () => {
    const entries = [entry(100, { pool: 0 }), entry(200, { pool: 1 }), entry(300, { pool: 2 })];
    const options = { isShielded: () => false, minWeight: 0 };
    expect(
      filterVideoDanmakuEntries(entries, { ...options, showSubtitlePool: false }).map(
        (item) => item.content,
      ),
    ).toEqual(["d100"]);
    expect(
      filterVideoDanmakuEntries(entries, { ...options, showSubtitlePool: true }),
    ).toHaveLength(3);
  });

  test("treats a zero weight threshold as no level filtering", () => {
    const entries = [entry(100, { weight: 1 }), entry(200, { weight: 10 })];
    expect(
      filterVideoDanmakuEntries(entries, {
        isShielded: () => false,
        minWeight: 0,
        showSubtitlePool: false,
      }),
    ).toHaveLength(2);
    expect(
      filterVideoDanmakuEntries(entries, {
        isShielded: () => false,
        minWeight: 5,
        showSubtitlePool: false,
      }).map((item) => item.content),
    ).toEqual(["d200"]);
  });
});

describe("VOD danmaku scheduling", () => {
  const timeline = [entry(0), entry(1_000), entry(2_000), entry(3_000)];

  test("emits only the bullets whose time has arrived", () => {
    const first = nextVideoDanmakuBatch(timeline, 0, 1_000);
    expect(first.batch.map((item) => item.progressMs)).toEqual([0, 1_000]);
    const second = nextVideoDanmakuBatch(timeline, first.cursor, 2_000);
    expect(second.batch.map((item) => item.progressMs)).toEqual([2_000]);
  });

  test("never replays a bullet the cursor already passed", () => {
    const first = nextVideoDanmakuBatch(timeline, 0, 3_000);
    expect(first.batch).toHaveLength(4);
    const again = nextVideoDanmakuBatch(timeline, first.cursor, 3_000);
    expect(again.batch).toHaveLength(0);
    expect(again.cursor).toBe(first.cursor);
  });

  test("drops rather than defers bullets over the per-tick budget", () => {
    // 补投会让密集段落成片迟到、与画面错位，所以超预算的直接跳过 ——
    // 游标仍然要推到该位置之后。
    const dense = Array.from({ length: 10 }, (_, index) => entry(index));
    const result = nextVideoDanmakuBatch(dense, 0, 1_000, 3);
    expect(result.batch).toHaveLength(3);
    expect(result.cursor).toBe(10);
  });

  test("realigns the cursor after a seek in either direction", () => {
    // 这正是 seek 的正确性所依赖的那一步：游标按新时间重新二分定位。
    expect(firstVideoDanmakuAtOrAfter(timeline, 0)).toBe(0);
    expect(firstVideoDanmakuAtOrAfter(timeline, 1_500)).toBe(2);
    expect(firstVideoDanmakuAtOrAfter(timeline, 9_999)).toBe(4);

    const forward = nextVideoDanmakuBatch(
      timeline,
      firstVideoDanmakuAtOrAfter(timeline, 2_000),
      2_000,
    );
    expect(forward.batch.map((item) => item.progressMs)).toEqual([2_000]);

    // 反向 seek 回到开头后应重新投放最早那几条，而不是接着旧游标继续。
    const backward = nextVideoDanmakuBatch(timeline, firstVideoDanmakuAtOrAfter(timeline, 0), 0);
    expect(backward.batch.map((item) => item.progressMs)).toEqual([0]);
  });
});
