import { describe, expect, test } from "bun:test";
import type { DanmakuEvent } from "../src/shared/types/live";
import {
  DANMAKU_DEFAULT_DURATION_MS,
  DANMAKU_FONT_WEIGHT,
  DANMAKU_DEFAULT_SPEED,
  clampDanmuFontSize,
  clampDanmuFontStroke,
  danmakuCommentFromEvent,
  danmuLaneHeight,
  isPinnedDanmakuEvent,
  safeDanmuColor,
} from "../src/features/room/danmaku/danmakuAdapter";

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

describe("danmaku adapter mapping", () => {
  test("maps live chat to a scrolling comment", () => {
    const comment = danmakuCommentFromEvent(chat(), mappingOptions());
    expect(comment).not.toBeNull();
    expect(comment?.mode).toBe("scroll");
    expect(comment?.text).toBe("你好");
    expect(comment?.duration).toBeUndefined();
    expect(DANMAKU_DEFAULT_SPEED).toBe(100);
  });

  test("pins self-sent and SC at top", () => {
    expect(isPinnedDanmakuEvent(chat({ is_self: true }))).toBe(true);
    expect(isPinnedDanmakuEvent(chat({ kind: "super_chat", amount: 30 }))).toBe(true);
    expect(isPinnedDanmakuEvent(chat())).toBe(false);

    const selfComment = danmakuCommentFromEvent(chat({ is_self: true }), mappingOptions());
    expect(selfComment?.mode).toBe("top");
    expect(selfComment?.duration).toBe(DANMAKU_DEFAULT_DURATION_MS);
  });

  test("maps SC duration from amount tiers", () => {
    const sc = danmakuCommentFromEvent(
      chat({ kind: "super_chat", amount: 30, super_chat: { price: 30 } }),
      mappingOptions(),
    );
    expect(sc?.mode).toBe("top");
    expect(sc?.duration).toBeGreaterThan(0);
  });

  test("returns null for blank content", () => {
    expect(danmakuCommentFromEvent(chat({ content: "" }), mappingOptions())).toBeNull();
  });
});

describe("danmaku appearance", () => {
  test("uses bold font weight", () => {
    expect(DANMAKU_FONT_WEIGHT).toBe(700);
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
