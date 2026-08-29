import type { ThemeMode } from "../shared/stores/settingsStore";
import { prefersReducedMotion } from "../shared/motion/preference";
import { syncAndroidSystemBars } from "./androidSystemBars";

export type ThemeTransition = {
  ready: Promise<void>;
  finished: Promise<void>;
};

let activeThemeTransition: ViewTransition | null = null;

const THEME_FADE_PROPERTIES = ["--theme-fade-duration"] as const;

export function applyTheme(theme: ThemeMode) {
  const root = document.documentElement;
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = theme === "dark" || (theme === "system" && prefersDark);
  root.classList.toggle("dark", dark);
  // Android 系统栏图标跟随应用主题：enableEdgeToEdge() 只按系统 night mode
  // 决定一次，应用内切换亮暗时需经原生桥同步（内部自行去重、非 Android
  // 客户端 no-op）。
  syncAndroidSystemBars(dark);
}

/**
 * “跟随系统”模式下监听系统亮暗变化，并实时重新应用主题；
 * 显式选择浅色或深色时不响应。返回移除监听的函数。
 */
export function watchSystemThemeChanges(getTheme: () => ThemeMode): () => void {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (getTheme() === "system") applyTheme("system");
  };
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function clearThemeFadeStyles(root: HTMLElement) {
  delete root.dataset.themeFade;
  for (const property of THEME_FADE_PROPERTIES) {
    root.style.removeProperty(property);
  }
}

function updateThemeImmediately(updateTheme: () => void): ThemeTransition {
  activeThemeTransition?.skipTransition();
  activeThemeTransition = null;
  clearThemeFadeStyles(document.documentElement);
  updateTheme();
  const complete = Promise.resolve();
  return { ready: complete, finished: complete };
}

/** 以全局交叉淡化应用新主题：新快照整屏淡入，旧快照静态垫底。 */
export function fadeTheme(updateTheme: () => void): ThemeTransition {
  if (prefersReducedMotion() || typeof document.startViewTransition !== "function") {
    return updateThemeImmediately(updateTheme);
  }

  activeThemeTransition?.skipTransition();

  const root = document.documentElement;
  root.style.setProperty(
    "--theme-fade-duration",
    window.matchMedia("(pointer: coarse)").matches ? "240ms" : "280ms",
  );
  root.dataset.themeFade = "true";

  let transition: ViewTransition;
  try {
    transition = document.startViewTransition(updateTheme);
  } catch {
    clearThemeFadeStyles(root);
    return updateThemeImmediately(updateTheme);
  }

  activeThemeTransition = transition;

  // 淡化本身就是新快照上的一段 CSS 动画。把时序留在 View Transition 伪树内，
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
      clearThemeFadeStyles(root);
    });

  return { ready, finished };
}
