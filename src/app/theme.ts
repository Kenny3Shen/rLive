import type { ThemeMode } from "../shared/stores/settingsStore";

export type ThemeRevealTransition = {
  ready: Promise<void>;
  finished: Promise<void>;
};

type ThemeRevealOrigin = {
  x: number;
  y: number;
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
  const x = Math.min(window.innerWidth, Math.max(0, origin.x));
  const y = Math.min(window.innerHeight, Math.max(0, origin.y));
  const radius = Math.hypot(
    Math.max(x, window.innerWidth - x),
    Math.max(y, window.innerHeight - y),
  );

  root.style.setProperty("--theme-reveal-x", `${x}px`);
  root.style.setProperty("--theme-reveal-y", `${y}px`);
  root.style.setProperty("--theme-reveal-radius", `${Math.ceil(radius) + 2}px`);
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
