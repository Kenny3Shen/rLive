import { describe, expect, test } from "bun:test";
import {
  LIVE_SYNC_BASE_HOLD_SECONDS,
  LIVE_SYNC_MAX_TARGET_LATENCY_SECONDS,
  LIVE_SYNC_OFFSET_MAX_SECONDS,
  LIVE_SYNC_RATE_TRIM,
  LIVE_SYNC_TARGET_RELEASE_SECONDS,
  liveSyncLatencySeconds,
  liveSyncManualAlignOffsets,
  liveSyncTargetLatencySeconds,
  normalizeLiveSyncMode,
  normalizeLiveSyncOffset,
  planLiveSync,
  type LiveSyncSample,
} from "../src/features/multi-room/liveSync";
import {
  createMultiRoomLiveSyncRegistry,
  LIVE_SYNC_SEEK_COOLDOWN_MS,
  liveSyncClockLabel,
  liveSyncDanmakuDelayMs,
  liveSyncFeedStatusText,
} from "../src/features/multi-room/liveSyncRegistry";
import {
  liveFlvPlaybackOptions,
  liveHlsPlaybackOptions,
  liveMpegtsPlaybackOptions,
  LIVE_SYNC_HOLD_MIN_BACKWARD_SECONDS,
} from "../src/features/room/player/useWebPlayer";
import { pruneMultiRoomSyncOffsets } from "../src/features/multi-room/multiRoomStore";

const NOW = 1_700_000_000_000;

/** A feed whose shown frame is `latency` seconds old and `edge` from live. */
function feed(
  key: string,
  options: {
    main?: boolean;
    latency: number;
    edge?: number;
    backBuffer?: number;
    clock?: "program-date" | "stream-anchor" | "none";
    offset?: number;
    ready?: boolean;
  },
): LiveSyncSample {
  const { main = false, latency, edge = 1, backBuffer = 30, clock = "program-date" } = options;
  const mediaTime = 120;
  return {
    key,
    main,
    ready: options.ready ?? true,
    mediaTime,
    bufferStart: mediaTime - backBuffer,
    bufferEnd: mediaTime + edge,
    clockKind: clock,
    epochAtMediaZeroMs: clock === "none" ? null : NOW - latency * 1_000 - mediaTime * 1_000,
    offsetSeconds: options.offset ?? 0,
    playbackRate: 1,
  };
}

describe("live sync clock mapping", () => {
  test("derives the wall-clock latency of a feed from its anchor", () => {
    expect(liveSyncLatencySeconds(feed("a", { latency: 6 }), NOW)).toBeCloseTo(6, 5);
  });

  test("reports no latency for a feed without a clock", () => {
    expect(liveSyncLatencySeconds(feed("a", { latency: 6, clock: "none" }), NOW)).toBeNull();
  });

  test("normalizes persisted modes and offsets", () => {
    expect(normalizeLiveSyncMode("auto")).toBe("auto");
    expect(normalizeLiveSyncMode("frame")).toBe("off");
    expect(normalizeLiveSyncOffset(3.3)).toBe(3.5);
    expect(normalizeLiveSyncOffset(999)).toBe(LIVE_SYNC_OFFSET_MAX_SECONDS);
    expect(normalizeLiveSyncOffset("nope")).toBe(0);
  });
});

