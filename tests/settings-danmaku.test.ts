import { describe, expect, test } from "bun:test";
import {
  DANMAKU_AREA_DEFAULT,
  DANMAKU_BLOCKED_USERS_MAX,
  DANMAKU_FONT_SIZE_DESKTOP_DEFAULT,
  DANMAKU_FONT_SIZE_MOBILE_DEFAULT,
  DANMAKU_FONT_STROKE_DEFAULT,
  DANMAKU_FONT_STROKE_MAX,
  DANMAKU_FONT_STROKE_MIN,
  DANMAKU_MERGE_WINDOW_SECONDS_DEFAULT,
  DANMAKU_MERGE_WINDOW_SECONDS_MAX,
  DANMAKU_MERGE_WINDOW_SECONDS_MIN,
  DANMAKU_OPACITY_DEFAULT,
  DANMAKU_SHIELD_ENTRY_MAX_LENGTH,
  DANMAKU_SPEED_DEFAULT,
  DANMAKU_SPEED_MAX,
  DANMAKU_SPEED_MIN,
  defaultDanmakuFontSize,
  normalizeDanmakuBlockedUsers,
  parseDanmakuFontStroke,
  parseDanmakuMergeWindowSeconds,
  parseDanmakuSpeed,
  useSettingsStore,
} from "../src/shared/stores/settingsStore";

describe("danmaku merge window settings", () => {
  test("clamps values to the supported range", () => {
    expect(parseDanmakuMergeWindowSeconds(DANMAKU_MERGE_WINDOW_SECONDS_MIN - 1)).toBe(
      DANMAKU_MERGE_WINDOW_SECONDS_MIN,
    );
    expect(parseDanmakuMergeWindowSeconds(DANMAKU_MERGE_WINDOW_SECONDS_MAX + 1)).toBe(
      DANMAKU_MERGE_WINDOW_SECONDS_MAX,
    );
    expect(parseDanmakuMergeWindowSeconds(12.4)).toBe(12);
  });

  test("keeps zero as the explicit merge-off value", () => {
    expect(DANMAKU_MERGE_WINDOW_SECONDS_MIN).toBe(0);
    expect(parseDanmakuMergeWindowSeconds(0)).toBe(0);
  });

  test("falls back to ten seconds for invalid values", () => {
    expect(parseDanmakuMergeWindowSeconds(undefined)).toBe(DANMAKU_MERGE_WINDOW_SECONDS_DEFAULT);
    expect(parseDanmakuMergeWindowSeconds(null)).toBe(DANMAKU_MERGE_WINDOW_SECONDS_DEFAULT);
  });
});

describe("danmaku blocked users settings", () => {
  test("normalizes whitespace, empties, and duplicates while preserving order", () => {
    expect(normalizeDanmakuBlockedUsers(["  张三  ", "", "张三", "李四"])).toEqual([
      "张三",
      "李四",
    ]);
    // 昵称匹配是大小写敏感的精确比较，去重保持同一口径。
    expect(normalizeDanmakuBlockedUsers(["abc", "ABC"])).toEqual(["abc", "ABC"]);
    expect(normalizeDanmakuBlockedUsers(["  ", undefined as unknown as string])).toEqual([]);
  });

  test("evicts the oldest entries beyond the capacity limit", () => {
    const users = Array.from({ length: DANMAKU_BLOCKED_USERS_MAX + 2 }, (_, i) => `用户${i}`);
    const normalized = normalizeDanmakuBlockedUsers(users);
    expect(normalized).toHaveLength(DANMAKU_BLOCKED_USERS_MAX);
    expect(normalized[0]).toBe("用户2");
    expect(normalized.at(-1)).toBe(`用户${DANMAKU_BLOCKED_USERS_MAX + 1}`);
  });

  test("keeps platform-length nicknames so click-to-block never silently fails", () => {
    // 手输上限对齐平台单条弹幕长度，但点击屏蔽写入的是事件真实昵称：
    // 抖音 / Twitch 的昵称可能长于该上限，归一化不能把它们丢掉。
    const longName = "超".repeat(DANMAKU_SHIELD_ENTRY_MAX_LENGTH + 5);
    expect(normalizeDanmakuBlockedUsers([longName])).toEqual([longName]);
  });

  test("bounds hand-typed entries to the platform danmaku length", () => {
    // B 站单条弹幕 20 字、虎牙 30 字；屏蔽词按子串匹配，长过平台弹幕
    // 上限的条目永远不可能命中。
    expect(DANMAKU_SHIELD_ENTRY_MAX_LENGTH).toBe(30);
  });
});

describe("danmaku appearance defaults", () => {
  test("uses compact mobile text while keeping shared desktop defaults explicit", () => {
    expect(DANMAKU_FONT_SIZE_DESKTOP_DEFAULT).toBe(20);
    expect(DANMAKU_FONT_SIZE_MOBILE_DEFAULT).toBe(16);
    expect(defaultDanmakuFontSize(false)).toBe(20);
    expect(defaultDanmakuFontSize(true)).toBe(16);
  });

  test("uses 80 percent opacity and a 25 percent display area", () => {
    expect(DANMAKU_OPACITY_DEFAULT).toBe(0.8);
    expect(DANMAKU_AREA_DEFAULT).toBe(0.25);
  });

  test("disables outlines by default and normalizes optional strokes to half-pixel steps", () => {
    expect(DANMAKU_FONT_STROKE_MIN).toBe(0);
    expect(DANMAKU_FONT_STROKE_MAX).toBe(1.5);
    expect(DANMAKU_FONT_STROKE_DEFAULT).toBe(0);
    expect(parseDanmakuFontStroke(DANMAKU_FONT_STROKE_MIN - 1)).toBe(DANMAKU_FONT_STROKE_MIN);
    expect(parseDanmakuFontStroke(0)).toBe(0);
    expect(parseDanmakuFontStroke(1.24)).toBe(1);
    expect(parseDanmakuFontStroke(1.26)).toBe(1.5);
    expect(parseDanmakuFontStroke(DANMAKU_FONT_STROKE_MAX + 1)).toBe(DANMAKU_FONT_STROKE_MAX);
    expect(parseDanmakuFontStroke(undefined)).toBe(DANMAKU_FONT_STROKE_DEFAULT);
    expect(useSettingsStore.getState().danmakuFontStroke).toBe(DANMAKU_FONT_STROKE_DEFAULT);
  });

  test("uses a 100 px/s scrolling speed and clamps it to the supported range", () => {
    expect(DANMAKU_SPEED_DEFAULT).toBe(100);
    expect(parseDanmakuSpeed(DANMAKU_SPEED_MIN - 1)).toBe(DANMAKU_SPEED_MIN);
    expect(parseDanmakuSpeed(DANMAKU_SPEED_MAX + 1)).toBe(DANMAKU_SPEED_MAX);
    expect(parseDanmakuSpeed(135.6)).toBe(136);
    expect(parseDanmakuSpeed(undefined)).toBe(DANMAKU_SPEED_DEFAULT);
    expect(useSettingsStore.getState().danmakuSpeed).toBe(DANMAKU_SPEED_DEFAULT);
  });

  test("does not retain other removed danmaku preferences in frontend state", () => {
    const state = useSettingsStore.getState();
    expect("danmakuFontWeight" in state).toBe(false);
    expect("danmakuLineCount" in state).toBe(false);
    expect("superChatOpacity" in state).toBe(false);
    expect("setSuperChatOpacity" in state).toBe(false);
    expect("danmakuFilterRepeats" in state).toBe(false);
  });
});
