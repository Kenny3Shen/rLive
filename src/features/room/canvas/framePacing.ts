// One backing-store policy for every client. A device-scale cap keeps a
// full-canvas clear and redraw affordable on 3x displays while leaving text
// crisper than a fixed 1x store, which visibly blurred glyphs on phones.
export const DANMAKU_MAX_PIXEL_RATIO = 1.5;

export function danmakuCanvasPixelRatio(devicePixelRatio: number): number {
  const safePixelRatio = Number.isFinite(devicePixelRatio) ? Math.max(devicePixelRatio, 1) : 1;
  return Math.min(safePixelRatio, DANMAKU_MAX_PIXEL_RATIO);
}
