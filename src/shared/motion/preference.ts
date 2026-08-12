export const FULL_MOTION_MODE = "full" as const;

export function resolveMotionMode(
  _legacyMode?: unknown,
  _systemPrefersReducedMotion?: boolean,
): typeof FULL_MOTION_MODE {
  return FULL_MOTION_MODE;
}

/** Apply the complete motion profile before React paints. */
export function applyFullMotion() {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.motion = FULL_MOTION_MODE;
}

/** Compatibility helper shared by GSAP, WAAPI, gestures and View Transitions. */
export function prefersReducedMotion(): boolean {
  return false;
}
