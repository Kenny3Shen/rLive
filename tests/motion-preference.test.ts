import { describe, expect, test } from "bun:test";
import { isMotionMode, resolveMotionMode } from "../src/shared/motion/preference";

describe("motion preference", () => {
  test("system mode follows the operating system", () => {
    expect(resolveMotionMode("system", false)).toBe("full");
    expect(resolveMotionMode("system", true)).toBe("reduced");
  });

  test("explicit modes override the operating system", () => {
    expect(resolveMotionMode("full", true)).toBe("full");
    expect(resolveMotionMode("reduced", false)).toBe("reduced");
  });

  test("accepts only persisted motion modes", () => {
    expect(isMotionMode("system")).toBe(true);
    expect(isMotionMode("full")).toBe(true);
    expect(isMotionMode("reduced")).toBe(true);
    expect(isMotionMode("none")).toBe(false);
  });
});
