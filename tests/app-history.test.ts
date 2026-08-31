import { describe, expect, test } from "bun:test";
import { canNavigateBackInApp } from "../src/shared/appHistory";

describe("in-app back navigation", () => {
  test("returns to the preceding in-app page and safely falls back for direct links", () => {
    expect(canNavigateBackInApp({ idx: 1 })).toBe(true);
    // 下标 0 就是本次会话的第一个应用内页面：再往回退会离开应用。
    expect(canNavigateBackInApp({ idx: 0 })).toBe(false);
    expect(canNavigateBackInApp({ idx: "1" })).toBe(false);
    expect(canNavigateBackInApp({})).toBe(false);
    expect(canNavigateBackInApp(null)).toBe(false);
    expect(canNavigateBackInApp(undefined)).toBe(false);
  });
});