describe("live sync target latency", () => {
  test("follows the audible main feed so its pitch is never bent", () => {
    const samples = [feed("main", { main: true, latency: 6 }), feed("b", { latency: 3 })];
    // Main sits `LIVE_SYNC_BASE_HOLD_SECONDS` behind its own live edge (1s away
    // here), and the group follows that position.
    expect(liveSyncTargetLatencySeconds(samples, NOW, null)).toBeCloseTo(
      6 - 1 + LIVE_SYNC_BASE_HOLD_SECONDS,
      5,
    );
  });

  test("does not drift further back when the main feed falls behind its edge", () => {
    // A rebuffered main feed is 9s behind wall clock but its live edge has moved
    // on by 4s, so the target stays near the edge instead of keeping the lag.
    const samples = [feed("main", { main: true, latency: 9, edge: 4 })];
    expect(liveSyncTargetLatencySeconds(samples, NOW, null)).toBeCloseTo(
      9 - 4 + LIVE_SYNC_BASE_HOLD_SECONDS,
      5,
    );
  });

  test("moves back when a secondary feed cannot reach the main position", () => {
    // This feed's live edge is still 12s behind wall clock, so nobody can be
    // aligned in front of it: the whole grid has to wait for it.
    const samples = [
      feed("main", { main: true, latency: 4 }),
      feed("slow", { latency: 14, edge: 2 }),
    ];
    const target = liveSyncTargetLatencySeconds(samples, NOW, null);
    expect(target).not.toBeNull();
    expect(target!).toBeGreaterThan(12);
  });

  test("releases a large target only gradually", () => {
    const samples = [feed("main", { main: true, latency: 4 })];
    const target = liveSyncTargetLatencySeconds(samples, NOW, 20);
    expect(target).toBeCloseTo(20 - LIVE_SYNC_TARGET_RELEASE_SECONDS, 5);
  });

  test("moves back far enough for a feed asked to run ahead of the group", () => {
    const samples = [
      feed("main", { main: true, latency: 5 }),
      feed("early", { latency: 5, offset: -4 }),
    ];
    const target = liveSyncTargetLatencySeconds(samples, NOW, null);
    // The early feed must still be able to reach `target - 4`.
    expect(target).not.toBeNull();
    expect(target!).toBeGreaterThanOrEqual(5 - 1 + 4);
  });

  test("stays inside the documented bounds", () => {
    const samples = [feed("main", { main: true, latency: 600 })];
    expect(liveSyncTargetLatencySeconds(samples, NOW, null)).toBe(
      LIVE_SYNC_MAX_TARGET_LATENCY_SECONDS,
    );
  });

  test("has no target while every feed is still starting", () => {
    expect(liveSyncTargetLatencySeconds([feed("a", { latency: 3, ready: false })], NOW, null)).toBe(
      null,
    );
  });
});

