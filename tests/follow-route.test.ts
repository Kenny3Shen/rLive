import { describe, expect, test } from "bun:test";
import {
  FOLLOW_PLATFORM_PARAM,
  followPlatformFromSearch,
  formatFollowLiveDuration,
  withFollowPlatform,
} from "../frontend/features/follow/followRoute";

describe("follow platform route state", () => {
  test("accepts only supported platforms and falls back to all platforms", () => {
    expect(followPlatformFromSearch("bilibili")).toBe("bilibili");
    expect(followPlatformFromSearch("douyin")).toBe("douyin");
    expect(followPlatformFromSearch("douyin", ["douyin"])).toBe("all");
    expect(followPlatformFromSearch("unknown")).toBe("all");
    expect(followPlatformFromSearch(null)).toBe("all");
  });

  test("updates only the platform query parameter", () => {
    const current = new URLSearchParams("tag=gaming&platform=huya");
    const bilibili = withFollowPlatform(current, "bilibili");

    expect(bilibili.toString()).toBe("tag=gaming&platform=bilibili");
    expect(withFollowPlatform(bilibili, "all").toString()).toBe("tag=gaming");
    expect(current.get(FOLLOW_PLATFORM_PARAM)).toBe("huya");
  });

  test("formats known live-session durations without inventing unknown values", () => {
    const now = 1_704_067_200_000;

    expect(formatFollowLiveDuration(null, now)).toBeNull();
    expect(formatFollowLiveDuration(now + 1, now)).toBeNull();
    expect(formatFollowLiveDuration(now - 59_000, now)).toBe("刚刚开播");
    expect(formatFollowLiveDuration(now - 65 * 60_000, now)).toBe("1 小时 5 分钟");
    expect(formatFollowLiveDuration(now - 26 * 60 * 60_000, now)).toBe("1 天 2 小时");
  });
});
