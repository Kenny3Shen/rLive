export const MOBILE_DANMAKU_MAX_FPS = 60;
export const MOBILE_DANMAKU_FRAME_INTERVAL_MS = 1_000 / MOBILE_DANMAKU_MAX_FPS;

// Browser animation timestamps can land a fraction before the nominal target.
// A small tolerance avoids accidentally halving 60 Hz output because of jitter.
const FRAME_DEADLINE_TOLERANCE_MS = 0.75;

export function canvasFrameIsDue(now: number, deadline: number, intervalMs: number): boolean {
  return intervalMs <= 0 || deadline <= 0 || now + FRAME_DEADLINE_TOLERANCE_MS >= deadline;
}

/**
 * Advance from the prior deadline so 90 Hz displays average toward 60 FPS
 * instead of falling to 45 FPS. A long pause resets the cadence without a
 * burst of catch-up frames.
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