describe("live sync planning", () => {
  test("off leaves every feed untouched", () => {
    const plan = planLiveSync({
      mode: "off",
      samples: [feed("a", { latency: 3 })],
      nowMs: NOW,
      previousTargetSeconds: null,
    });
    expect(plan.targetLatencySeconds).toBeNull();
    expect(plan.feeds[0]?.action).toEqual({ kind: "hold", rate: 1 });
  });

  test("manual holds each feed behind its own live edge", () => {
    const plan = planLiveSync({
      mode: "manual",
      samples: [feed("a", { latency: 3, edge: 6 })],
      nowMs: NOW,
      previousTargetSeconds: null,
    });
    const action = plan.feeds[0]?.action;
    expect(action?.kind).toBe("seek");
    // 120 + 6 (live edge) - 1.2 (base hold)
    expect(action?.kind === "seek" ? action.mediaTime : null).toBeCloseTo(
      126 - LIVE_SYNC_BASE_HOLD_SECONDS,
      5,
    );
  });

  test("manual adds the user offset on top of the base hold", () => {
    const plan = planLiveSync({
      mode: "manual",
      samples: [feed("a", { latency: 3, edge: 12, offset: 4 })],
      nowMs: NOW,
      previousTargetSeconds: null,
    });
    const action = plan.feeds[0]?.action;
    // 120 + 12 (live edge) - 1.2 (base hold) - 4 (offset)
    expect(action?.kind === "seek" ? action.mediaTime : null).toBeCloseTo(
      132 - LIVE_SYNC_BASE_HOLD_SECONDS - 4,
      5,
    );
  });

  test("auto seeks a far-ahead secondary feed back onto the shared clock", () => {
    const plan = planLiveSync({
      mode: "auto",
      samples: [feed("main", { main: true, latency: 9 }), feed("fast", { latency: 3 })],
      nowMs: NOW,
      previousTargetSeconds: null,
    });
    const target = 9 - 1 + LIVE_SYNC_BASE_HOLD_SECONDS;
    expect(plan.targetLatencySeconds).toBeCloseTo(target, 5);
    const fast = plan.feeds.find((entry) => entry.key === "fast");
    expect(fast?.action.kind).toBe("seek");
    // Delaying by `target - 3` seconds means playing that much earlier.
    expect(fast?.action.kind === "seek" ? fast.action.mediaTime : null).toBeCloseTo(
      120 - (target - 3),
      5,
    );
    expect(fast?.errorSeconds).toBeCloseTo(3 - target, 5);
  });

  test("auto trims the rate of a muted feed for a small error", () => {
    const plan = planLiveSync({
      mode: "auto",
      samples: [feed("main", { main: true, latency: 6 }), feed("b", { latency: 5.2 })],
      nowMs: NOW,
      previousTargetSeconds: null,
    });
    const secondary = plan.feeds.find((entry) => entry.key === "b");
    expect(secondary?.action).toEqual({ kind: "rate", rate: 1 - LIVE_SYNC_RATE_TRIM });
  });

  test("never rate-trims the audible main feed", () => {
    const plan = planLiveSync({
      mode: "auto",
      samples: [feed("main", { main: true, latency: 6 }), feed("slow", { latency: 6.9, edge: 3 })],
      nowMs: NOW,
      previousTargetSeconds: null,
    });
    const main = plan.feeds.find((entry) => entry.key === "main");
    expect(main?.action.kind).not.toBe("rate");
  });

  test("keeps a feed inside tolerance idle", () => {
    const plan = planLiveSync({
      mode: "auto",
      samples: [feed("main", { main: true, latency: 6 }), feed("b", { latency: 6.1 })],
      nowMs: NOW,
      previousTargetSeconds: null,
    });
    expect(plan.feeds.find((entry) => entry.key === "b")?.action).toEqual({
      kind: "hold",
      rate: 1,
    });
  });

  test("flags a feed whose retained buffer cannot reach the target", () => {
    const plan = planLiveSync({
      mode: "auto",
      samples: [
        feed("main", { main: true, latency: 30 }),
        feed("shallow", { latency: 4, backBuffer: 3 }),
      ],
      nowMs: NOW,
      previousTargetSeconds: null,
    });
    const shallow = plan.feeds.find((entry) => entry.key === "shallow");
    expect(shallow?.limited).toBe(true);
    expect(shallow?.action.kind).toBe("seek");
  });

  test("falls back to the manual hold for a feed without a clock", () => {
    const plan = planLiveSync({
      mode: "auto",
      samples: [
        feed("main", { main: true, latency: 6 }),
        feed("blind", { latency: 6, edge: 6, clock: "none" }),
      ],
      nowMs: NOW,
      previousTargetSeconds: null,
    });
    const blind = plan.feeds.find((entry) => entry.key === "blind");
    expect(blind?.clockKind).toBe("none");
    expect(blind?.action.kind).toBe("seek");
    expect(blind?.holdSeconds).toBeCloseTo(LIVE_SYNC_BASE_HOLD_SECONDS, 5);
  });

  test("skips a feed that is not playing yet", () => {
    const plan = planLiveSync({
      mode: "auto",
      samples: [feed("a", { latency: 3, ready: false })],
      nowMs: NOW,
      previousTargetSeconds: null,
    });
    expect(plan.feeds[0]?.action).toEqual({ kind: "hold", rate: 1 });
    expect(plan.feeds[0]?.holdSeconds).toBeNull();
  });
});

describe("manual one-shot alignment", () => {
  test("delays the faster feeds by the amount their stream runs ahead", () => {
    const offsets = liveSyncManualAlignOffsets(
      [
        feed("slow", { latency: 12, edge: 2 }),
        feed("fast", { latency: 4, edge: 2 }),
        feed("blind", { latency: 4, clock: "none" }),
      ],
      NOW,
    );
    expect(offsets.slow).toBe(0);
    expect(offsets.fast).toBe(8);
    expect(offsets.blind).toBeUndefined();
  });
});

