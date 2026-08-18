import { describe, expect, test } from "bun:test";
import { prefersReducedMotion } from "../src/shared/motion/preference";

describe("motion preference", () => {
  test("defaults to full motion during SSR and honors the system preference in browsers", () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

    try {
      Reflect.deleteProperty(globalThis, "window");
      expect(prefersReducedMotion()).toBe(false);

      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
          matchMedia: (query: string) => ({
            matches: query === "(prefers-reduced-motion: reduce)",
          }),
        },
      });
      expect(prefersReducedMotion()).toBe(true);
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
});
