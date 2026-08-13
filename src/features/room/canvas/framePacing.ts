// Keep mobile pixel throughput predictable so every display refresh can be
// spent advancing the danmaku instead of repainting a high-DPI backing store.
export const MOBILE_DANMAKU_PIXEL_RATIO = 1;
export const DESKTOP_DANMAKU_MAX_PIXEL_RATIO = 1.5;

export function danmakuCanvasPixelRatio(devicePixelRatio: number, mobile: boolean): number {
  const safePixelRatio = Number.isFinite(devicePixelRatio) ? Math.max(devicePixelRatio, 1) : 1;
  return mobile
    ? MOBILE_DANMAKU_PIXEL_RATIO
    : Math.min(safePixelRatio, DESKTOP_DANMAKU_MAX_PIXEL_RATIO);
}