describe("live sync presentation", () => {
  test("names the clock quality of each protocol path", () => {
    expect(liveSyncClockLabel("program-date")).toBe("精确时钟");
    expect(liveSyncClockLabel("stream-anchor")).toBe("估算时钟");
    expect(liveSyncClockLabel("none")).toBe("无时钟基准");
  });

  test("summarizes hold, drift and buffer limits in one line", () => {
    expect(
      liveSyncFeedStatusText({
        clockKind: "stream-anchor",
        errorSeconds: -1.2,
        holdSeconds: 5.25,
        limited: true,
      }),
    ).toBe("估算时钟 · 延后 5.3s · 偏差 -1.2s · 缓冲不足，已就近对齐");
    expect(liveSyncFeedStatusText(null)).toBe("等待画面就绪");
  });

  test("delays danmaku only by the hold the alignment added", () => {
    expect(liveSyncDanmakuDelayMs(null)).toBe(0);
    expect(
      liveSyncDanmakuDelayMs({
        clockKind: "program-date",
        errorSeconds: 0,
        holdSeconds: LIVE_SYNC_BASE_HOLD_SECONDS,
        limited: false,
      }),
    ).toBe(0);
    expect(
      liveSyncDanmakuDelayMs({
        clockKind: "program-date",
        errorSeconds: 0,
        holdSeconds: LIVE_SYNC_BASE_HOLD_SECONDS + 4,
        limited: false,
      }),
    ).toBe(4_000);
  });

  test("quantizes the danmaku delay so a drifting hold does not churn", () => {
    const delay = (hold: number) =>
      liveSyncDanmakuDelayMs({
        clockKind: "program-date",
        errorSeconds: 0,
        holdSeconds: LIVE_SYNC_BASE_HOLD_SECONDS + hold,
        limited: false,
      });
    expect(delay(4.1)).toBe(4_000);
    expect(delay(4.3)).toBe(4_500);
    expect(delay(4.4)).toBe(4_500);
  });
});

describe("sync-hold transport options", () => {
  test("keeps today's chasing profile while the alignment is off", () => {
    const flv = liveFlvPlaybackOptions(false) as { mpegtsConfig: Record<string, unknown> };
    expect(flv.mpegtsConfig.liveBufferLatencyChasing).toBe(true);
    expect(flv.mpegtsConfig.autoCleanupMinBackwardDuration).toBe(8);
  });

  test("disables chasing and widens the backward window under the alignment", () => {
    const flv = liveFlvPlaybackOptions(false, true) as { mpegtsConfig: Record<string, unknown> };
    expect(flv.mpegtsConfig.liveBufferLatencyChasing).toBe(false);
    expect(flv.mpegtsConfig.autoCleanupMinBackwardDuration).toBe(
      LIVE_SYNC_HOLD_MIN_BACKWARD_SECONDS,
    );
    const mpegts = liveMpegtsPlaybackOptions(true) as { mpegtsConfig: Record<string, unknown> };
    expect(mpegts.mpegtsConfig.liveBufferLatencyChasing).toBe(false);
  });

  test("stops hls.js from jumping back to the live edge or dropping the back buffer", () => {
    const relaxed = liveHlsPlaybackOptions(false);
    expect(relaxed.liveMaxLatencyDurationCount).toBe(6);
    const held = liveHlsPlaybackOptions(true);
    expect(Number(held.liveMaxLatencyDurationCount)).toBeGreaterThan(60);
    expect(Number(held.backBufferLength)).toBeGreaterThanOrEqual(
      LIVE_SYNC_HOLD_MIN_BACKWARD_SECONDS,
    );
    expect(held.maxLiveSyncPlaybackRate).toBe(1);
  });
});

describe("sync offset bookkeeping", () => {
  test("drops offsets whose room has left the grid", () => {
    const slots = [
      { key: "bilibili\u0000123" } as never,
      null,
    ] as readonly (null | { key: string })[];
    expect(
      pruneMultiRoomSyncOffsets({ "bilibili\u0000123": 2.5, "huya\u00009": 4 }, slots as never),
    ).toEqual({ "bilibili\u0000123": 2.5 });
  });
});

/** Minimal stand-in for one player's imperative sync handle. */
function fakeFeed(sample: LiveSyncSample) {
  const calls: { seeks: number[]; rates: number[] } = { seeks: [], rates: [] };
  return {
    calls,
    api: {
      readTimeline: () => ({
        ready: sample.ready,
        mediaTime: sample.mediaTime,
        bufferStart: sample.bufferStart,
        bufferEnd: sample.bufferEnd,
        clockKind: sample.clockKind,
        epochAtMediaZeroMs: sample.epochAtMediaZeroMs,
        playbackRate: sample.playbackRate,
        paused: !sample.ready,
      }),
      seekMediaTime: (seconds: number) => calls.seeks.push(seconds),
      setPlaybackRate: (rate: number) => calls.rates.push(rate),
    },
  };
}

