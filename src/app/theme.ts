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
let activeThemeAnimation: Animation | null = null;

export function applyTheme(theme: ThemeMode) {
  const root = document.documentElement;
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = theme === "dark" || (theme === "system" && prefersDark);
  root.classList.toggle("dark", dark);
}

function updateThemeImmediately(updateTheme: () => void): ThemeRevealTransition {
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

  activeThemeAnimation?.cancel();
  activeThemeTransition?.skipTransition();

  const root = document.documentElement;
  const x = Math.min(window.innerWidth, Math.max(0, origin.x));
  const y = Math.min(window.innerHeight, Math.max(0, origin.y));
  const radius = Math.hypot(
    Math.max(x, window.innerWidth - x),
    Math.max(y, window.innerHeight - y),
  );

  root.dataset.themeReveal = "true";

  let transition: ViewTransition;
  try {
    transition = document.startViewTransition(updateTheme);
  } catch {
    delete root.dataset.themeReveal;
    return updateThemeImmediately(updateTheme);
  }

  activeThemeTransition = transition;

  const ready = transition.ready
    .then(() => {
      if (activeThemeTransition !== transition) return;

      activeThemeAnimation = root.animate(
        {
          clipPath: [
            `circle(0px at ${x}px ${y}px)`,
            `circle(${Math.ceil(radius) + 2}px at ${x}px ${y}px)`,
          ],
        },
        {
          duration: window.matchMedia("(pointer: coarse)").matches ? 420 : 520,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          fill: "both",
          pseudoElement: "::view-transition-new(root)",
        },
      );
    })
    .catch(() => {
      if (activeThemeTransition === transition) transition.skipTransition();
    });

  const finished = transition.finished
    .catch(() => undefined)
    .then(
      () =>
        new Promise<void>((resolve) => {
          // Let the live document paint the settled token set before restoring
          // ordinary component transitions. Otherwise Chromium can create a
          // fresh batch of color/control transitions as the snapshots leave.
          window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
        }),
    )
    .then(() => {
      if (activeThemeTransition !== transition) return;
      activeThemeAnimation?.cancel();
      activeThemeAnimation = null;
      activeThemeTransition = null;
      delete root.dataset.themeReveal;
    });

  return { ready, finished };
}
