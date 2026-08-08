export const MOBILE_DANMAKU_MAX_FPS = 60;
export const MOBILE_DANMAKU_FRAME_INTERVAL_MS = 1_000 / MOBILE_DANMAKU_MAX_FPS;
// Mobile WebViews commonly report a 2×–3× device scale. A 1× backing store is
// visibly upscaled by the compositor, so favor a crisp 2× text raster and cap
// paint cadence at 60 FPS to keep total pixel throughput bounded.
export const MOBILE_DANMAKU_MAX_PIXEL_RATIO = 2;
export const DESKTOP_DANMAKU_MAX_PIXEL_RATIO = 1.5;

// Browser animation timestamps can land a fraction before the nominal target.
// A small tolerance avoids accidentally skipping a refresh because of jitter.
const FRAME_DEADLINE_TOLERANCE_MS = 0.75;

export function canvasFrameIsDue(now: number, deadline: number, intervalMs: number): boolean {
  return intervalMs <= 0 || deadline <= 0 || now + FRAME_DEADLINE_TOLERANCE_MS >= deadline;
}

export function danmakuCanvasPixelRatio(devicePixelRatio: number, mobile: boolean): number {
  const safePixelRatio = Number.isFinite(devicePixelRatio) ? Math.max(devicePixelRatio, 1) : 1;
  return Math.min(
    safePixelRatio,
    mobile ? MOBILE_DANMAKU_MAX_PIXEL_RATIO : DESKTOP_DANMAKU_MAX_PIXEL_RATIO,
  );
}

/**
 * Advance from the prior deadline so displays above the mobile cap retain an
 * even cadence. A long pause resets the cadence without catch-up frames.
 */
export function nextCanvasFrameDeadline(
  now: number,
  previousDeadline: number,
  intervalMs: number,
): number {
  if (intervalMs <= 0) return now;
  if (previousDeadline <= 0 || now - previousDeadline > intervalMs * 2) {
    return now + intervalMs;
  }

  let next = previousDeadline + intervalMs;
  while (next <= now) next += intervalMs;
  return next;
}
