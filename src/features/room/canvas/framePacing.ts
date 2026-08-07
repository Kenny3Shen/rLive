export const MOBILE_DANMAKU_MAX_FPS = 120;
export const MOBILE_DANMAKU_FRAME_INTERVAL_MS = 1_000 / MOBILE_DANMAKU_MAX_FPS;
// A 1× mobile backing store keeps 120 FPS pixel throughput below the previous
// 60 FPS / 1.5× profile. Desktop retains extra text sharpness at its lower
// contention level.
export const MOBILE_DANMAKU_MAX_PIXEL_RATIO = 1;
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
