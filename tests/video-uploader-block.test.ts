import { describe, expect, test } from "bun:test";
import {
  filterBlockedUploaders,
  isBlockedUploader,
  videoBlockedUploaderSet,
} from "../src/features/video/videoUploaderBlock";
import { createShortsFeedMerger, SHORTS_PREFETCH_REMAINING, shortsShouldFetchMore } from "../src/features/shorts/shortsFeed";
import type { VideoItem } from "../src/shared/types/video";
import {
  VIDEO_BLOCKED_UPLOADERS_MAX,
  normalizeVideoBlockedUploaders,
  useSettingsStore,
} from "../src/shared/stores/settingsStore";

function item(overrides: Partial<VideoItem> = {}): VideoItem {
  return {
    bvid: "BV1x",
    aid: "1",
    cid: 2,
    title: "标题",
    cover: "",
    author: "UP 主",
    author_mid: "42",
    author_face: null,
    duration: 60,
    view: 1,
    danmaku: 1,
    reply: null,
    pubdate: 0,
    rcmd_reason: null,
    ...overrides,
  };
}

describe("UP 主屏蔽名单的规整", () => {
  test("去空白、去空项、去重并保持顺序", () => {
    expect(normalizeVideoBlockedUploaders([" 42 ", "", "42", "7", "  "])).toEqual(["42", "7"]);
    // UID 是数字标识，大小写无关，但仍按原样保留（不转小写、不转数字）。
    expect(normalizeVideoBlockedUploaders(["007", "7"])).toEqual(["007", "7"]);
    expect(normalizeVideoBlockedUploaders([undefined as unknown as string, 7 as unknown as string]))
      .toEqual([]);
  });

  test("超出容量上限时淘汰最早的条目", () => {
    const mids = Array.from({ length: VIDEO_BLOCKED_UPLOADERS_MAX + 2 }, (_, i) => `u${i}`);
    const normalized = normalizeVideoBlockedUploaders(mids);
    expect(normalized.length).toBe(VIDEO_BLOCKED_UPLOADERS_MAX);
    expect(normalized[0]).toBe("u2");
    expect(normalized.at(-1)).toBe(`u${VIDEO_BLOCKED_UPLOADERS_MAX + 1}`);
  });

  test("空名单产出 null，过滤因此整条跳过", () => {
    expect(videoBlockedUploaderSet([])).toBeNull();
    expect(videoBlockedUploaderSet(["", "  "])).toBeNull();
    expect(videoBlockedUploaderSet(["42"])).toEqual(new Set(["42"]));
  });
});

describe("按 UID 过滤稿件", () => {
  const blocked = videoBlockedUploaderSet(["42", "7"]);

  test("命中 UID 的条目被摘掉，其余保持顺序", () => {
    const items = [
      item({ bvid: "BV1", author_mid: "42" }),
      item({ bvid: "BV2", author_mid: "8" }),
      item({ bvid: "BV3", author_mid: "7" }),
    ];
    expect(filterBlockedUploaders(items, blocked).map((entry) => entry.bvid)).toEqual(["BV2"]);
  });

  test("缺失 UID 一律不屏蔽：宁可少屏蔽，不可错屏蔽", () => {
    expect(isBlockedUploader({ author_mid: null }, blocked)).toBe(false);
    expect(isBlockedUploader({ author_mid: undefined }, blocked)).toBe(false);
    expect(isBlockedUploader({ author_mid: "" }, blocked)).toBe(false);
    expect(isBlockedUploader({ author_mid: "  " }, blocked)).toBe(false);
    // 老缓存里作者名可能对得上，但名字不是身份。
    expect(filterBlockedUploaders([item({ author: "42", author_mid: null })], blocked).length).toBe(
      1,
    );
  });

  test("空名单原样返回同一数组（引用不变，下游记忆化不失效）", () => {
    const items = [item({ author_mid: "42" })];
    expect(filterBlockedUploaders(items, null)).toBe(items);
  });
});

describe("竖屏流在合并处过滤", () => {
  test("被屏蔽的条目不进视图数组，补货阈值因此仍然满足", () => {
    const merge = createShortsFeedMerger((entry) => entry.author_mid === "42");
    const pages = [
      {
        items: [
          item({ bvid: "BVblocked1", author_mid: "42" }),
          item({ bvid: "BVok1", author_mid: "8" }),
        ],
      },
      {
        items: [
          item({ bvid: "BVblocked2", author_mid: "42" }),
          item({ bvid: "BVok2", author_mid: "9" }),
        ],
      },
    ];
    const merged = merge(pages);
    expect(merged.map((entry) => entry.bvid)).toEqual(["BVok1", "BVok2"]);
    // 下标落在最后一条上：若被屏蔽的条目留在数组里占位，这里会算出「还有余量」而不补货。
    const last = merged.length - 1;
    expect(shortsShouldFetchMore(last, merged.length, true, false)).toBe(true);
    expect(SHORTS_PREFETCH_REMAINING).toBeGreaterThanOrEqual(0);
  });

  test("去掉判定后同一批条目回到流里", () => {
    const pages = [{ items: [item({ bvid: "BV1", author_mid: "42" })] }];
    expect(createShortsFeedMerger((entry) => entry.author_mid === "42")(pages)).toEqual([]);
    expect(createShortsFeedMerger()(pages).map((entry) => entry.bvid)).toEqual(["BV1"]);
  });

  test("去重仍在过滤之前生效：同一 bvid 不会被屏蔽条目挤掉", () => {
    // 被屏蔽的 bvid 与正常条目不同，因此这里验证的是去重集合与过滤互不干扰。
    const merge = createShortsFeedMerger((entry) => entry.author_mid === "42");
    const merged = merge([
      { items: [item({ bvid: "BV1", author_mid: "42" }), item({ bvid: "BV2", author_mid: "8" })] },
    ]);
    expect(merged.map((entry) => entry.bvid)).toEqual(["BV2"]);
  });
});

describe("屏蔽名单的 store 动作", () => {
  test("blockVideoUploader 去空白、去重并写入持久化补丁", () => {
    const base = useSettingsStore.getState().videoBlockedUploaders;
    try {
      useSettingsStore.getState().blockVideoUploader("  12345  ");
      expect(useSettingsStore.getState().videoBlockedUploaders).toContain("12345");
      const after = useSettingsStore.getState().videoBlockedUploaders.length;
      // 重复屏蔽是无操作，不产生第二条。
      useSettingsStore.getState().blockVideoUploader("12345");
      expect(useSettingsStore.getState().videoBlockedUploaders.length).toBe(after);
      // 空值不写入。
      useSettingsStore.getState().blockVideoUploader("   ");
      expect(useSettingsStore.getState().videoBlockedUploaders.length).toBe(after);
    } finally {
      useSettingsStore.setState({ videoBlockedUploaders: base });
    }
  });
});
