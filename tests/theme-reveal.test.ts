import { afterEach, describe, expect, test } from "bun:test";
import { themeRevealGeometry } from "../src/app/theme";

function numeric(value: string, unit: string): number {
  expect(value.endsWith(unit)).toBe(true);
  return Number.parseFloat(value);
}

describe("theme reveal viewport geometry", () => {
  test("uses viewport units and clamps an origin to the viewport", () => {
    expect(themeRevealGeometry({ x: -20, y: 2_000 }, { width: 400, height: 800 })).toMatchObject({
      x: "0.000vw",
      y: "100.000vh",
    });
  });

  test("covers the farthest corner without a long off-screen tail", () => {
    const width = 411;
    const height = 893;
    const origins = [
      { x: 0, y: 0 },
      { x: width, y: height },
      { x: width / 2, y: height / 2 },
      { x: 348, y: 359 },
    ];

    for (const origin of origins) {
      const geometry = themeRevealGeometry(origin, { width, height });
      const resolvedRadius = (numeric(geometry.radius, "vmax") / 100) * Math.max(width, height);
      const neededRadius = Math.hypot(
        Math.max(origin.x, width - origin.x),
        Math.max(origin.y, height - origin.y),
      );
      expect(resolvedRadius).toBeGreaterThan(neededRadius);
      expect(resolvedRadius).toBeLessThan(neededRadius + Math.max(width, height) * 0.02);
    }
  });
});

const properties = new Map<string, string>();
const dataset: Record<string, string | undefined> = {};
let resolveReady: (() => void) | undefined;
let resolveFinished: (() => void) | undefined;

function installThemeTransitionDom(reducedMotion = false) {
  properties.clear();
  for (const key of Object.keys(dataset)) delete dataset[key];

  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  const root = {
    classList: { toggle: () => {} },
    dataset,
    style: {
      setProperty(name: string, value: string) {
        properties.set(name, value);
      },
      removeProperty(name: string) {
        properties.delete(name);
      },
    },
  };

  (globalThis as Record<string, unknown>).window = {
    innerWidth: 411,
    innerHeight: 893,
    matchMedia: (query: string) => ({
      matches: query.includes("prefers-reduced-motion") ? reducedMotion : true,
    }),
  };
  (globalThis as Record<string, unknown>).document = {
    documentElement: root,
    startViewTransition: (update: () => void) => {
      update();
      return { ready, finished, skipTransition() {} };
    },
  };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).document;
});

async function loadRevealThemeAt() {
  const module = await import(`../src/app/theme?test=${Math.random()}`);
  return module.revealThemeAt as (
    origin: { x: number; y: number },
    update: () => void,
  ) => { finished: Promise<void> };
}

describe("theme reveal lifecycle", () => {
  test("keeps viewport geometry until the transition finishes", async () => {
    installThemeTransitionDom();
    const revealThemeAt = await loadRevealThemeAt();
    let updated = false;
    const transition = revealThemeAt({ x: 348, y: 359 }, () => {
      updated = true;
    });

    expect(updated).toBe(true);
    expect(properties.get("--theme-reveal-x")).toEndWith("vw");
    expect(properties.get("--theme-reveal-y")).toEndWith("vh");
    expect(properties.get("--theme-reveal-radius")).toEndWith("vmax");
    expect(dataset.themeReveal).toBe("true");

    resolveReady?.();
    resolveFinished?.();
    await transition.finished;
    expect(dataset.themeReveal).toBeUndefined();
    expect(properties.size).toBe(0);
  });

  test("updates immediately when reduced motion is requested", async () => {
    installThemeTransitionDom(true);
    const revealThemeAt = await loadRevealThemeAt();
    let updated = false;
    const transition = revealThemeAt({ x: 10, y: 10 }, () => {
      updated = true;
    });

    await transition.finished;
    expect(updated).toBe(true);
    expect(properties.size).toBe(0);
    expect(dataset.themeReveal).toBeUndefined();
  });
});
