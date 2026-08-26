/**
 * 多视图直播时钟对齐的运行时部分。
 *
 * 各磁贴在这里注册播放器句柄；一个计时器采样每条流，
 * 向 `planLiveSync` 请求校正并应用。状态通过逐流订阅发布，
 * 使一次 tick 只重渲染显示数值真正变化的磁贴 ——
 * 六个播放器每秒全部重渲染的开销远高于对齐本身。
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

/** 校正循环的采样周期。 */
export const LIVE_SYNC_TICK_MS = 1_000;
/**
 * seek 需要一点时间稳定：mpegts.js 会重建缓冲，元素异步触发
 * `seeking`/`seeked`。在这个窗口内再次校正会读到过期位置并二次跳转。
 */
export const LIVE_SYNC_SEEK_COOLDOWN_MS = 2_200;

export type LiveSyncFeedStatus = {
  clockKind: LiveSyncClockKind;
  /** 偏离共享目标的带符号秒数；正表示过晚。 */
  errorSeconds: number | null;
  /** 落后于该流自身直播边缘的秒数。 */
  holdSeconds: number | null;
  /** 保留缓冲区无法到达目标位置。 */
  limited: boolean;
};

export type LiveSyncSummary = {
  mode: LiveSyncMode;
  /** `auto` 模式下落后于挂钟的共享延迟，否则为 null。 */
  targetLatencySeconds: number | null;
  /** 当前正在校正的流。 */
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
      : // 界面最多显示到十分位，忽略更小的抖动。
        Math.round(left * 10) === Math.round(right * 10);
  return (
    a.clockKind === b.clockKind &&
    a.limited === b.limited &&
    same(a.errorSeconds, b.errorSeconds) &&
    same(a.holdSeconds, b.holdSeconds)
  );
}

/**
 * 对齐给某条流附加的额外延迟，相对未同步的播放器而言。
 *
 * 弹幕由服务器实时下发，对齐造成的任何滞留若不补偿，
 * 都会让评论跑在其所属画面的前面。该值量化到半秒：
 * 评论时序不需要更细，
 * 而逐 tick 变化的取值会让弹幕层不停重渲染。
 */
export function liveSyncDanmakuDelayMs(status: LiveSyncFeedStatus | null): number {
  if (!status || status.holdSeconds == null) return 0;
  const extra = status.holdSeconds - LIVE_SYNC_BASE_HOLD_SECONDS;
  return extra <= 0 ? 0 : Math.round(extra * 2) * 500;
}

/** 以网格自己的措辞描述某条流挂钟的可信程度。 */
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

/** 单条流的单行状态，供控制面板和磁贴徽标使用。 */
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
  /** 执行一次采样/校正。由 provider 的计时器调用。 */
  tick: (input: {
    mode: LiveSyncMode;
    offsets: Record<string, number>;
    nowMs: number;
  }) => Record<string, number>;
  /** 释放所有校正并清空已发布的状态。 */
  reset: () => void;
  /** manual 模式偏移量，把各流对齐到最慢流的时钟。 */
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
