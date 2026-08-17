import { describe, expect, test } from "bun:test";
import type { DanmuJsBullet, DanmuJsInstance } from "danmu.js";
import type { DanmakuEvent } from "../src/shared/types/live";
import {
  DANMU_JS_DEFAULT_DURATION_MS,
  DANMU_JS_DEFAULT_MOVE_V,
  DANMU_JS_MAX_AGGREGATED_DISPLAY_COUNT,
  clampDanmuArea,
  danmuAreaConfig,
  danmuCommentFromEvent,
  danmuLayerAreaConfig,
  danmuLaneHeight,
  danmuMoveVPlayRate,
  danmuRenderLayer,
  enqueueDanmuJsPending,
  flushDanmuJsPending,
  safeDanmuColor,
  updateDanmuAggregation,
} from "../src/features/room/danmaku/danmuJsAdapter";
import { installDanmuJsFixedPriorCompat } from "../src/features/room/danmaku/danmuJsCompat";
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

    expect(resolveDanmuJsConstructor(NamedConstructor)).toBe(NamedConstructor);
    expect(resolveDanmuJsConstructor({ DanmuJs: NamedConstructor })).toBe(NamedConstructor);
    expect(resolveDanmuJsConstructor({ default: DefaultConstructor })).toBe(DefaultConstructor);
    expect(resolveDanmuJsConstructor({ default: { DanmuJs: NestedNamedConstructor } })).toBe(
      NestedNamedConstructor,
    );
    expect(resolveDanmuJsConstructor({ default: { default: NestedDefaultConstructor } })).toBe(
      NestedDefaultConstructor,
    );
  });

  test("rejects missing or non-callable exports", () => {
    expect(resolveDanmuJsConstructor(null)).toBeNull();
    expect(resolveDanmuJsConstructor({})).toBeNull();
    expect(resolveDanmuJsConstructor({ default: { DanmuJs: "not-a-constructor" } })).toBeNull();
  });

  test("falls back to the global left by a browser UMD script", () => {
    const globalRecord = globalThis as unknown as Record<string, unknown>;
    const previous = globalRecord.DanmuJs;
    class GlobalConstructor {}
    globalRecord.DanmuJs = GlobalConstructor;
    try {
      expect(resolveDanmuJsConstructor({})).toBe(GlobalConstructor);
    } finally {
      if (previous === undefined) delete globalRecord.DanmuJs;
      else globalRecord.DanmuJs = previous;
    }
  });
});

describe("danmu.js event mapping", () => {
  test("maps live chat to a scrolling comment moving at 100 pixels per second", () => {
    const comment = danmuCommentFromEvent(chat(), mappingOptions());

    expect(comment).not.toBeNull();
    expect(comment?.moveV).toBe(DANMU_JS_DEFAULT_MOVE_V);
    expect(comment?.moveV).toBe(100);
    expect(Object.hasOwn(comment ?? {}, "duration")).toBe(false);
    expect(comment?.mode).toBe("scroll");
    expect(danmuRenderLayer(comment!)).toBe("scroll");
    expect(comment?.realTime).toBe(true);
    expect(comment?.prior).toBe(false);
    expect(comment?.txt).toBe("你好");
    expect(Object.hasOwn(comment ?? {}, "start")).toBe(false);
    expect(comment?.style).toMatchObject({
      display: "inline-flex",
      alignItems: "center",
      flexWrap: "nowrap",
      whiteSpace: "nowrap",
      width: "max-content",
    });
  });

  test("pins a self-sent chat at the top without a self border", () => {
    const comment = danmuCommentFromEvent(
      chat({ is_self: true, color: "#00ffcc" }),
      mappingOptions({ id: "self-bullet" }),
    );

    expect(comment).not.toBeNull();
    expect(comment?.mode).toBe("top");
    expect(danmuRenderLayer(comment!)).toBe("top");
    expect(comment?.prior).toBe(true);
    expect(comment?.realTime).toBe(true);
    expect(comment?.duration).toBe(DANMU_JS_DEFAULT_DURATION_MS);
    expect(Object.hasOwn(comment ?? {}, "moveV")).toBe(false);
    expect(comment?.style?.border).toBeUndefined();
    expect(comment?.style?.padding).toBeUndefined();
  });

  test("maps SC to a top comment using the platform duration and one marker", () => {
    const comment = danmuCommentFromEvent(
      chat({
        kind: "super_chat",
        content: "加油",
        color: "#ffdc73",
        super_chat: {
          id: "sc-1",
          price: 30,
          duration: 60,
          background_color: "#edf5ff",
          background_bottom_color: "#2a60b2",
        },
      }),
      mappingOptions({ id: "sc-bullet-1" }),
    );

    expect(comment).not.toBeNull();
    expect(comment?.duration).toBe(60_000);
    expect(Object.hasOwn(comment ?? {}, "moveV")).toBe(false);
    expect(comment?.mode).toBe("top");
    expect(danmuRenderLayer(comment!)).toBe("top");
    expect(comment?.realTime).toBe(true);
    expect(comment?.prior).toBe(true);
    expect(comment?.txt).toBe("【SC】加油");
    expect(comment?.__rliveMeta.baseText).toBe("【SC】加油");
    expect(comment?.style?.color).toBe("#2a60b2");
    expect(comment?.style?.padding).toBeUndefined();
    expect(comment?.style?.borderRadius).toBeUndefined();
    expect(comment?.style?.backgroundColor).toBeUndefined();
    expect(comment?.style?.border).toBeUndefined();
    expect(comment?.style?.boxShadow).toBeUndefined();
  });

  test("uses each SC amount-tier color without an outer card", () => {
    const comment = danmuCommentFromEvent(
      chat({
        kind: "super_chat",
        content: "支持",
        super_chat: {
          price: 2_000,
          background_color: "#ffcccc",
          background_bottom_color: "#b81830",
        },
      }),
      mappingOptions({ id: "sc-high-tier" }),
    );

    expect(comment?.style?.color).toBe("#b81830");
    expect(comment?.style?.border).toBeUndefined();
  });

  test("keeps the SC marker when rich spans replace the text node", () => {
    const comment = danmuCommentFromEvent(
      chat({
        kind: "super_chat",
        content: "加油",
        super_chat: { id: "sc-rich", duration: 30 },
        spans: [{ type: "image", image_url: "https://i0.hdslb.com/bfs/emote/a.png" }],
      }),
      mappingOptions({ id: "sc-rich-bullet" }),
    );

    expect(comment?.__rliveMeta.spans?.[0]).toEqual({ type: "text", text: "【SC】" });
  });

  test("returns no comment for blank content", () => {
    expect(danmuCommentFromEvent(chat({ content: "   " }), mappingOptions())).toBeNull();
  });
});

