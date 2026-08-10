import { describe, expect, test } from "bun:test";
import type { LivePlayQuality, LiveRoomDetail, PlayUrl, SiteId } from "../src/shared/types/live";
import {
  createPlaybackRecoverySession,
  type PlaybackRecoveryClockAdapter,
  type PlaybackRecoveryMetadataAdapter,
  type PlaybackRecoveryPreferenceAdapter,
  type PlaybackRecoverySession,
} from "../src/features/room/playback/playbackRecoverySession";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeClock implements PlaybackRecoveryClockAdapter {
  private currentTime = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.currentTime;
  }

  setTimer(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.currentTime + delayMs, callback });
    return id;
  }

  clearTimer(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advanceBy(durationMs: number): void {
    const target = this.currentTime + durationMs;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.currentTime = timer.at;
      timer.callback();
    }
    this.currentTime = target;
  }

  get pendingCount(): number {
    return this.timers.size;
  }
}

const DETAIL: LiveRoomDetail = {
  site_id: "bilibili",
  room_id: "room-1",
  title: "测试直播间",
  cover: "",
  user_name: "主播",
  user_avatar: "",
  online: 1,
  status: true,
  notice: "",
  url: "https://example.com/room-1",
  raw: {},
};

const QUALITIES: LivePlayQuality[] = [
  { quality: "原画", data: { tier: 0 } },
  { quality: "高清", data: { tier: 1 } },
  { quality: "流畅", data: { tier: 2 } },
];

function linesFor(quality: LivePlayQuality, count = 2): PlayUrl[] {
  return Array.from({ length: count }, (_, index) => ({
    source_id: `${quality.quality}-source-${index}`,
    label: `线路${index + 1}`,
    protocol: "flv" as const,
    url: `https://example.com/${quality.quality}/${index}.flv`,
    headers: {},
  }));
}

type HarnessOptions = {
  siteId?: SiteId;
  qualities?: LivePlayQuality[];
  fetchQualities?: PlaybackRecoveryMetadataAdapter["fetchQualities"];
  fetchLines?: PlaybackRecoveryMetadataAdapter["fetchLines"];
  clock?: FakeClock;
  preferences?: PlaybackRecoveryPreferenceAdapter;
};

