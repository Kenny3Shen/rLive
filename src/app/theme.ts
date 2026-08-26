import type { ThemeMode } from "../shared/stores/settingsStore";
import { prefersReducedMotion } from "../shared/motion/preference";

export type ThemeRevealTransition = {
  ready: Promise<void>;
  finished: Promise<void>;
};

type ThemeRevealOrigin = {
  x: number;
  y: number;
};

type ThemeRevealViewport = {
  width: number;
  height: number;
};

let activeThemeTransition: ViewTransition | null = null;

const THEME_REVEAL_PROPERTIES = [
  "--theme-reveal-x",
  "--theme-reveal-y",
  "--theme-reveal-radius",
  "--theme-reveal-duration",
] as const;

export function applyTheme(theme: ThemeMode) {
  const root = document.documentElement;
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = theme === "dark" || (theme === "system" && prefersDark);
  root.classList.toggle("dark", dark);
}

/**
 * 采用视口相对的几何尺寸，规避 Android WebView 对 View Transition 伪树内
 * CSS px 长度做的设备像素缩放。
 */
export function themeRevealGeometry(
  origin: ThemeRevealOrigin,
  viewport: ThemeRevealViewport,
): { x: string; y: string; radius: string } {
  const width = Math.max(1, viewport.width);
  const height = Math.max(1, viewport.height);
  const x = Math.min(width, Math.max(0, origin.x));
  const y = Math.min(height, Math.max(0, origin.y));
  const radius = Math.hypot(Math.max(x, width - x), Math.max(y, height - y));
  const maxDimension = Math.max(width, height);

  return {
    x: `${((x / width) * 100).toFixed(3)}vw`,
    y: `${((y / height) * 100).toFixed(3)}vh`,
    // 多出的一个 vmax 用于吸收快照边缘的舍入误差，
    // 而不必让缓动曲线的可观部分花费在视口之外。
    radius: `${((radius / maxDimension) * 100 + 1).toFixed(3)}vmax`,
  };
}

function clearThemeRevealStyles(root: HTMLElement) {
  delete root.dataset.themeReveal;
  for (const property of THEME_REVEAL_PROPERTIES) {
    root.style.removeProperty(property);
  }
}

function updateThemeImmediately(updateTheme: () => void): ThemeRevealTransition {
  activeThemeTransition?.skipTransition();
  activeThemeTransition = null;
  clearThemeRevealStyles(document.documentElement);
  updateTheme();
  const complete = Promise.resolve();
  return { ready: complete, finished: complete };
}

/** 从触发控件向外揭示新应用的主题。 */
export function revealThemeAt(
  origin: ThemeRevealOrigin,
  updateTheme: () => void,
): ThemeRevealTransition {
  if (prefersReducedMotion() || typeof document.startViewTransition !== "function") {
    return updateThemeImmediately(updateTheme);
  }

  activeThemeTransition?.skipTransition();

  const root = document.documentElement;
  const geometry = themeRevealGeometry(origin, {
    width: window.innerWidth,
    height: window.innerHeight,
  });

  root.style.setProperty("--theme-reveal-x", geometry.x);
  root.style.setProperty("--theme-reveal-y", geometry.y);
  root.style.setProperty("--theme-reveal-radius", geometry.radius);
  root.style.setProperty(
    "--theme-reveal-duration",
    window.matchMedia("(pointer: coarse)").matches ? "240ms" : "280ms",
  );
  root.dataset.themeReveal = "true";

  let transition: ViewTransition;
  try {
    transition = document.startViewTransition(updateTheme);
  } catch {
    clearThemeRevealStyles(root);
    return updateThemeImmediately(updateTheme);
  }

  activeThemeTransition = transition;

  // 揭示本身就是新快照上的一段 CSS 动画。把时序留在 View Transition 伪树内，
  // 让 `finished` 成为唯一事实来源，而不是与另一个 WAAPI Animation 竞争。
  const ready = transition.ready
    .catch(() => {
      if (activeThemeTransition === transition) transition.skipTransition();
    })
    .then(() => undefined);

  const finished = transition.finished
    .catch(() => undefined)
    .then(() => {
      if (activeThemeTransition !== transition) return;
      activeThemeTransition = null;
      clearThemeRevealStyles(root);
    });

  return { ready, finished };
}
