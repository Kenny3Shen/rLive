import type { ThemeMode } from "../shared/stores/settingsStore";

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
 * Viewport-relative geometry avoids Android WebView's device-pixel scaling of
 * CSS px lengths inside the View Transition pseudo-tree.
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
    // One extra vmax covers rounding at the snapshot edge without spending a
    // noticeable part of the easing curve outside the viewport.
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

/** Reveals the newly applied theme outwards from the activating control. */
export function revealThemeAt(
  origin: ThemeRevealOrigin,
  updateTheme: () => void,
): ThemeRevealTransition {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reducedMotion || typeof document.startViewTransition !== "function") {
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
    window.matchMedia("(pointer: coarse)").matches ? "420ms" : "520ms",
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

  // The reveal itself is one CSS animation on the new snapshot. Keeping the
  // timing inside the View Transition pseudo-tree makes `finished` the single
  // source of truth instead of racing a separate WAAPI Animation.
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