function createHarness(options: HarnessOptions = {}) {
  const qualities = options.qualities ?? QUALITIES;
  const clock = options.clock ?? new FakeClock();
  const cacheQualitiesCalls: LivePlayQuality[][] = [];
  const cacheLinesCalls: PlayUrl[][] = [];
  let fetchQualitiesCount = 0;
  let fetchLinesCount = 0;
  const metadata: PlaybackRecoveryMetadataAdapter = {
    fetchQualities: async (input) => {
      fetchQualitiesCount += 1;
      return options.fetchQualities?.(input) ?? qualities;
    },
    fetchLines: async (input) => {
      fetchLinesCount += 1;
      return options.fetchLines?.(input) ?? linesFor(input.quality);
    },
    cacheQualities: (_input, value) => cacheQualitiesCalls.push(value),
    cacheLines: (_input, value) => cacheLinesCalls.push(value),
  };
  const session = createPlaybackRecoverySession(
    {
      siteId: options.siteId ?? "bilibili",
      roomId: DETAIL.room_id,
      detail: { ...DETAIL, site_id: options.siteId ?? "bilibili" },
      qualityLevel: "mid",
      enabled: true,
    },
    { metadata, clock, preferences: options.preferences },
  );
  return {
    session,
    clock,
    cacheQualitiesCalls,
    cacheLinesCalls,
    fetchQualitiesCount: () => fetchQualitiesCount,
    fetchLinesCount: () => fetchLinesCount,
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

function fail(session: PlaybackRecoverySession, epoch: number): void {
  session.acceptTransportFact({
    epoch,
    generation: epoch,
    kind: "error",
    message: "连接中断",
    protocol: "flv",
  });
}

describe("PlaybackRecoverySession", () => {
  test("waits for complete room identity before starting", async () => {
    let qualitiesRequests = 0;
    const metadata: PlaybackRecoveryMetadataAdapter = {
      fetchQualities: async () => {
        qualitiesRequests += 1;
        return QUALITIES;
      },
      fetchLines: async (input) => linesFor(input.quality),
      cacheQualities: () => {},
      cacheLines: () => {},
    };
    const session = createPlaybackRecoverySession(
      {
        siteId: undefined,
        roomId: DETAIL.room_id,
        detail: DETAIL,
        qualityLevel: "mid",
        enabled: true,
      },
      { metadata, clock: new FakeClock() },
    );
    await settle();
    expect(qualitiesRequests).toBe(0);

    session.updateConfig({
      siteId: "bilibili",
      roomId: DETAIL.room_id,
      detail: DETAIL,
      qualityLevel: "mid",
      enabled: true,
    });
    await settle();
    expect(qualitiesRequests).toBe(1);
    expect(session.getSnapshot().playUrl?.source_id).toBe("高清-source-0");
  });

  test("restores quality and remembered line before exposing the first play URL", async () => {
    const exposedSources: (string | undefined)[] = [];
    const preferences: PlaybackRecoveryPreferenceAdapter = {
      read: (roomKey) => ({
        roomKey: roomKey ?? "",
        sourceId: "高清-source-1",
        index: 1,
        updatedAt: 1,
      }),
      remember: () => {},
    };
    const harness = createHarness({ preferences });
    harness.session.subscribe(() => {
      const sourceId = harness.session.getSnapshot().playUrl?.source_id;
      if (sourceId) exposedSources.push(sourceId);
    });

    await settle();

    const snapshot = harness.session.getSnapshot();
    expect(snapshot.qualityIndex).toBe(1);
    expect(snapshot.lineIndex).toBe(1);
    expect(snapshot.playUrl?.source_id).toBe("高清-source-1");
    expect(exposedSources).toEqual(["高清-source-1"]);
    expect(harness.cacheQualitiesCalls).toEqual([QUALITIES]);
    expect(harness.cacheLinesCalls[0]?.map((line) => line.source_id)).toEqual([
      "高清-source-0",
      "高清-source-1",
    ]);
  });

  test("a user line change cancels pending automatic recovery", async () => {
    const remembered: string[] = [];
    const harness = createHarness({
      preferences: {
        read: () => null,
        remember: (_roomKey, line) => {
          if (line?.source_id) remembered.push(line.source_id);
        },
      },
    });
    await settle();

    fail(harness.session, 1);
    fail(harness.session, 2);
    expect(harness.clock.pendingCount).toBe(1);
    expect(harness.session.getSnapshot().reloadToken).toBe(1);

    harness.session.selectLine(1);
    harness.clock.advanceBy(1_000);

    expect(harness.clock.pendingCount).toBe(0);
    expect(harness.session.getSnapshot().lineIndex).toBe(1);
    expect(harness.session.getSnapshot().reloadToken).toBe(1);
    expect(remembered).toEqual(["高清-source-1"]);
  });

  test("an old metadata response cannot overwrite a newer user intent", async () => {
    const staleQualities = deferred<LivePlayQuality[]>();
    let qualitiesRequest = 0;
    const harness = createHarness({
      fetchQualities: async () => {
        qualitiesRequest += 1;
        return qualitiesRequest === 1 ? QUALITIES : staleQualities.promise;
      },
    });
    await settle();

    harness.session.refresh();
    await settle();
    harness.session.selectQuality(2);
    await settle();
    staleQualities.resolve([{ quality: "过期画质", data: null }]);
    await settle();

    const snapshot = harness.session.getSnapshot();
    expect(snapshot.qualityIndex).toBe(2);
    expect(snapshot.qualities).toEqual(QUALITIES);
    expect(snapshot.playUrl?.source_id).toBe("流畅-source-0");
    expect(harness.cacheQualitiesCalls).toEqual([QUALITIES]);
  });

  test("retries the current line within budget and then advances", async () => {
    const harness = createHarness();
    await settle();

    fail(harness.session, 1);
    expect(harness.session.getSnapshot().reloadToken).toBe(1);
    fail(harness.session, 2);
    expect(harness.clock.pendingCount).toBe(1);
    harness.clock.advanceBy(1_000);
    expect(harness.session.getSnapshot().reloadToken).toBe(2);
    fail(harness.session, 3);

    expect(harness.session.getSnapshot().lineIndex).toBe(1);
    expect(harness.session.getSnapshot().playUrl?.source_id).toBe("高清-source-1");
  });

  test("dispose cancels timers and ignores late metadata", async () => {
    const harness = createHarness();
    await settle();
    fail(harness.session, 1);
    fail(harness.session, 2);
    const beforeDispose = harness.session.getSnapshot();
    expect(harness.clock.pendingCount).toBe(1);

    harness.session.dispose();
    harness.clock.advanceBy(1_000);
    expect(harness.clock.pendingCount).toBe(0);
    expect(harness.session.getSnapshot()).toBe(beforeDispose);

    const lateQualities = deferred<LivePlayQuality[]>();
    const lateHarness = createHarness({ fetchQualities: () => lateQualities.promise });
    lateHarness.session.dispose();
    lateQualities.resolve(QUALITIES);
    await settle();
    expect(lateHarness.cacheQualitiesCalls).toHaveLength(0);
    expect(lateHarness.fetchLinesCount()).toBe(0);
  });

  test("a Twitch decode failure skips audio-only and selects the next video rendition", async () => {
    const twitchQualities = [
      { quality: "1080p60", data: 0 },
      { quality: "audio_only", data: 1 },
      { quality: "720p", data: 2 },
    ];
    const harness = createHarness({ siteId: "twitch", qualities: twitchQualities });
    await settle();
    expect(harness.session.getSnapshot().qualityIndex).toBe(1);
    harness.session.selectQuality(0);
    await settle();

    harness.session.acceptTransportFact({
      epoch: 1,
      generation: 1,
      kind: "error",
      protocol: "hls",
      decodeError: true,
    });
    await settle();

    expect(harness.session.getSnapshot().qualityIndex).toBe(2);
    expect(harness.session.getSnapshot().playUrl?.source_id).toBe("720p-source-0");
  });

  test("sessions keep timers, retry budgets, and generations isolated", async () => {
    const clock = new FakeClock();
    const left = createHarness({ clock });
    const right = createHarness({ clock });
    await settle();

    fail(left.session, 1);
    fail(left.session, 2);
    fail(right.session, 10);
    fail(right.session, 11);
    expect(clock.pendingCount).toBe(2);

    left.session.selectLine(1);
    expect(clock.pendingCount).toBe(1);
    clock.advanceBy(1_000);

    expect(left.session.getSnapshot().reloadToken).toBe(1);
    expect(left.session.getSnapshot().lineIndex).toBe(1);
    expect(right.session.getSnapshot().reloadToken).toBe(2);
    expect(right.session.getSnapshot().lineIndex).toBe(0);
  });

  test("transport facts drive FLV renewal and Twitch commercial delay", async () => {
    const flv = createHarness();
    await settle();
    flv.session.acceptTransportFact({
      epoch: 1,
      generation: 1,
      kind: "eof",
      protocol: "flv",
    });
    await settle();
    expect(flv.fetchQualitiesCount()).toBe(2);
    expect(flv.session.getSnapshot().reloadToken).toBe(1);

    const hls = createHarness();
    await settle();
    hls.session.acceptTransportFact({
      epoch: 2,
      generation: 2,
      kind: "error",
      protocol: "hls",
      recoveryExhausted: true,
    });
    await settle();
    expect(hls.fetchQualitiesCount()).toBe(2);
    expect(hls.session.getSnapshot().reloadToken).toBe(1);

    const unauthorized = createHarness({ siteId: "twitch" });
    await settle();
    unauthorized.session.acceptTransportFact({
      epoch: 3,
      generation: 3,
      kind: "error",
      protocol: "hls",
      httpStatus: 403,
    });
    await settle();
    expect(unauthorized.fetchQualitiesCount()).toBe(2);
    expect(unauthorized.session.getSnapshot().reloadToken).toBe(1);

    const twitch = createHarness({ siteId: "twitch" });
    await settle();
    twitch.session.acceptTransportFact({
      epoch: 2,
      generation: 2,
      kind: "error",
      protocol: "hls",
      recoveryExhausted: true,
      commercialBreak: true,
      httpStatus: 403,
    });
    expect(twitch.fetchQualitiesCount()).toBe(1);
    expect(twitch.clock.pendingCount).toBe(1);
    twitch.clock.advanceBy(7_999);
    await settle();
    expect(twitch.fetchQualitiesCount()).toBe(1);
    twitch.clock.advanceBy(1);
    await settle();
    expect(twitch.fetchQualitiesCount()).toBe(2);
    expect(twitch.session.getSnapshot().reloadToken).toBe(1);
  });
});
