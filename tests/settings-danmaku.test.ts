import { describe, expect, test } from "bun:test";
import {
  DANMAKU_AREA_DEFAULT,
  DANMAKU_FONT_SIZE_DESKTOP_DEFAULT,
  DANMAKU_FONT_SIZE_MOBILE_DEFAULT,
  DANMAKU_OPACITY_DEFAULT,
  DANMAKU_MERGE_WINDOW_SECONDS_DEFAULT,
  DANMAKU_MERGE_WINDOW_SECONDS_MAX,
  DANMAKU_MERGE_WINDOW_SECONDS_MIN,
  parseDanmakuMergeWindowSeconds,
  SUPER_CHAT_OPACITY_DEFAULT,
  defaultDanmakuFontSize,
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

  test("falls back to ten seconds for invalid values", () => {
    expect(parseDanmakuMergeWindowSeconds(undefined)).toBe(DANMAKU_MERGE_WINDOW_SECONDS_DEFAULT);
    expect(parseDanmakuMergeWindowSeconds(null)).toBe(DANMAKU_MERGE_WINDOW_SECONDS_DEFAULT);
  });
});

describe("danmaku appearance defaults", () => {
  test("uses compact mobile text while keeping shared desktop defaults explicit", () => {
    expect(DANMAKU_FONT_SIZE_DESKTOP_DEFAULT).toBe(18);
    expect(DANMAKU_FONT_SIZE_MOBILE_DEFAULT).toBe(14);
    expect(defaultDanmakuFontSize(false)).toBe(18);
    expect(defaultDanmakuFontSize(true)).toBe(14);
  });

  test("uses 80 percent opacity and a 25 percent display area", () => {
    expect(DANMAKU_OPACITY_DEFAULT).toBe(0.8);
    expect(SUPER_CHAT_OPACITY_DEFAULT).toBe(0.8);
    expect(DANMAKU_AREA_DEFAULT).toBe(0.25);
  });
});
