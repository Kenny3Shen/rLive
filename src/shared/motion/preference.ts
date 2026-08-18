export const FULL_MOTION_MODE = "full" as const;

/** Apply the complete motion profile before React paints. */
export function applyFullMotion() {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.motion = FULL_MOTION_MODE;
}

/**
 * The app no longer exposes a motion selector, but the operating system's
 * accessibility preference still needs to be honored without changing the
 * persisted full-motion default.
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
