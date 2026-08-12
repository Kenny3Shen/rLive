import { describe, expect, test } from "bun:test";
import { prefersReducedMotion, resolveMotionMode } from "../src/shared/motion/preference";

describe("motion preference", () => {
  test("legacy modes always resolve to the complete profile", () => {
    expect(resolveMotionMode("system", false)).toBe("full");
    expect(resolveMotionMode("system", true)).toBe("full");
    expect(resolveMotionMode("full", true)).toBe("full");
    expect(resolveMotionMode("reduced", true)).toBe("full");
    expect(resolveMotionMode("unexpected", true)).toBe("full");
  });

  test("runtime never reports reduced motion", () => {
    expect(prefersReducedMotion()).toBe(false);
  });
});
