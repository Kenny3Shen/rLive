export const FULL_MOTION_MODE = "full" as const;

/** 在 React 绘制之前应用完整的动态效果配置。 */
export function applyFullMotion() {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.motion = FULL_MOTION_MODE;
}

/**
 * 应用不再暴露动态效果选择器，但仍需尊重操作系统的无障碍偏好，
 * 同时不改持久化的完整动态默认值。
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
