/**
 * Runtime side of the multi-view live clock alignment.
 *
 * The tiles register their player handles here; one timer samples every feed,
 * asks `planLiveSync` for corrections and applies them. Statuses are published
 * through a per-feed subscription so a tick only re-renders the tiles whose
 * displayed numbers actually changed — six players re-rendering every second
 * would be far more expensive than the alignment itself.
 */

import type { LivePlayerSyncApi } from "@/features/room/player/useWebPlayer";
import {
  LIVE_SYNC_BASE_HOLD_SECONDS,
  liveSyncManualAlignOffsets,
  planLiveSync,
  type LiveSyncClockKind,
  type LiveSyncMode,
  type LiveSyncSample,
} from "./liveSync";

/** Sampling period of the correction loop. */
export const LIVE_SYNC_TICK_MS = 1_000;
/**
 * A seek needs a moment to settle: mpegts.js re-primes its buffer and the
 * element fires `seeking`/`seeked` asynchronously. Correcting again inside that
 * window would read a stale position and jump twice.
 */
export const LIVE_SYNC_SEEK_COOLDOWN_MS = 2_200;

export type LiveSyncFeedStatus = {
  clockKind: LiveSyncClockKind;
  /** Signed seconds away from the shared target; positive means too late. */
  errorSeconds: number | null;
  /** Seconds behind this feed's own live edge. */
  holdSeconds: number | null;
  /** The retained buffer could not reach the target position. */
  limited: boolean;
};

export type LiveSyncSummary = {
  mode: LiveSyncMode;
  /** Shared latency behind wall clock in `auto` mode, else null. */
  targetLatencySeconds: number | null;
  /** Feeds currently being corrected. */
  activeCount: number;
};

type FeedRegistration = {
  main: boolean;
  sync: LivePlayerSyncApi;
  lastSeekAtMs: number;
};

const IDLE_SUMMARY: LiveSyncSummary = { mode: "off", targetLatencySeconds: null, activeCount: 0 };

function sameStatus(a: LiveSyncFeedStatus | null, b: LiveSyncFeedStatus | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const same = (left: number | null, right: number | null) =>
    left == null || right == null
      ? left === right
      : // Only tenths are ever shown, so ignore churn below that.
        Math.round(left * 10) === Math.round(right * 10);
  return (
    a.clockKind === b.clockKind &&
    a.limited === b.limited &&
    same(a.errorSeconds, b.errorSeconds) &&
    same(a.holdSeconds, b.holdSeconds)
  );
}

/**
 * Extra delay the alignment added to a feed, relative to an unsynced player.
 *
 * Danmaku arrives from the server in real time, so any hold the alignment adds
 * would otherwise make comments run ahead of the picture they belong to. The
 * value is quantized to half a second: comment timing does not need more, and a
 * value that changed on every tick would re-render the danmaku layer constantly.
 */
export function liveSyncDanmakuDelayMs(status: LiveSyncFeedStatus | null): number {
  if (!status || status.holdSeconds == null) return 0;
  const extra = status.holdSeconds - LIVE_SYNC_BASE_HOLD_SECONDS;
  return extra <= 0 ? 0 : Math.round(extra * 2) * 500;
}

/** How trustworthy a feed's wall clock is, in the grid's own wording. */
export function liveSyncClockLabel(kind: LiveSyncClockKind): string {
  switch (kind) {
    case "program-date":
      return "精确时钟";
    case "stream-anchor":
      return "估算时钟";
    default:
      return "无时钟基准";
  }
}

/** One-line status for a feed, used by the control panel and the tile badge. */
export function liveSyncFeedStatusText(status: LiveSyncFeedStatus | null): string {
  if (!status || status.holdSeconds == null) return "等待画面就绪";
  const parts = [liveSyncClockLabel(status.clockKind), `延后 ${status.holdSeconds.toFixed(1)}s`];
  if (status.errorSeconds != null && Math.abs(status.errorSeconds) >= 0.35) {
    const sign = status.errorSeconds > 0 ? "+" : "";
    parts.push(`偏差 ${sign}${status.errorSeconds.toFixed(1)}s`);
  }
  if (status.limited) parts.push("缓冲不足，已就近对齐");
  return parts.join(" · ");
}

export type MultiRoomLiveSyncRegistry = {
  registerFeed: (key: string, feed: { main: boolean; sync: LivePlayerSyncApi }) => () => void;
  subscribeFeed: (key: string, listener: () => void) => () => void;
  getFeedStatus: (key: string) => LiveSyncFeedStatus | null;
  subscribeSummary: (listener: () => void) => () => void;
  getSummary: () => LiveSyncSummary;
  /** Run one sampling/correction pass. Called by the provider's timer. */
  tick: (input: {
    mode: LiveSyncMode;
    offsets: Record<string, number>;
    nowMs: number;
  }) => Record<string, number>;
  /** Release every correction and clear published statuses. */
  reset: () => void;
  /** Manual-mode offsets that put the feeds on the slowest feed's clock. */
  computeAlignOffsets: (nowMs: number) => Record<string, number>;
};

