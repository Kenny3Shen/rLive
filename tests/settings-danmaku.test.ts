import { describe, expect, test } from "bun:test";
import {
  DANMAKU_BLOCKED_USERS_MAX,
  DANMAKU_COLLISION_MODE_DEFAULT,
  DANMAKU_MERGE_WINDOW_SECONDS_DEFAULT,
  DANMAKU_MERGE_WINDOW_SECONDS_MAX,
  DANMAKU_MERGE_WINDOW_SECONDS_MIN,
  DANMAKU_SHIELD_ENTRY_MAX_LENGTH,
  normalizeDanmakuBlockedUsers,
  parseDanmakuCollisionMode,
  parseDanmakuMergeWindowSeconds,
} from "../src/shared/stores/settingsStore";
describe("danmaku collision mode settings", () => {
  test("keeps every supported algorithm", () => {
    expect(parseDanmakuCollisionMode("strict")).toBe("strict");
    expect(parseDanmakuCollisionMode("adaptive")).toBe("adaptive");
    expect(parseDanmakuCollisionMode("none")).toBe("none");
  });
  test("falls back to strict instead of an algorithm that stacks danmaku", () => {
    // 未知取值（旧记录、手改配置包、上游新增档位）必须退回严格检测：
    // 静默落到 `adaptive` 或 `none` 会让饱和时的弹幕互相压字，属于可见退化。
    expect(DANMAKU_COLLISION_MODE_DEFAULT).toBe("strict");
    for (const value of [undefined, null, "", "ADAPTIVE", "unknown", 1, {}]) {
      expect(parseDanmakuCollisionMode(value)).toBe(DANMAKU_COLLISION_MODE_DEFAULT);
    }
  });
});
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
    const users = Array.from(
      {
        length: DANMAKU_BLOCKED_USERS_MAX + 2,
      },
      (_, i) => `用户${i}`,
    );
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
});
