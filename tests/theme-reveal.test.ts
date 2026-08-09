import { afterEach, describe, expect, test } from "bun:test";

type Stubs = {
  reducedMotion: boolean;
  coarsePointer: boolean;
  width: number;
  height: number;
  startViewTransition: boolean;
};

const properties = new Map<string, string>();
const dataset: Record<string, string | undefined> = {};
let resolveReady: (() => void) | undefined;
let resolveFinished: (() => void) | undefined;
let skipped = 0;

function install(overrides: Partial<Stubs> = {}) {
  const stubs: Stubs = {
    reducedMotion: false,
    coarsePointer: true,
    width: 411,
    height: 893,
    startViewTransition: true,
    ...overrides,
  };

  properties.clear();
  for (const key of Object.keys(dataset)) delete dataset[key];
  skipped = 0;

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

  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });

  (globalThis as Record<string, unknown>).window = {
    innerWidth: stubs.width,
    innerHeight: stubs.height,
    matchMedia: (query: string) => ({
      matches: query.includes("prefers-reduced-motion")
        ? stubs.reducedMotion
        : query.includes("pointer: coarse")
          ? stubs.coarsePointer
          : false,
    }),
  };

  (globalThis as Record<string, unknown>).document = {
    documentElement: root,
    startViewTransition: stubs.startViewTransition
      ? (update: () => void) => {
          update();
          return {
            ready,
            finished,
            skipTransition() {
              skipped += 1;
            },
          };
        }
      : undefined,
  };
}

function percent(name: string): number {
  const raw = properties.get(name);
  expect(raw, `${name} should be set`).toBeDefined();
  expect(raw!.endsWith("%"), `${name} must use percentage units, got ${raw}`).toBe(true);
  return Number.parseFloat(raw!);
}

/** Radius percentages resolve against this reference box per css-shapes-1. */
function radiusReference(width: number, height: number): number {
  return Math.hypot(width, height) / Math.SQRT2;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).document;
});

async function loadRevealThemeAt() {
  const module = await import(`../src/app/theme?${Math.random()}`);
  return module.revealThemeAt as (
    origin: { x: number; y: number },
    updateTheme: () => void,
  ) => { ready: Promise<void>; finished: Promise<void> };
}

describe("theme radial reveal geometry", () => {
  test("expresses the origin and radius in percentages, not px", async () => {
    install();
    const revealThemeAt = await loadRevealThemeAt();

    revealThemeAt({ x: 348, y: 359 }, () => {});

    // px units are resolved against the View Transition pseudo-tree's own
    // scale, which on Android WebView tracked the device pixel ratio. The
    // circle then finished at ~1/DPR of the needed radius and the rest of the
    // theme change snapped in. Percentages are scale-invariant.
    for (const name of ["--theme-reveal-x", "--theme-reveal-y", "--theme-reveal-radius"]) {
      expect(properties.get(name)).not.toContain("px");
    }

    expect(percent("--theme-reveal-x")).toBeCloseTo((348 / 411) * 100, 1);
    expect(percent("--theme-reveal-y")).toBeCloseTo((359 / 893) * 100, 1);
    expect(dataset.themeReveal).toBe("true");
  });

  test("the radius covers the farthest viewport corner from any origin", async () => {
    const origins = [
      { x: 348, y: 359 }, // settings toggle, portrait phone
      { x: 0, y: 0 },
      { x: 411, y: 893 },
      { x: 205, y: 446 }, // centre: the worst case for an undersized radius
    ];

    for (const origin of origins) {
      install();
      const revealThemeAt = await loadRevealThemeAt();
      revealThemeAt(origin, () => {});

      const resolved = (percent("--theme-reveal-radius") / 100) * radiusReference(411, 893);
      const needed = Math.hypot(
        Math.max(origin.x, 411 - origin.x),
        Math.max(origin.y, 893 - origin.y),
      );

      expect(
        resolved,
        `origin ${origin.x},${origin.y}: resolved ${resolved.toFixed(1)} < needed ${needed.toFixed(1)}`,
      ).toBeGreaterThanOrEqual(needed);
      // Overshoot stays small so the reveal does not spend its easing offscreen.
      expect(resolved).toBeLessThan(needed * 1.25);
    }
  });

  test("clamps origins that fall outside the viewport", async () => {
    install();
    const revealThemeAt = await loadRevealThemeAt();

    revealThemeAt({ x: -80, y: 4000 }, () => {});

    expect(percent("--theme-reveal-x")).toBe(0);
    expect(percent("--theme-reveal-y")).toBe(100);
  });

  test("clears the reveal styles once the transition finishes", async () => {
    install();
    const revealThemeAt = await loadRevealThemeAt();

    let applied = false;
    const transition = revealThemeAt({ x: 348, y: 359 }, () => {
      applied = true;
    });
    expect(applied).toBe(true);

    resolveReady?.();
    resolveFinished?.();
    await transition.finished;

    expect(dataset.themeReveal).toBeUndefined();
    expect(properties.size).toBe(0);
  });

  test("applies the theme immediately when reduced motion is requested", async () => {
    install({ reducedMotion: true });
    const revealThemeAt = await loadRevealThemeAt();

    let applied = false;
    const transition = revealThemeAt({ x: 348, y: 359 }, () => {
      applied = true;
    });
    await transition.finished;

    expect(applied).toBe(true);
    expect(properties.size).toBe(0);
    expect(dataset.themeReveal).toBeUndefined();
  });

  test("falls back cleanly without View Transition support", async () => {
    install({ startViewTransition: false });
    const revealThemeAt = await loadRevealThemeAt();

    let applied = false;
    const transition = revealThemeAt({ x: 10, y: 10 }, () => {
      applied = true;
    });
    await transition.finished;

    expect(applied).toBe(true);
    expect(properties.size).toBe(0);
  });

  test("skips an in-flight reveal when the theme is toggled again", async () => {
    install();
    const revealThemeAt = await loadRevealThemeAt();

    revealThemeAt({ x: 10, y: 10 }, () => {});
    revealThemeAt({ x: 300, y: 300 }, () => {});

    expect(skipped).toBe(1);
  });
});
