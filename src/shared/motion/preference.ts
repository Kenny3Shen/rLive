import type { MotionMode } from "@/shared/types/live";

export type ResolvedMotionMode = "full" | "reduced";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
export const MOTION_CHANGE_EVENT = "rlive:motionchange";

let activeMotionMode: MotionMode = "system";
let motionMedia: MediaQueryList | null = null;

export function isMotionMode(value: unknown): value is MotionMode {
  return value === "system" || value === "full" || value === "reduced";
}

export function resolveMotionMode(
  mode: MotionMode,
  systemPrefersReducedMotion: boolean,
): ResolvedMotionMode {
  if (mode === "full") return "full";
  if (mode === "reduced") return "reduced";
  return systemPrefersReducedMotion ? "reduced" : "full";
}

function systemPrefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function updateRootMotionMode() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const previous = root.dataset.motion;
  root.dataset.motionPreference = activeMotionMode;
  root.dataset.motion = resolveMotionMode(activeMotionMode, systemPrefersReducedMotion());
  if (previous && previous !== root.dataset.motion && typeof window !== "undefined") {
    window.dispatchEvent(new Event(MOTION_CHANGE_EVENT));
  }
}

function ensureSystemPreferenceListener() {
  if (typeof window === "undefined" || !window.matchMedia || motionMedia) return;
  motionMedia = window.matchMedia(REDUCED_MOTION_QUERY);
  if (typeof motionMedia.addEventListener === "function") {
    motionMedia.addEventListener("change", updateRootMotionMode);
  } else {
    // Older Android WebViews expose the legacy listener API only.
    motionMedia.addListener(updateRootMotionMode);
  }
}

/** Apply the persisted preference before React paints and keep system mode live. */
export function applyMotionMode(mode: MotionMode) {
  activeMotionMode = isMotionMode(mode) ? mode : "system";
  ensureSystemPreferenceListener();
  updateRootMotionMode();
}

/** Live read shared by GSAP, WAAPI, gestures and View Transitions. */
export function prefersReducedMotion(): boolean {
  if (typeof document !== "undefined") {
    const resolved = document.documentElement.dataset.motion;
    if (resolved === "full" || resolved === "reduced") return resolved === "reduced";
  }
  return resolveMotionMode(activeMotionMode, systemPrefersReducedMotion()) === "reduced";
}