describe("live sync registry", () => {
  test("applies one correction per feed and publishes its status", () => {
    const registry = createMultiRoomLiveSyncRegistry();
    const main = fakeFeed(feed("main", { main: true, latency: 9 }));
    const fast = fakeFeed(feed("fast", { latency: 3 }));
    registry.registerFeed("main", { main: true, sync: main.api });
    registry.registerFeed("fast", { main: false, sync: fast.api });

    registry.tick({ mode: "auto", offsets: {}, nowMs: NOW });

    const target = 9 - 1 + LIVE_SYNC_BASE_HOLD_SECONDS;
    expect(fast.calls.seeks).toHaveLength(1);
    expect(fast.calls.seeks[0]).toBeCloseTo(120 - (target - 3), 5);
    expect(registry.getSummary()).toMatchObject({ mode: "auto", activeCount: 2 });
    expect(registry.getSummary().targetLatencySeconds).toBeCloseTo(target, 5);
    expect(registry.getFeedStatus("fast")?.errorSeconds).toBeCloseTo(3 - target, 5);
  });

  test("waits out the seek cooldown before correcting the same feed again", () => {
    const registry = createMultiRoomLiveSyncRegistry();
    const fast = fakeFeed(feed("fast", { latency: 3 }));
    registry.registerFeed("main", {
      main: true,
      sync: fakeFeed(feed("main", { main: true, latency: 9 })).api,
    });
    registry.registerFeed("fast", { main: false, sync: fast.api });

    registry.tick({ mode: "auto", offsets: {}, nowMs: NOW });
    registry.tick({ mode: "auto", offsets: {}, nowMs: NOW + 1_000 });
    expect(fast.calls.seeks).toHaveLength(1);
    registry.tick({ mode: "auto", offsets: {}, nowMs: NOW + LIVE_SYNC_SEEK_COOLDOWN_MS + 1 });
    expect(fast.calls.seeks).toHaveLength(2);
  });

  test("notifies a subscriber only when the shown numbers change", () => {
    const registry = createMultiRoomLiveSyncRegistry();
    const feedApi = fakeFeed(feed("a", { main: true, latency: 6 }));
    registry.registerFeed("a", { main: true, sync: feedApi.api });
    let notifications = 0;
    registry.subscribeFeed("a", () => {
      notifications += 1;
    });

    registry.tick({ mode: "auto", offsets: {}, nowMs: NOW });
    registry.tick({ mode: "auto", offsets: {}, nowMs: NOW + 1_000 });
    expect(notifications).toBe(1);
  });

  test("releases every rate trim and status when the alignment stops", () => {
    const registry = createMultiRoomLiveSyncRegistry();
    const secondary = fakeFeed(feed("b", { latency: 5.2 }));
    registry.registerFeed("main", {
      main: true,
      sync: fakeFeed(feed("main", { main: true, latency: 6 })).api,
    });
    registry.registerFeed("b", { main: false, sync: secondary.api });

    registry.tick({ mode: "auto", offsets: {}, nowMs: NOW });
    expect(secondary.calls.rates.at(-1)).toBeCloseTo(1 - LIVE_SYNC_RATE_TRIM, 5);

    registry.reset();
    expect(secondary.calls.rates.at(-1)).toBe(1);
    expect(registry.getFeedStatus("b")).toBeNull();
    expect(registry.getSummary()).toEqual({
      mode: "off",
      targetLatencySeconds: null,
      activeCount: 0,
    });
  });

  test("unregistering a feed restores its rate and clears its status", () => {
    const registry = createMultiRoomLiveSyncRegistry();
    const secondary = fakeFeed(feed("b", { latency: 5.2 }));
    registry.registerFeed("main", {
      main: true,
      sync: fakeFeed(feed("main", { main: true, latency: 6 })).api,
    });
    const unregister = registry.registerFeed("b", { main: false, sync: secondary.api });
    registry.tick({ mode: "auto", offsets: {}, nowMs: NOW });

    unregister();
    expect(secondary.calls.rates.at(-1)).toBe(1);
    expect(registry.getFeedStatus("b")).toBeNull();
  });
});