describe("danmu.js 1.2.1 fixed-priority compatibility", () => {
  test("bypasses only the broken fixed-track guard and restores priority", () => {
    const prioritiesSeenByTrackSelection: Array<boolean | undefined> = [];
    const original = (bullet: DanmuJsBullet) => {
      prioritiesSeenByTrackSelection.push(bullet.prior as boolean | undefined);
      return { result: true };
    };
    const channel = { addBullet: original };
    const instance = { main: { channel } } as unknown as DanmuJsInstance;
    const restore = installDanmuJsFixedPriorCompat(instance);

    const top = {
      id: "self-top",
      mode: "top",
      prior: true,
      options: { realTime: true },
    } as DanmuJsBullet;
    const scroll = {
      id: "normal-scroll",
      mode: "scroll",
      prior: true,
      options: { realTime: true },
    } as DanmuJsBullet;

    expect(channel.addBullet(top)).toEqual({ result: true });
    expect(top.prior).toBe(true);
    expect(channel.addBullet(scroll)).toEqual({ result: true });
    expect(prioritiesSeenByTrackSelection).toEqual([false, true]);

    restore();
    expect(channel.addBullet).toBe(original);
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

  test("clamps the native danmu.js area to the supported range", () => {
    expect(clampDanmuArea(0.1)).toBe(0.1);
    expect(clampDanmuArea(0.25)).toBe(0.25);
    expect(clampDanmuArea(1)).toBe(1);
    expect(clampDanmuArea(0)).toBe(0.1);
    expect(clampDanmuArea(1.5)).toBe(1);
    expect(clampDanmuArea(Number.NaN)).toBe(0.25);
  });

  test("derives channel size from the clamped danmaku font size", () => {
    expect(danmuLaneHeight(14)).toBe(20);
    expect(danmuLaneHeight(18)).toBe(25);
    expect(danmuLaneHeight(48)).toBe(67);
    expect(danmuLaneHeight(Number.NaN)).toBe(25);
  });

  test("maps the configured pixel speed onto the native moveV play rate", () => {
    expect(danmuMoveVPlayRate(50)).toBe(0.5);
    expect(danmuMoveVPlayRate(100)).toBe(1);
    expect(danmuMoveVPlayRate(200)).toBe(2);
    expect(danmuMoveVPlayRate(Number.NaN)).toBe(1);
  });

  test("uses the native danmu.js area without a virtual line limit", () => {
    const areas = [0.1, 0.25, 0.5, 0.75, 1].map(danmuAreaConfig);

    expect(areas).toEqual([
      { start: 0, end: 0.1 },
      { start: 0, end: 0.25 },
      { start: 0, end: 0.5 },
      { start: 0, end: 0.75 },
      { start: 0, end: 1 },
    ]);
    expect(areas.every((area) => !Object.hasOwn(area, "lines"))).toBe(true);
    expect(danmuAreaConfig(Number.POSITIVE_INFINITY)).toEqual({ start: 0, end: 0.25 });
  });

  test("keeps top comments on a full-height layer regardless of scrolling area", () => {
    expect(danmuLayerAreaConfig("scroll", 0.25)).toEqual({ start: 0, end: 0.25 });
    expect([0.1, 0.25, 0.75, 1].map((area) => danmuLayerAreaConfig("top", area))).toEqual([
      { start: 0, end: 1 },
      { start: 0, end: 1 },
      { start: 0, end: 1 },
      { start: 0, end: 1 },
    ]);
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
    expect(comment?.__rliveMeta.aggregationCount).toBe(DANMU_JS_MAX_AGGREGATED_DISPLAY_COUNT + 10);
  });
});

describe("danmu.js bounded pending lifecycle", () => {
  test("retains the newest 80 messages and drops stale entries on flush", () => {
    const queue = [] as Parameters<typeof enqueueDanmuJsPending>[0];
    const events = Array.from({ length: 81 }, (_, index) => chat({ content: `消息 ${index}` }));

    enqueueDanmuJsPending(queue, events, 100);
    expect(queue).toHaveLength(80);
    expect(queue[0]?.event.content).toBe("消息 1");

    const fresh = flushDanmuJsPending(queue, 4_900, 5_000);
    expect(fresh).toHaveLength(80);
    expect(queue).toHaveLength(0);

    enqueueDanmuJsPending(queue, [chat({ content: "过期" })], 100);
    expect(flushDanmuJsPending(queue, 5_101, 5_000)).toEqual([]);

    enqueueDanmuJsPending(queue, events, 100, Number.NaN);
    expect(queue).toHaveLength(80);
  });
});
