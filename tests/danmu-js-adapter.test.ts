import { describe, expect, test } from "bun:test";
import type { DanmakuEvent } from "../src/shared/types/live";
import {
  DANMU_JS_DEFAULT_DURATION_MS,
  DANMU_JS_MAX_AGGREGATED_DISPLAY_COUNT,
  danmuBandLayout,
  danmuCommentFromEvent,
  safeDanmuColor,
  updateDanmuAggregation,
} from "../src/features/room/danmaku/danmuJsAdapter";
import { resolveDanmuJsConstructor } from "../src/features/room/danmaku/danmuJsLoader";

function chat(overrides: Partial<DanmakuEvent> = {}): DanmakuEvent {
  return {
    kind: "chat",
    user: "观众",
    content: "你好",
    color: null,
    ts: 1_700_000_000_000,
    ...overrides,
  };
}

function mappingOptions(overrides: Record<string, unknown> = {}) {
  return {
    id: "bullet-1",
    fontSize: 18,
    fontWeight: 600,
    opacity: 0.8,
    ...overrides,
  };
}

describe("danmu.js loader interop", () => {
  test("resolves every UMD/CJS shape produced by bundler interop", () => {
    class NamedConstructor {}
    class DefaultConstructor {}
    class NestedNamedConstructor {}
    class NestedDefaultConstructor {}

    expect(resolveDanmuJsConstructor({ DanmuJs: NamedConstructor })).toBe(NamedConstructor);
    expect(resolveDanmuJsConstructor({ default: DefaultConstructor })).toBe(DefaultConstructor);
    expect(
      resolveDanmuJsConstructor({ default: { DanmuJs: NestedNamedConstructor } }),
    ).toBe(NestedNamedConstructor);
    expect(
      resolveDanmuJsConstructor({ default: { default: NestedDefaultConstructor } }),
    ).toBe(NestedDefaultConstructor);
  });

  test("rejects missing or non-callable exports", () => {
    expect(resolveDanmuJsConstructor(null)).toBeNull();
    expect(resolveDanmuJsConstructor({})).toBeNull();
    expect(resolveDanmuJsConstructor({ default: { DanmuJs: "not-a-constructor" } })).toBeNull();
  });
});

describe("danmu.js event mapping", () => {
  test("maps live chat to a fixed 15-second scrolling comment", () => {
    const comment = danmuCommentFromEvent(chat(), mappingOptions());

    expect(comment).not.toBeNull();
    expect(comment?.duration).toBe(DANMU_JS_DEFAULT_DURATION_MS);
    expect(comment?.duration).toBe(15_000);
    expect(comment?.mode).toBe("scroll");
    expect(comment?.realTime).toBe(true);
    expect(comment?.txt).toBe("你好");
    expect(Object.hasOwn(comment ?? {}, "start")).toBe(false);
    expect(Object.hasOwn(comment ?? {}, "moveV")).toBe(false);
  });

  test("maps SC to a bottom comment using the platform duration and one marker", () => {
    const comment = danmuCommentFromEvent(
      chat({
        kind: "super_chat",
        content: "加油",
        color: "#ffdc73",
        super_chat: { id: "sc-1", duration: 60 },
      }),
      mappingOptions({ id: "sc-bullet-1" }),
    );

    expect(comment).not.toBeNull();
    expect(comment?.duration).toBe(60_000);
    expect(comment?.mode).toBe("bottom");
    expect(comment?.realTime).toBe(true);
    expect(comment?.prior).toBe(true);
    expect(comment?.txt).toBe("【SC】加油");
    expect(comment?.__rliveMeta.baseText).toBe("【SC】加油");
  });

  test("returns no comment for blank content", () => {
    expect(danmuCommentFromEvent(chat({ content: "   " }), mappingOptions())).toBeNull();
  });
});

describe("danmu.js appearance helpers", () => {
  test("accepts compact CSS colors and rejects injectable values", () => {
    expect(safeDanmuColor("#Aa00ff")).toBe("#Aa00ff");
    expect(safeDanmuColor(" rgba(12, 34, 56, .7) ")).toBe("rgba(12, 34, 56, .7)");
    expect(safeDanmuColor("Gold")).toBe("gold");
    expect(safeDanmuColor("red; background: url(https://example.test/x)")).toBe("#ffffff");
    expect(safeDanmuColor(null, "transparent")).toBe("transparent");
  });

  test("combines area and line-count limits into one bounded DOM band", () => {
    expect(danmuBandLayout(221, 14, 0.25, 0)).toEqual({
      height: 52,
      laneHeight: 20,
      laneCount: 2,
    });
    expect(danmuBandLayout(720, 18, 0.25, 0)).toEqual({
      height: 190,
      laneHeight: 25,
      laneCount: 7,
    });
    expect(danmuBandLayout(720, 18, 0.25, 2)).toEqual({
      height: 65,
      laneHeight: 25,
      laneCount: 2,
    });
    expect(danmuBandLayout(0, 18, 1, 0)).toEqual({
      height: 0,
      laneHeight: 0,
      laneCount: 0,
    });
  });
});

describe("danmu.js repeat aggregation", () => {
  test("updates the existing comment text without emitting another comment", () => {
    const comment = danmuCommentFromEvent(
      chat(),
      mappingOptions({ aggregationKey: "other\u0000你好", aggregationCount: 1 }),
    );
    expect(comment).not.toBeNull();

    updateDanmuAggregation(comment!, 3);
    expect(comment?.txt).toBe("你好 ×3");
    expect(comment?.__rliveMeta.aggregationCount).toBe(3);

    updateDanmuAggregation(comment!, DANMU_JS_MAX_AGGREGATED_DISPLAY_COUNT + 10);
    expect(comment?.txt).toBe(`你好 ×${DANMU_JS_MAX_AGGREGATED_DISPLAY_COUNT}+`);
    expect(comment?.__rliveMeta.aggregationCount).toBe(
      DANMU_JS_MAX_AGGREGATED_DISPLAY_COUNT + 10,
    );
  });
});
