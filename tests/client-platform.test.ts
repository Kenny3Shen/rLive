import { describe, expect, test } from "bun:test";
import { getClientPlatform, isMobileClient, isWindowsDesktop } from "../src/shared/clientPlatform";

describe("client platform detection", () => {
  test("identifies Android from Client Hints or the current Android WebView user agent", () => {
    expect(
      getClientPlatform({
        userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9)",
        maxTouchPoints: 5,
      }),
    ).toBe("android");
    expect(
      getClientPlatform({
        userAgent: "Mozilla/5.0 (Linux; armv8l)",
        maxTouchPoints: 5,
        userAgentData: { platform: "Android", mobile: true },
      }),
    ).toBe("android");
  });

  test("recognizes iPads that use the desktop Macintosh user agent", () => {
    const ipadDesktopUserAgent = {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
      maxTouchPoints: 5,
    };

    expect(getClientPlatform(ipadDesktopUserAgent)).toBe("ios");
    expect(isMobileClient(ipadDesktopUserAgent)).toBe(true);
  });

  test("keeps ordinary desktop browsers on the desktop shell", () => {
    const desktop = {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      maxTouchPoints: 0,
    };

    expect(getClientPlatform(desktop)).toBe("desktop");
    expect(isMobileClient(desktop)).toBe(false);
    expect(isWindowsDesktop(desktop)).toBe(true);
    expect(
      isWindowsDesktop({
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
        maxTouchPoints: 0,
      }),
    ).toBe(false);
  });
});
