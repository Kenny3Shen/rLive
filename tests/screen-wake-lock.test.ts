import { describe, expect, test } from "bun:test";
import { canUseScreenWakeLock } from "../src/shared/hooks/useScreenWakeLock";

describe("screen wake lock capability", () => {
  test("only enables the optional playback feature when the WebView exposes request()", () => {
    expect(canUseScreenWakeLock(undefined)).toBe(false);
    expect(canUseScreenWakeLock({} as Pick<Navigator, "wakeLock">)).toBe(false);
    expect(
      canUseScreenWakeLock({
        wakeLock: { request: () => Promise.reject(new Error("not called by this test")) },
      } as Pick<Navigator, "wakeLock">),
    ).toBe(true);
  });
});
