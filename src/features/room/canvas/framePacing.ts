export const MOBILE_DANMAKU_TARGET_FPS = 60;
export const DEFAULT_DANMAKU_REFRESH_RATE_HZ = 60;
export const MOBILE_DANMAKU_MAX_PIXEL_RATIO = 2;
export const MOBILE_DANMAKU_HIGH_REFRESH_PIXEL_RATIO = 1.5;
export const MOBILE_DANMAKU_HIGH_REFRESH_RATE_HZ = 75;
export const DESKTOP_DANMAKU_MAX_PIXEL_RATIO = 1.5;

const REFRESH_RATE_SAMPLE_COUNT = 15;
const INTEGER_REFRESH_RATIO_TOLERANCE = 0.02;

/**
 * Paint on the first callback and then every `skipEvery`th callback. Keeping
 * this decision tied to callback counts makes a future frame skip uniform on
 * displays whose refresh rate is an integer multiple of the target rate.
 */
export function shouldPaintFrame(frameCounter: number, skipEvery: number): boolean {
  if (!Number.isFinite(skipEvery) || skipEvery <= 1) return true;
  return frameCounter % Math.floor(skipEvery) === 0;
}

/**
 * Return a safe integer callback interval for a target FPS. Zero means the
 * display cannot represent that target with an even integer frame cadence, so
 * callers should follow every callback instead of introducing judder.
 */
export function danmakuFrameSkip(measuredHz: number, targetFps: number): number {
  if (!Number.isFinite(measuredHz) || measuredHz <= 0 || !Number.isFinite(targetFps)) {
    return 0;
  }
  if (targetFps <= 0) return 0;

  const ratio = measuredHz / targetFps;
  const roundedRatio = Math.round(ratio);
  if (roundedRatio < 1 || Math.abs(ratio - roundedRatio) > INTEGER_REFRESH_RATIO_TOLERANCE) {
    return 0;
  }
  return roundedRatio;
}

/** Estimate the display rate from rAF intervals using a median, not an average. */
export function estimateRefreshRateHz(frameIntervalsMs: readonly number[]): number {
  const validIntervals = frameIntervalsMs
    .filter((interval) => Number.isFinite(interval) && interval > 0)
    .sort((left, right) => left - right);
  if (validIntervals.length === 0) return DEFAULT_DANMAKU_REFRESH_RATE_HZ;

  const middle = Math.floor(validIntervals.length / 2);
  const median =
    validIntervals.length % 2 === 0
      ? (validIntervals[middle - 1] + validIntervals[middle]) / 2
      : validIntervals[middle];
  return 1_000 / median;
}

let refreshRateProbe: Promise<number> | null = null;
let cachedRefreshRateHz: number | null = null;

/** Probe the current window once and reuse the result for later canvas instances. */
export function measureDisplayRefreshRate(): Promise<number> {
  if (cachedRefreshRateHz !== null) return Promise.resolve(cachedRefreshRateHz);
  if (refreshRateProbe !== null) return refreshRateProbe;

  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    cachedRefreshRateHz = DEFAULT_DANMAKU_REFRESH_RATE_HZ;
    return Promise.resolve(cachedRefreshRateHz);
  }

  refreshRateProbe = new Promise((resolve) => {
    const intervals: number[] = [];
    let previousTimestamp = 0;

    const sample = (timestamp: number) => {
      if (previousTimestamp > 0) intervals.push(timestamp - previousTimestamp);
      previousTimestamp = timestamp;
      if (intervals.length < REFRESH_RATE_SAMPLE_COUNT) {
        window.requestAnimationFrame(sample);
        return;
      }

      const measuredHz = estimateRefreshRateHz(intervals);
      cachedRefreshRateHz = measuredHz;
      refreshRateProbe = null;
      resolve(measuredHz);
    };

    window.requestAnimationFrame(sample);
  });
  return refreshRateProbe;
}

export function danmakuCanvasPixelRatio(
  devicePixelRatio: number,
  mobile: boolean,
  refreshRateHz = DEFAULT_DANMAKU_REFRESH_RATE_HZ,
): number {
  const safePixelRatio = Number.isFinite(devicePixelRatio) ? Math.max(devicePixelRatio, 1) : 1;
  if (!mobile) return Math.min(safePixelRatio, DESKTOP_DANMAKU_MAX_PIXEL_RATIO);

  const safeRefreshRate = Number.isFinite(refreshRateHz)
    ? refreshRateHz
    : DEFAULT_DANMAKU_REFRESH_RATE_HZ;
  const maxPixelRatio =
    safeRefreshRate > MOBILE_DANMAKU_HIGH_REFRESH_RATE_HZ
      ? MOBILE_DANMAKU_HIGH_REFRESH_PIXEL_RATIO
      : MOBILE_DANMAKU_MAX_PIXEL_RATIO;
  return Math.min(safePixelRatio, maxPixelRatio);
}
