import { describe, expect, test } from "bun:test";
import type { DanmakuEvent } from "../src/shared/types/live";
import {
  DANMU_JS_DEFAULT_MOVE_V,
  DANMU_JS_FONT_WEIGHT,
  danmuCommentFromEvent,
  safeDanmuColor,
  clampDanmuFontStroke,
  danmuLaneHeight,
  clampDanmuFontSize,
  isPinnedDanmakuEvent,
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
    fontStroke: 1.5,
    opacity: 0.8,
    ...overrides,
  };
}

describe("danmu.js loader interop", () => {
  test("resolves UMD/CJS shapes", () => {
    class NamedConstructor {}
    class DefaultConstructor {}

    expect(resolveDanmuJsConstructor(NamedConstructor)).toBe(NamedConstructor);
    expect(resolveDanmuJsConstructor({ DanmuJs: NamedConstructor })).toBe(NamedConstructor);
    expect(resolveDanmuJsConstructor({ default: DefaultConstructor })).toBe(DefaultConstructor);
    expect(resolveDanmuJsConstructor(null)).toBeNull();
    expect(resolveDanmuJsConstructor({})).toBeNull();
  });
});

describe("danmu.js event mapping", () => {
  test("maps live chat to scrolling comment", () => {
    const comment = danmuCommentFromEvent(chat(), mappingOptions());
    expect(comment).not.toBeNull();
    expect(comment?.mode).toBe("scroll");
    expect(comment?.moveV).toBe(DANMU_JS_DEFAULT_MOVE_V);
  });

  test("pins self-sent and SC at top", () => {
    expect(isPinnedDanmakuEvent(chat({ is_self: true }))).toBe(true);
    expect(isPinnedDanmakuEvent(chat({ kind: "super_chat", amount: 30 }))).toBe(true);
    expect(isPinnedDanmakuEvent(chat())).toBe(false);

    const selfComment = danmuCommentFromEvent(
      chat({ is_self: true }),
      mappingOptions()
    );
    expect(selfComment?.mode).toBe("top");
    expect(selfComment?.prior).toBe(true);
  });

  test("maps SC duration from amount tiers", () => {
    const sc = danmuCommentFromEvent(
      chat({ kind: "super_chat", amount: 30, super_chat: { price: 30 } }),
      mappingOptions()
    );
    expect(sc?.mode).toBe("top");
    expect(sc?.duration).toBeGreaterThan(0);
  });

  test("returns null for blank content", () => {
    expect(danmuCommentFromEvent(chat({ content: "" }), mappingOptions())).toBeNull();
  });
});

describe("danmu.js appearance", () => {
  test("uses bold font weight", () => {
    expect(DANMU_JS_FONT_WEIGHT).toBe(700);
  });

  test("clamps font stroke to [0, 1.5] at half-pixel steps", () => {
    expect(clampDanmuFontStroke(1.3)).toBe(1.5);
    expect(clampDanmuFontStroke(2.7)).toBe(1.5);
    expect(clampDanmuFontStroke(0.7)).toBe(0.5);
    expect(clampDanmuFontStroke(0)).toBe(0);
  });

  test("validates CSS colors and falls back on invalid input", () => {
    expect(safeDanmuColor("#ff0000")).toBe("#ff0000");
    expect(safeDanmuColor("rgb(255,0,0)")).toBe("rgb(255,0,0)");
    expect(safeDanmuColor("red")).toBe("red");
    expect(safeDanmuColor("javascript:alert(1)")).toBe("#ffffff");
    expect(safeDanmuColor(null)).toBe("#ffffff");
  });

  test("derives lane height as fontSize × 1.4", () => {
    expect(danmuLaneHeight(18)).toBe(25);
    expect(danmuLaneHeight(24)).toBe(34);
  });

  test("clamps font size to [12, 48]", () => {
    expect(clampDanmuFontSize(8)).toBe(12);
    expect(clampDanmuFontSize(20)).toBe(20);
    expect(clampDanmuFontSize(60)).toBe(48);
  });
});