export function createMultiRoomLiveSyncRegistry(): MultiRoomLiveSyncRegistry {
  const feeds = new Map<string, FeedRegistration>();
  const statuses = new Map<string, LiveSyncFeedStatus | null>();
  const feedListeners = new Map<string, Set<() => void>>();
  const summaryListeners = new Set<() => void>();
  let summary: LiveSyncSummary = IDLE_SUMMARY;
  let previousTargetSeconds: number | null = null;

  const notifyFeed = (key: string) => {
    for (const listener of feedListeners.get(key) ?? []) listener();
  };

  const publishStatus = (key: string, status: LiveSyncFeedStatus | null) => {
    if (sameStatus(statuses.get(key) ?? null, status)) return;
    statuses.set(key, status);
    notifyFeed(key);
  };

  const publishSummary = (next: LiveSyncSummary) => {
    if (
      summary.mode === next.mode &&
      summary.activeCount === next.activeCount &&
      (summary.targetLatencySeconds == null || next.targetLatencySeconds == null
        ? summary.targetLatencySeconds === next.targetLatencySeconds
        : Math.round(summary.targetLatencySeconds * 10) ===
          Math.round(next.targetLatencySeconds * 10))
    ) {
      return;
    }
    summary = next;
    for (const listener of summaryListeners) listener();
  };

  const collectSamples = (offsets: Record<string, number>): LiveSyncSample[] => {
    const samples: LiveSyncSample[] = [];
    for (const [key, feed] of feeds) {
      const timeline = feed.sync.readTimeline();
      samples.push({
        key,
        main: feed.main,
        ready: timeline.ready,
        mediaTime: timeline.mediaTime,
        bufferStart: timeline.bufferStart,
        bufferEnd: timeline.bufferEnd,
        clockKind: timeline.clockKind,
        epochAtMediaZeroMs: timeline.epochAtMediaZeroMs,
        offsetSeconds: offsets[key] ?? 0,
        playbackRate: timeline.playbackRate,
      });
    }
    return samples;
  };

  return {
    registerFeed: (key, feed) => {
      feeds.set(key, { main: feed.main, sync: feed.sync, lastSeekAtMs: 0 });
      return () => {
        const registration = feeds.get(key);
        if (registration?.sync !== feed.sync) return;
        registration.sync.setPlaybackRate(1);
        feeds.delete(key);
        statuses.delete(key);
        notifyFeed(key);
      };
    },
    subscribeFeed: (key, listener) => {
      const listeners = feedListeners.get(key) ?? new Set<() => void>();
      listeners.add(listener);
      feedListeners.set(key, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) feedListeners.delete(key);
      };
    },
    getFeedStatus: (key) => statuses.get(key) ?? null,
    subscribeSummary: (listener) => {
      summaryListeners.add(listener);
      return () => summaryListeners.delete(listener);
    },
    getSummary: () => summary,
    tick: ({ mode, offsets, nowMs }) => {
      if (mode === "off" || feeds.size === 0) {
        previousTargetSeconds = null;
        publishSummary({ mode, targetLatencySeconds: null, activeCount: 0 });
        for (const key of statuses.keys()) publishStatus(key, null);
        return {};
      }

      const plan = planLiveSync({
        mode,
        samples: collectSamples(offsets),
        nowMs,
        previousTargetSeconds,
      });
      previousTargetSeconds = plan.targetLatencySeconds;

      const applied: Record<string, number> = {};
      let activeCount = 0;
      for (const feedPlan of plan.feeds) {
        const feed = feeds.get(feedPlan.key);
        if (!feed) continue;
        publishStatus(feedPlan.key, {
          clockKind: feedPlan.clockKind,
          errorSeconds: feedPlan.errorSeconds,
          holdSeconds: feedPlan.holdSeconds,
          limited: feedPlan.limited,
        });
        if (feedPlan.holdSeconds != null) activeCount += 1;
        if (nowMs - feed.lastSeekAtMs < LIVE_SYNC_SEEK_COOLDOWN_MS) continue;
        switch (feedPlan.action.kind) {
          case "seek":
            feed.sync.setPlaybackRate(1);
            feed.sync.seekMediaTime(feedPlan.action.mediaTime);
            feed.lastSeekAtMs = nowMs;
            applied[feedPlan.key] = feedPlan.action.mediaTime;
            break;
          case "rate":
            feed.sync.setPlaybackRate(feedPlan.action.rate);
            break;
          default:
            feed.sync.setPlaybackRate(1);
            break;
        }
      }
      publishSummary({ mode, targetLatencySeconds: plan.targetLatencySeconds, activeCount });
      return applied;
    },
    reset: () => {
      previousTargetSeconds = null;
      for (const feed of feeds.values()) feed.sync.setPlaybackRate(1);
      const keys = Array.from(statuses.keys());
      statuses.clear();
      for (const key of keys) notifyFeed(key);
      publishSummary(IDLE_SUMMARY);
    },
    computeAlignOffsets: (nowMs) => liveSyncManualAlignOffsets(collectSamples({}), nowMs),
  };
}
