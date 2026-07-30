let latestEpoch = 0;

export type DanmakuConnectionFence = Readonly<{
  /** Stops anything that was active before the next desired connection. */
  disconnectEpoch: number;
  /** Identifies the connection that is allowed to become active afterwards. */
  connectionEpoch: number;
}>;

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

/**
 * Reserve separate monotonic tokens for stopping an old room and connecting
 * its replacement. A delayed stop with the lower token is then harmless once
 * the higher-token connection has reached the native backend.
 */
export function nextDanmakuConnectionFence(now = Date.now()): DanmakuConnectionFence {
  const disconnectEpoch = nextDanmakuConnectionEpoch(now);
  return {
    disconnectEpoch,
    connectionEpoch: nextDanmakuConnectionEpoch(now),
  };
}
