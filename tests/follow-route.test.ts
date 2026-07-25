import { describe, expect, test } from "bun:test";
import {
  FOLLOW_PLATFORM_PARAM,
  followPlatformFromSearch,
  withFollowPlatform,
} from "../src/features/follow/followRoute";

describe("follow platform route state", () => {
  test("accepts only supported platforms and falls back to all platforms", () => {
    expect(followPlatformFromSearch("bilibili")).toBe("bilibili");
    expect(followPlatformFromSearch("douyin")).toBe("douyin");
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
});
