let latestEpoch = 0;

/**
 * Produces an app-wide, monotonic token for a desired danmaku connection.
 *
 * Wall-clock time makes a token survive a frontend reload while the extra
 * increment keeps rapid route changes ordered within the same millisecond.
 */
export function nextDanmakuConnectionEpoch(now = Date.now()): number {
  latestEpoch = Math.max(latestEpoch + 1, Math.floor(now));
  return latestEpoch;
}
