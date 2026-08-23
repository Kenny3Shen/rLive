import { describe, expect, test } from "bun:test";
import type { DanmuJsBullet, DanmuJsInstance } from "danmu.js";
import type { DanmakuEvent } from "../src/shared/types/live";
import {
  DANMU_JS_ATTACH_TIMEOUT_MS,
  DANMU_JS_DEFAULT_DURATION_MS,
  DANMU_JS_DEFAULT_MOVE_V,
  DANMU_JS_FONT_WEIGHT,
  DANMU_JS_LANE_ACTIVE_COMMENTS,
  DANMU_JS_MAX_ACTIVE_COMMENTS,
  DANMU_JS_MAX_AGGREGATED_DISPLAY_COUNT,
  DANMU_JS_MIN_ACTIVE_COMMENTS,
  clampDanmuArea,
  clampDanmuFontStroke,
  danmuAreaConfig,
  danmuCommentFromEvent,
  danmuGhostRecordIds,
  danmuLayerAreaConfig,
  danmuLaneHeight,
  danmuMaxActiveComments,
  danmuMoveVPlayRate,
  danmuRenderLayer,
  danmuReservesLeadingCountSpacer,
  enqueueDanmuJsPending,
  flushDanmuJsPending,
  isPinnedDanmakuEvent,
  safeDanmuColor,
  updateDanmuAggregation,
  updateDanmuAppearance,
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
    fontStroke: 1.5,
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
      fontWeight: DANMU_JS_FONT_WEIGHT,
      WebkitTextStroke: "1.5px rgba(0,0,0,.92)",
      paintOrder: "stroke fill",
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
    expect(comment?.style?.color).toBe("#2A60B2");
    expect(comment?.style?.padding).toBeUndefined();
    expect(comment?.style?.borderRadius).toBeUndefined();
    expect(comment?.style?.backgroundColor).toBeUndefined();
    expect(comment?.style?.border).toBeUndefined();
    expect(comment?.style?.boxShadow).toBeUndefined();
  });

  test("maps each SC amount tier to its fixed font color", () => {
    const tiers = [
      { price: 30, color: "#2A60B2" },
      { price: 50, color: "#427D9E" },
      { price: 100, color: "#E2B52B" },
      { price: 500, color: "#E09443" },
      { price: 1_000, color: "#E54D4D" },
      { price: 2_000, color: "#B81830" },
    ] as const;

    for (const { price, color } of tiers) {
      const comment = danmuCommentFromEvent(
        chat({
          kind: "super_chat",
          content: "支持",
          super_chat: {
            price,
            background_color: "#ffffff",
            background_bottom_color: "#000000",
          },
        }),
        mappingOptions({ id: `sc-tier-${price}` }),
      );

      expect(comment?.style?.color).toBe(color);
      expect(comment?.style?.border).toBeUndefined();
    }
  });

  test("uses SC tier thresholds and falls back to platform colors without a valid tier", () => {
    const colorFor = (price: number | null | undefined) =>
      danmuCommentFromEvent(
        chat({
          kind: "super_chat",
          content: "支持",
          super_chat: {
            price,
            background_color: "#abcdef",
            background_bottom_color: "#123456",
          },
        }),
        mappingOptions({ id: `sc-boundary-${price}` }),
      )?.style?.color;

    expect(colorFor(49.99)).toBe("#2A60B2");
    expect(colorFor(99.99)).toBe("#427D9E");
    expect(colorFor(499.99)).toBe("#E2B52B");
    expect(colorFor(999.99)).toBe("#E09443");
    expect(colorFor(1_999.99)).toBe("#E54D4D");
    expect(colorFor(10_000)).toBe("#B81830");
    expect(colorFor(29.99)).toBe("#123456");
    expect(colorFor(null)).toBe("#123456");
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
  test("uses Bilibili live's default bold font weight", () => {
    expect(DANMU_JS_FONT_WEIGHT).toBe(700);
  });

  test("normalizes font outlines to configurable half-pixel steps", () => {
    expect(clampDanmuFontStroke(-1)).toBe(0);
    expect(clampDanmuFontStroke(0)).toBe(0);
    expect(clampDanmuFontStroke(1.24)).toBe(1);
    expect(clampDanmuFontStroke(1.26)).toBe(1.5);
    expect(clampDanmuFontStroke(3)).toBe(1.5);
    expect(clampDanmuFontStroke(Number.NaN)).toBe(0);
  });

  test("omits and removes CSS outline properties when outlines are disabled", () => {
    const comment = danmuCommentFromEvent(chat(), mappingOptions());
    expect(comment).not.toBeNull();

    const removed: string[] = [];
    comment!.__rliveMeta.element = {
      style: {
        fontSize: "",
        fontWeight: "",
        opacity: "",
        setProperty: () => {},
        removeProperty: (property: string) => {
          removed.push(property);
          return "";
        },
      },
    } as unknown as HTMLElement;

    updateDanmuAppearance(comment!, { fontSize: 18, fontStroke: 0, opacity: 0.8 });

    expect(comment?.style?.WebkitTextStroke).toBeUndefined();
    expect(comment?.style?.paintOrder).toBeUndefined();
    expect(removed).toEqual(["-webkit-text-stroke", "paint-order"]);
  });

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

  test("balances the counter slot only on the centered fixed bullets", () => {
    const key = "self 你好";

    // A fixed bullet is centered on its full width, so the trailing counter slot
    // must be mirrored by a leading spacer to keep the text on center.
    expect(danmuReservesLeadingCountSpacer(chat({ is_self: true }), key)).toBe(true);
    // Scrolling bullets are anchored on their left edge: a spacer would only
    // indent them.
    expect(danmuReservesLeadingCountSpacer(chat(), key)).toBe(false);
    // No counter slot, nothing to balance.
    expect(danmuReservesLeadingCountSpacer(chat({ is_self: true }), undefined)).toBe(false);
    // SC is fixed too, but never carries an aggregation key.
    expect(danmuReservesLeadingCountSpacer(chat({ kind: "super_chat" }), undefined)).toBe(false);
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

describe("danmu.js active budget under heavy traffic", () => {
  test("scales the budget with the lanes the stage really offers", () => {
    const laneHeight = danmuLaneHeight(18);
    expect(laneHeight).toBe(25);

    // 1080p stage, quarter area: floor(270 / 25) = 10 lanes.
    expect(danmuMaxActiveComments(1080, laneHeight, 0.25)).toBe(
      Math.max(DANMU_JS_MIN_ACTIVE_COMMENTS, 10 * DANMU_JS_LANE_ACTIVE_COMMENTS),
    );
    // Same stage with the full area keeps far more bullets in flight than the
    // old fixed cap of 80 allowed, which is what used to cut them off midway.
    expect(danmuMaxActiveComments(1080, laneHeight, 1)).toBe(43 * DANMU_JS_LANE_ACTIVE_COMMENTS);
    expect(danmuMaxActiveComments(1080, laneHeight, 1)).toBeGreaterThan(80);

    // Tiny stages still get a workable floor, and the ceiling stays bounded.
    expect(danmuMaxActiveComments(120, laneHeight, 0.25)).toBe(DANMU_JS_MIN_ACTIVE_COMMENTS);
    expect(danmuMaxActiveComments(Number.NaN, laneHeight, 0.25)).toBe(
      DANMU_JS_MIN_ACTIVE_COMMENTS,
    );
    expect(danmuMaxActiveComments(20_000, laneHeight, 1)).toBe(DANMU_JS_MAX_ACTIVE_COMMENTS);
    expect(danmuMaxActiveComments(1080, Number.NaN, 1)).toBeGreaterThan(
      DANMU_JS_MIN_ACTIVE_COMMENTS,
    );
  });

  test("reclaims only records danmu.js never attached", () => {
    const records = new Map([
      ["scrolling", { sentAt: 0, attached: true }],
      ["dropped", { sentAt: 0, attached: false }],
      ["just-sent", { sentAt: 900, attached: false }],
    ]);
    const order = ["scrolling", "dropped", "just-sent", "unknown"];

    expect(danmuGhostRecordIds(order, records, 1_500)).toEqual(["dropped"]);
    expect(danmuGhostRecordIds(order, records, DANMU_JS_ATTACH_TIMEOUT_MS)).toEqual([]);
    expect(danmuGhostRecordIds(order, records, 2_500)).toEqual(["dropped", "just-sent"]);
    expect(danmuGhostRecordIds(order, records, 1_500, Number.NaN)).toEqual(["dropped"]);
  });

  test("keeps fixed comments outside the scrolling budget", () => {
    expect(isPinnedDanmakuEvent(chat())).toBe(false);
    expect(isPinnedDanmakuEvent(chat({ is_self: true }))).toBe(true);
    expect(isPinnedDanmakuEvent(chat({ kind: "super_chat" }))).toBe(true);
  });
});
