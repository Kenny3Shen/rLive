import { describe, expect, test } from "bun:test";
import type { LivePlayQuality, LiveRoomDetail, PlayUrl } from "../src/shared/types/live";
import {
  createPlaybackRecoverySession,
  type PlaybackRecoveryClockAdapter,
  type PlaybackRecoveryMetadataAdapter,
  type PlaybackRecoverySession,
} from "../src/features/room/playback/playbackRecoverySession";
import { lowestVideoQualityIndex } from "../src/features/room/playback/quality";

const detail: LiveRoomDetail = {
  site_id: "bilibili",
  room_id: "1000",
  title: "直播间",
  cover: "",
  user_name: "主播",
  user_avatar: "",
  online: 1,
  status: true,
  notice: "",
  url: "https://live.bilibili.com/1000",
  raw: {},
};

const quality: LivePlayQuality = { quality: "原画", data: 10000 };

function flvSource(url = "https://cdn.example/live.flv?token=one"): PlayUrl {
  return {
    source_id: "bilibili:1",
    label: "线路1",
    protocol: "flv",
    priority: 0,
    url,
    headers: { referer: "https://live.bilibili.com" },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 续签退避（1s、2s）用可控时钟推进，测试不真的等待。 */
function manualClock() {
  let now = 1_000;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: PlaybackRecoveryClockAdapter = {
    now: () => now,
    setTimer: (callback, delayMs) => {
      nextId += 1;
      timers.set(nextId, { at: now + delayMs, callback });
      return nextId;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
  };
  const advanceToNext = async () => {
    const entry = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!entry) return false;
    timers.delete(entry[0]);
    now = Math.max(now, entry[1].at);
    entry[1].callback();
    await flush();
    await flush();
    return true;
  };
  /** 只推进挂钟，不触发定时器（用于跨过稳定播放阈值或重复窗口）。 */
  const advance = (ms: number) => {
    now += ms;
  };
  return { clock, advanceToNext, advance, pending: () => timers.size };
}

function sessionWithClock(
  lines: () => PlayUrl[],
  clock: PlaybackRecoveryClockAdapter,
): PlaybackRecoverySession {
  const metadata: PlaybackRecoveryMetadataAdapter = {
    fetchQualities: async () => [quality],
    fetchLines: async () => lines(),
    cacheQualities: () => {},
    cacheLines: () => {},
  };
  const session = createPlaybackRecoverySession(
    {
      siteId: "bilibili",
      roomId: "1000",
      detail: undefined,
      qualityLevel: "high",
      enabled: false,
    },
    { metadata, clock },
  );
  session.updateConfig({
    siteId: "bilibili",
    roomId: "1000",
    detail,
    qualityLevel: "high",
    enabled: true,
  });
  return session;
}

function createSession(lines: () => PlayUrl[]) {
  const metadata: PlaybackRecoveryMetadataAdapter = {
    fetchQualities: async () => [quality],
    fetchLines: async () => lines(),
    cacheQualities: () => {},
    cacheLines: () => {},
  };
  const session = createPlaybackRecoverySession(
    {
      siteId: "bilibili",
      roomId: "1000",
      detail: undefined,
      qualityLevel: "high",
      enabled: false,
    },
    { metadata },
  );
  session.updateConfig({
    siteId: "bilibili",
    roomId: "1000",
    detail,
    qualityLevel: "high",
    enabled: true,
  });
  return session;
}

async function startedSession(lines: () => PlayUrl[]): Promise<PlaybackRecoverySession> {
  const session = createSession(lines);
  await flush();
  await flush();
  return session;
}

describe("播放恢复会话的续期语义", () => {
  test("自动续期只递增 renewToken，不触发表层完整重建", async () => {
    const session = await startedSession(() => [flvSource()]);
    expect(session.getSnapshot().playUrl?.url).toBe("https://cdn.example/live.flv?token=one");

    session.acceptTransportFact({ epoch: 1, generation: 1, kind: "eof", protocol: "flv" });
    await flush();
    await flush();

    const snapshot = session.getSnapshot();
    // 上游关闭后重新取到同一个签名地址：连接必须重开，但不应重建播放器。
    expect(snapshot.renewToken).toBe(1);
    expect(snapshot.reloadToken).toBe(0);
    expect(snapshot.playUrl?.url).toBe("https://cdn.example/live.flv?token=one");
    session.dispose();
  });

  test("手动刷新仍按用户意图完整重建", async () => {
    const session = await startedSession(() => [flvSource()]);
    session.refresh();
    await flush();
    await flush();

    const snapshot = session.getSnapshot();
    expect(snapshot.reloadToken).toBe(1);
    expect(snapshot.renewToken).toBe(0);
    session.dispose();
  });

  test("同线路原地重试使用续期信号", async () => {
    const session = await startedSession(() => [flvSource()]);
    session.acceptTransportFact({
      epoch: 1,
      generation: 1,
      kind: "error",
      protocol: "flv",
      message: "网络中断",
    });
    await flush();

    const snapshot = session.getSnapshot();
    expect(snapshot.renewToken).toBe(1);
    expect(snapshot.reloadToken).toBe(0);
    session.dispose();
  });

  test("FLV 早断流进入既有续签预算并重新取元数据", async () => {
    let linesFetched = 0;
    let qualitiesFetched = 0;
    const clock = manualClock();
    const metadata: PlaybackRecoveryMetadataAdapter = {
      fetchQualities: async () => {
        qualitiesFetched += 1;
        return [quality];
      },
      fetchLines: async () => {
        linesFetched += 1;
        return [flvSource()];
      },
      cacheQualities: () => {},
      cacheLines: () => {},
    };
    const session = createPlaybackRecoverySession(
      {
        siteId: "bilibili",
        roomId: "1000",
        detail: undefined,
        qualityLevel: "high",
        enabled: false,
      },
      { metadata, clock: clock.clock },
    );
    session.updateConfig({
      siteId: "bilibili",
      roomId: "1000",
      detail,
      qualityLevel: "high",
      enabled: true,
    });
    await flush();
    await flush();
    expect(linesFetched).toBe(1);

    // 早断流与正常结束共享同一份续签预算：每次只递增 renewToken 并重取地址。
    session.acceptTransportFact({
      epoch: 1,
      generation: 1,
      kind: "eof",
      protocol: "flv",
      message: "Fetch stream meet Early-EOF",
    });
    await flush();
    await flush();
    expect(session.getSnapshot().renewToken).toBe(1);
    expect(session.getSnapshot().reloadToken).toBe(0);
    expect(linesFetched).toBe(2);
    expect(qualitiesFetched).toBe(2);

    // 第二次续签带 1 秒退避；时钟推进后同样只重取地址。
    session.acceptTransportFact({
      epoch: 2,
      generation: 2,
      kind: "eof",
      protocol: "flv",
      message: "Fetch stream meet Early-EOF",
    });
    expect(session.getSnapshot().renewToken).toBe(1);
    expect(await clock.advanceToNext()).toBe(true);
    expect(session.getSnapshot().renewToken).toBe(2);
    expect(session.getSnapshot().reloadToken).toBe(0);
    expect(linesFetched).toBe(3);
    session.dispose();
  });

  test("早断流续签次数受既有预算约束", async () => {
    const clock = manualClock();
    const session = sessionWithClock(() => [flvSource()], clock.clock);
    await flush();
    await flush();

    session.acceptTransportFact({
      epoch: 1,
      generation: 1,
      kind: "eof",
      protocol: "flv",
      message: "early eof 1",
    });
    await flush();
    await flush();
    expect(session.getSnapshot().renewToken).toBe(1);

    session.acceptTransportFact({
      epoch: 2,
      generation: 2,
      kind: "eof",
      protocol: "flv",
      message: "early eof 2",
    });
    await clock.advanceToNext();
    expect(session.getSnapshot().renewToken).toBe(2);

    session.acceptTransportFact({
      epoch: 3,
      generation: 3,
      kind: "eof",
      protocol: "flv",
      message: "early eof 3",
    });
    await clock.advanceToNext();
    expect(session.getSnapshot().renewToken).toBe(3);

    // 预算耗尽后不再续签，改为对用户可见的失败提示，也不留下定时器。
    session.acceptTransportFact({
      epoch: 4,
      generation: 4,
      kind: "eof",
      protocol: "flv",
      message: "early eof over budget",
    });
    await flush();
    await flush();
    expect(session.getSnapshot().renewToken).toBe(3);
    expect(session.getSnapshot().loadError).toContain("刷新");
    expect(clock.pending()).toBe(0);
    session.dispose();
  });

  test("成功交接新元数据后，同一 generation 的新传输早断仍可续期", async () => {
    const clock = manualClock();
    let linesFetched = 0;
    const metadata: PlaybackRecoveryMetadataAdapter = {
      fetchQualities: async () => [quality],
      fetchLines: async () => {
        linesFetched += 1;
        return [flvSource()];
      },
      cacheQualities: () => {},
      cacheLines: () => {},
    };
    const session = createPlaybackRecoverySession(
      {
        siteId: "bilibili",
        roomId: "1000",
        detail: undefined,
        qualityLevel: "high",
        enabled: false,
      },
      { metadata, clock: clock.clock },
    );
    session.updateConfig({
      siteId: "bilibili",
      roomId: "1000",
      detail,
      qualityLevel: "high",
      enabled: true,
    });
    await flush();
    await flush();
    expect(linesFetched).toBe(1);

    // 第一次早断：立即续期，旧传输的错误事实只描述上一段连接。
    session.acceptTransportFact({
      epoch: 1,
      generation: 1,
      kind: "eof",
      protocol: "flv",
      message: "Fetch stream meet Early-EOF",
    });
    await flush();
    await flush();
    expect(session.getSnapshot().renewToken).toBe(1);

    // 播放器沿用同一 epoch / generation，新连接又在 750 ms 内早断：不能按
    // 「同一 transmission 的重复事件」合并，必须排 1 秒后续期。
    session.acceptTransportFact({
      epoch: 1,
      generation: 1,
      kind: "eof",
      protocol: "flv",
      message: "Fetch stream meet Early-EOF",
    });
    expect(session.getSnapshot().renewToken).toBe(1);
    expect(clock.pending()).toBe(1);
    expect(await clock.advanceToNext()).toBe(true);
    expect(session.getSnapshot().renewToken).toBe(2);
    expect(linesFetched).toBe(3);

    // 第三次仍在既有 3 次预算内，退避 2 秒。
    session.acceptTransportFact({
      epoch: 1,
      generation: 1,
      kind: "eof",
      protocol: "flv",
      message: "Fetch stream meet Early-EOF",
    });
    expect(clock.pending()).toBe(1);
    expect(await clock.advanceToNext()).toBe(true);
    expect(session.getSnapshot().renewToken).toBe(3);
    expect(linesFetched).toBe(4);

    // 第四次耗尽预算：不再续期，给出用户可见提示，也不留下定时器。
    session.acceptTransportFact({
      epoch: 1,
      generation: 1,
      kind: "eof",
      protocol: "flv",
      message: "Fetch stream meet Early-EOF",
    });
    await flush();
    expect(session.getSnapshot().renewToken).toBe(3);
    expect(session.getSnapshot().loadError).toContain("刷新");
    expect(clock.pending()).toBe(0);
    session.dispose();
  });

  test("元数据续期在途时重复失败仍合并", async () => {
    let linesFetched = 0;
    let releaseLines: (() => void) | null = null;
    const metadata: PlaybackRecoveryMetadataAdapter = {
      fetchQualities: async () => [quality],
      fetchLines: async () => {
        linesFetched += 1;
        if (linesFetched === 2) {
          await new Promise<void>((resolve) => {
            releaseLines = resolve;
          });
        }
        return [flvSource()];
      },
      cacheQualities: () => {},
      cacheLines: () => {},
    };
    const session = createPlaybackRecoverySession(
      {
        siteId: "bilibili",
        roomId: "1000",
        detail: undefined,
        qualityLevel: "high",
        enabled: false,
      },
      { metadata },
    );
    session.updateConfig({
      siteId: "bilibili",
      roomId: "1000",
      detail,
      qualityLevel: "high",
      enabled: true,
    });
    await flush();
    await flush();

    session.acceptTransportFact({
      epoch: 1,
      generation: 1,
      kind: "eof",
      protocol: "flv",
      message: "early eof 1",
    });
    await flush();
    expect(linesFetched).toBe(2);
    expect(releaseLines).not.toBeNull();

    // 元数据仍在下发时，同一传输再报失败不能另起一次续期。
    session.acceptTransportFact({
      epoch: 1,
      generation: 1,
      kind: "eof",
      protocol: "flv",
      message: "early eof 2",
    });
    await flush();
    expect(linesFetched).toBe(2);

    (releaseLines as unknown as () => void)();
    await flush();
    await flush();
    expect(session.getSnapshot().renewToken).toBe(1);
    expect(linesFetched).toBe(2);
    session.dispose();
  });

  test("稳定播放后的第一次失败仍能压下同一连接的重复事件", async () => {
    const clock = manualClock();
    const session = sessionWithClock(() => [flvSource()], clock.clock);
    await flush();
    await flush();
    expect(session.getSnapshot().playUrl).not.toBeNull();

    // 播满 30 秒：下一次失败会先清零重试预算。
    session.acceptTransportFact({ epoch: 1, generation: 1, kind: "playing" });
    clock.advance(30_000);
    session.acceptTransportFact({
      epoch: 1,
      generation: 1,
      kind: "error",
      protocol: "flv",
      message: "网络错误",
    });
    expect(session.getSnapshot().renewToken).toBe(1);
    expect(clock.pending()).toBe(0);

    // 同一 epoch / generation / 线路在 750 ms 内再报一次：必须合并，不能把刚
    // 清零的预算烧在第二次重试上。
    session.acceptTransportFact({
      epoch: 1,
      generation: 1,
      kind: "error",
      protocol: "flv",
      message: "网络错误",
    });
    expect(session.getSnapshot().renewToken).toBe(1);
    expect(clock.pending()).toBe(0);

    // 超过 750 ms 后是新的失败事实，预算继续推进到第二次重试。
    clock.advance(800);
    session.acceptTransportFact({
      epoch: 1,
      generation: 1,
      kind: "error",
      protocol: "flv",
      message: "网络错误",
    });
    expect(clock.pending()).toBe(1);
    expect(await clock.advanceToNext()).toBe(true);
    expect(session.getSnapshot().renewToken).toBe(2);
    session.dispose();
  });

  test("MPEG-TS 早断流走普通失败切换而不是元数据续签", async () => {
    let qualitiesFetched = 0;
    const metadata: PlaybackRecoveryMetadataAdapter = {
      fetchQualities: async () => {
        qualitiesFetched += 1;
        return [quality];
      },
      fetchLines: async () => [
        { ...flvSource("https://cdn.example/live.ts?token=one"), protocol: "mpeg_ts" },
      ],
      cacheQualities: () => {},
      cacheLines: () => {},
    };
    const session = createPlaybackRecoverySession(
      {
        siteId: "bilibili",
        roomId: "1000",
        detail: undefined,
        qualityLevel: "high",
        enabled: false,
      },
      { metadata },
    );
    session.updateConfig({
      siteId: "bilibili",
      roomId: "1000",
      detail,
      qualityLevel: "high",
      enabled: true,
    });
    await flush();
    await flush();
    expect(qualitiesFetched).toBe(1);

    session.acceptTransportFact({
      epoch: 1,
      generation: 1,
      kind: "eof",
      protocol: "mpegts",
      message: "Fetch stream meet Early-EOF",
    });
    await flush();
    await flush();

    // 同线路原地重试同样递增 renewToken，但不重取元数据；这是既有失败切换
    // 预算，和 FLV 的续签预算不是同一份。
    expect(session.getSnapshot().renewToken).toBe(1);
    expect(qualitiesFetched).toBe(1);
    session.dispose();
  });

  test("续期后协议变化时退回完整重建", async () => {
    let next: PlayUrl[] = [flvSource()];
    const session = await startedSession(() => next);

    next = [
      {
        ...flvSource("https://cdn.example/live.m3u8?token=two"),
        protocol: "hls",
      },
    ];
    session.acceptTransportFact({ epoch: 1, generation: 1, kind: "eof", protocol: "flv" });
    await flush();
    await flush();

    const snapshot = session.getSnapshot();
    expect(snapshot.playUrl?.protocol).toBe("hls");
    expect(snapshot.reloadToken).toBe(1);
    expect(snapshot.renewToken).toBe(0);
    session.dispose();
  });

  test("解码失败耗完既有线路预算后才发布终止错误", async () => {
    const clock = manualClock();
    const session = sessionWithClock(() => [flvSource()], clock.clock);
    await flush();
    await flush();
    const message = "PipelineStatus::PIPELINE_ERROR_DECODE: video decode error!";
    const decodeFailure = {
      kind: "error" as const,
      protocol: "flv" as const,
      message,
      decodeError: true,
    };

    session.acceptTransportFact({ epoch: 1, generation: 1, ...decodeFailure });
    await flush();
    expect(session.getSnapshot().renewToken).toBe(1);
    expect(session.getSnapshot().loadError).toBeNull();

    session.acceptTransportFact({ epoch: 2, generation: 2, ...decodeFailure });
    expect(await clock.advanceToNext()).toBe(true);
    expect(session.getSnapshot().renewToken).toBe(2);
    expect(session.getSnapshot().loadError).toBeNull();

    session.acceptTransportFact({ epoch: 3, generation: 3, ...decodeFailure });
    await flush();
    expect(session.getSnapshot().renewToken).toBe(2);
    expect(session.getSnapshot().loadError).toContain("PIPELINE_ERROR_DECODE");
    session.dispose();
  });

  test("Twitch 解码失败仍先降低清晰度而不发布终止错误", async () => {
    const qualities: LivePlayQuality[] = [
      { quality: "1080p60", data: 10000 },
      { quality: "720p60", data: 7200 },
    ];
    const metadata: PlaybackRecoveryMetadataAdapter = {
      fetchQualities: async () => qualities,
      fetchLines: async () => [
        {
          ...flvSource("https://cdn.example/live.m3u8?token=one"),
          protocol: "hls",
        },
      ],
      cacheQualities: () => {},
      cacheLines: () => {},
    };
    const session = createPlaybackRecoverySession(
      {
        siteId: "twitch",
        roomId: "1000",
        detail: undefined,
        qualityLevel: "high",
        enabled: false,
      },
      { metadata },
    );
    session.updateConfig({
      siteId: "twitch",
      roomId: "1000",
      detail: { ...detail, site_id: "twitch" },
      qualityLevel: "high",
      enabled: true,
    });
    await flush();
    await flush();
    expect(session.getSnapshot().qualityIndex).toBe(0);

    session.acceptTransportFact({
      epoch: 1,
      generation: 1,
      kind: "error",
      protocol: "hls",
      message: "当前 Twitch 清晰度无法解码",
      decodeError: true,
    });
    await flush();
    await flush();

    const snapshot = session.getSnapshot();
    expect(snapshot.qualityIndex).toBe(1);
    expect(snapshot.qualities[snapshot.qualityIndex]?.quality).toBe("720p60");
    expect(snapshot.playUrl?.protocol).toBe("hls");
    expect(snapshot.loadError).toBeNull();
    session.dispose();
  });
});

describe("默认清晰度在恢复预算耗尽后自动降档", () => {
  const tiers: LivePlayQuality[] = [
    { quality: "4K", data: { bitRate: 20000 } },
    { quality: "超清", data: { bitRate: 2000 } },
  ];

  /** 虎牙房间：FLV 插件内部已重试，`playerRebuildRetryLimit` 为 1。 */
  async function huyaSession(clock: PlaybackRecoveryClockAdapter) {
    const requested: string[] = [];
    const metadata: PlaybackRecoveryMetadataAdapter = {
      fetchQualities: async () => tiers,
      fetchLines: async ({ quality: tier }) => {
        requested.push(tier.quality);
        return [{ ...flvSource(`https://cdn.example/${tier.quality}.flv`), source_id: "huya:TX" }];
      },
      cacheQualities: () => {},
      cacheLines: () => {},
    };
    const config = {
      siteId: "huya" as const,
      roomId: "660000",
      qualityLevel: "high" as const,
    };
    const session = createPlaybackRecoverySession(
      { ...config, detail: undefined, enabled: false },
      { metadata, clock },
    );
    session.updateConfig({
      ...config,
      detail: { ...detail, site_id: "huya", room_id: "660000" },
      enabled: true,
    });
    await flush();
    await flush();
    return { session, requested };
  }

  const http403 = (epoch: number) => ({
    epoch,
    generation: epoch,
    kind: "error" as const,
    protocol: "flv" as const,
    message: "HttpStatusCodeInvalid 403",
  });

  test("线路全部失败后换到下一档，而不是发布终止错误", async () => {
    const clock = manualClock();
    const { session, requested } = await huyaSession(clock.clock);
    expect(session.getSnapshot().qualityIndex).toBe(0);

    session.acceptTransportFact(http403(1));
    await flush();
    expect(session.getSnapshot().renewToken).toBe(1);

    session.acceptTransportFact(http403(2));
    await flush();
    await flush();

    const snapshot = session.getSnapshot();
    expect(snapshot.qualityIndex).toBe(1);
    expect(snapshot.playUrl?.url).toBe("https://cdn.example/超清.flv");
    expect(snapshot.loadError).toBeNull();
    expect(requested).toEqual(["4K", "超清"]);
    session.dispose();
  });

  test("续签预算耗尽后换到下一档，最低档仍失败才报错", async () => {
    const clock = manualClock();
    const { session } = await huyaSession(clock.clock);
    const earlyEof = (epoch: number) => ({
      epoch,
      generation: epoch,
      kind: "eof" as const,
      protocol: "flv" as const,
      message: "Fetch stream meet Early-EOF",
    });

    let epoch = 0;
    const drainRenewals = async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        session.acceptTransportFact(earlyEof(++epoch));
        await flush();
        await flush();
        while (await clock.advanceToNext()) {}
      }
      session.acceptTransportFact(earlyEof(++epoch));
      await flush();
      await flush();
    };

    await drainRenewals();
    expect(session.getSnapshot().qualityIndex).toBe(1);
    expect(session.getSnapshot().loadError).toBeNull();

    await drainRenewals();
    expect(session.getSnapshot().qualityIndex).toBe(1);
    expect(session.getSnapshot().loadError).toContain("刷新");
    expect(clock.pending()).toBe(0);
    session.dispose();
  });

  test("用户手动选的清晰度不自动降档", async () => {
    const clock = manualClock();
    const { session } = await huyaSession(clock.clock);
    session.selectQuality(0);
    await flush();
    await flush();

    session.acceptTransportFact(http403(1));
    await flush();
    session.acceptTransportFact(http403(2));
    await flush();

    expect(session.getSnapshot().qualityIndex).toBe(0);
    expect(session.getSnapshot().loadError).toContain("403");
    session.dispose();
  });
});

describe("多画面节能画质策略", () => {
  const tiers: LivePlayQuality[] = [
    { quality: "4K", data: 20_000 },
    { quality: "1080p", data: 8_000 },
    { quality: "720p", data: 3_000 },
    { quality: "audio only", data: 128 },
  ];

  function energySession(preferLowestQuality = false) {
    const requested: string[] = [];
    const metadata: PlaybackRecoveryMetadataAdapter = {
      fetchQualities: async () => tiers,
      fetchLines: async ({ quality: tier }) => {
        requested.push(tier.quality);
        return [{ ...flvSource(`https://cdn.example/${tier.quality}.flv`), protocol: "hls" }];
      },
      cacheQualities: () => {},
      cacheLines: () => {},
    };
    const config = {
      siteId: "twitch" as const,
      roomId: "1000",
      detail: { ...detail, site_id: "twitch" as const },
      qualityLevel: "high" as const,
      preferLowestQuality,
      enabled: true,
    };
    const session = createPlaybackRecoverySession(config, { metadata });
    return { session, requested, config };
  }

  test("首次拉流直接选择最低视频档，关闭节能或升主后恢复默认画质", async () => {
    const { session, requested, config } = energySession(true);
    await flush();
    await flush();

    expect(session.getSnapshot().qualityIndex).toBe(2);
    expect(session.getSnapshot().qualities[2]?.quality).toBe("720p");
    expect(requested).toEqual(["720p"]);

    session.updateConfig({ ...config, preferLowestQuality: false });
    await flush();
    await flush();
    expect(session.getSnapshot().qualities[session.getSnapshot().qualityIndex]?.quality).toBe("4K");
    expect(requested).toEqual(["720p", "4K"]);
    session.dispose();
  });

  test("节能状态下忽略过期画质菜单回调，关闭后恢复正常选择", async () => {
    const { session, requested, config } = energySession(true);
    await flush();
    await flush();

    session.selectQuality(0);
    await flush();
    await flush();
    expect(session.getSnapshot().qualities[session.getSnapshot().qualityIndex]?.quality).toBe(
      "720p",
    );
    expect(requested).toEqual(["720p"]);

    session.updateConfig({ ...config, preferLowestQuality: false });
    await flush();
    await flush();
    expect(session.getSnapshot().qualities[session.getSnapshot().qualityIndex]?.quality).toBe("4K");
    expect(requested).toEqual(["720p", "4K"]);
    session.dispose();
  });

  function expandedQualitiesSession() {
    let qualityFetches = 0;
    const requested: string[] = [];
    const initialQualities: LivePlayQuality[] = [tiers[0], tiers[2]];
    const expandedQualities: LivePlayQuality[] = [
      tiers[0],
      tiers[2],
      { quality: "360p", data: 900 },
      tiers[3],
    ];
    const metadata: PlaybackRecoveryMetadataAdapter = {
      fetchQualities: async () => {
        qualityFetches += 1;
        return qualityFetches === 1 ? initialQualities : expandedQualities;
      },
      fetchLines: async ({ quality: tier }) => {
        requested.push(tier.quality);
        return [{ ...flvSource(`https://cdn.example/${tier.quality}.flv`), protocol: "hls" }];
      },
      cacheQualities: () => {},
      cacheLines: () => {},
    };
    const config = {
      siteId: "twitch" as const,
      roomId: "1000",
      detail: { ...detail, site_id: "twitch" as const },
      qualityLevel: "high" as const,
      preferLowestQuality: true,
      enabled: true,
    };
    const session = createPlaybackRecoverySession(config, { metadata });
    return { session, requested };
  }

  test("手动刷新发现更低视频档时改用新列表的最低档", async () => {
    const { session, requested } = expandedQualitiesSession();
    await flush();
    await flush();
    expect(requested).toEqual(["720p"]);

    session.refresh();
    await flush();
    await flush();
    expect(session.getSnapshot().qualities[session.getSnapshot().qualityIndex]?.quality).toBe(
      "360p",
    );
    expect(requested).toEqual(["720p", "360p"]);
    session.dispose();
  });

  test("自动续期发现更低视频档时改用新列表的最低档", async () => {
    const { session, requested } = expandedQualitiesSession();
    await flush();
    await flush();
    expect(requested).toEqual(["720p"]);

    session.acceptTransportFact({ epoch: 1, generation: 1, kind: "eof", protocol: "flv" });
    await flush();
    await flush();
    expect(session.getSnapshot().qualities[session.getSnapshot().qualityIndex]?.quality).toBe(
      "360p",
    );
    expect(requested).toEqual(["720p", "360p"]);
    session.dispose();
  });

  test("关闭节能恢复用户此前的手动画质，自动续期仍保持最低视频档", async () => {
    const { session, requested, config } = energySession();
    await flush();
    await flush();

    session.selectQuality(1);
    await flush();
    await flush();
    expect(session.getSnapshot().qualities[session.getSnapshot().qualityIndex]?.quality).toBe(
      "1080p",
    );

    session.updateConfig({ ...config, preferLowestQuality: true });
    await flush();
    await flush();
    expect(session.getSnapshot().qualities[session.getSnapshot().qualityIndex]?.quality).toBe(
      "720p",
    );

    session.acceptTransportFact({ epoch: 1, generation: 1, kind: "eof", protocol: "flv" });
    await flush();
    await flush();
    expect(session.getSnapshot().qualities[session.getSnapshot().qualityIndex]?.quality).toBe(
      "720p",
    );

    session.updateConfig({ ...config, preferLowestQuality: false });
    await flush();
    await flush();
    expect(session.getSnapshot().qualities[session.getSnapshot().qualityIndex]?.quality).toBe(
      "1080p",
    );
    expect(requested).toEqual(["4K", "1080p", "720p", "720p", "1080p"]);
    session.dispose();
  });

  test("在途切换以最后一次节能状态为准，旧清晰度结果不会覆盖", async () => {
    type ResolveLines = (lines: PlayUrl[]) => void;
    const pending = new Map<string, ResolveLines[]>();
    const metadata: PlaybackRecoveryMetadataAdapter = {
      fetchQualities: async () => tiers,
      fetchLines: ({ quality: tier }) =>
        new Promise((resolve) => {
          const resolvers = pending.get(tier.quality) ?? [];
          resolvers.push(resolve);
          pending.set(tier.quality, resolvers);
        }),
      cacheQualities: () => {},
      cacheLines: () => {},
    };
    const config = {
      siteId: "twitch" as const,
      roomId: "1000",
      detail: { ...detail, site_id: "twitch" as const },
      qualityLevel: "high" as const,
      enabled: true,
    };
    const session = createPlaybackRecoverySession(config, { metadata });
    await flush();
    await flush();

    session.updateConfig({ ...config, preferLowestQuality: true });
    await flush();
    session.updateConfig({ ...config, preferLowestQuality: false });
    await flush();

    const resolve = (tier: string, url: string) => {
      pending.get(tier)?.shift()?.([{ ...flvSource(url), protocol: "hls" }]);
    };
    resolve("4K", "https://cdn.example/stale-4k.m3u8");
    resolve("720p", "https://cdn.example/stale-720p.m3u8");
    await flush();
    await flush();
    expect(session.getSnapshot().playUrl).toBeNull();

    resolve("4K", "https://cdn.example/normal-4k.m3u8");
    await flush();
    await flush();
    expect(session.getSnapshot().qualityIndex).toBe(0);
    expect(session.getSnapshot().playUrl?.url).toBe("https://cdn.example/normal-4k.m3u8");
    session.dispose();
  });

  test("同下标刷新在途时开启节能，会按新列表重启并提交最低档", async () => {
    type ResolveLines = (lines: PlayUrl[]) => void;
    const initialQualities: LivePlayQuality[] = [tiers[0], tiers[2]];
    const expandedQualities: LivePlayQuality[] = [
      tiers[0],
      tiers[2],
      { quality: "360p", data: 900 },
      tiers[3],
    ];
    let qualityFetches = 0;
    let holdRefresh720 = false;
    const pending720: ResolveLines[] = [];
    const requested: string[] = [];
    const metadata: PlaybackRecoveryMetadataAdapter = {
      fetchQualities: async () => {
        qualityFetches += 1;
        return qualityFetches === 1 ? initialQualities : expandedQualities;
      },
      fetchLines: ({ quality: tier }) => {
        requested.push(tier.quality);
        if (holdRefresh720 && tier.quality === "720p") {
          return new Promise((resolve) => pending720.push(resolve));
        }
        return Promise.resolve([
          { ...flvSource(`https://cdn.example/${tier.quality}.flv`), protocol: "hls" as const },
        ]);
      },
      cacheQualities: () => {},
      cacheLines: () => {},
    };
    const config = {
      siteId: "twitch" as const,
      roomId: "1000",
      detail: { ...detail, site_id: "twitch" as const },
      qualityLevel: "high" as const,
      enabled: true,
    };
    const session = createPlaybackRecoverySession(config, { metadata });
    await flush();
    await flush();
    session.selectQuality(1);
    await flush();
    await flush();
    expect(session.getSnapshot().qualities[session.getSnapshot().qualityIndex]?.quality).toBe(
      "720p",
    );

    holdRefresh720 = true;
    session.refresh();
    await flush();
    await flush();
    expect(pending720).toHaveLength(1);

    session.updateConfig({ ...config, preferLowestQuality: true });
    await flush();
    await flush();
    expect(qualityFetches).toBe(3);
    expect(session.getSnapshot().qualities[session.getSnapshot().qualityIndex]?.quality).toBe(
      "360p",
    );
    expect(session.getSnapshot().playUrl?.url).toBe("https://cdn.example/360p.flv");

    pending720.shift()?.([{ ...flvSource("https://cdn.example/stale-720p.flv"), protocol: "hls" }]);
    await flush();
    await flush();
    expect(session.getSnapshot().playUrl?.url).toBe("https://cdn.example/360p.flv");
    expect(requested).toEqual(["4K", "720p", "720p", "360p"]);
    session.dispose();
  });

  test("刷新取流在途时关闭节能，重新刷新会恢复默认正常画质", async () => {
    type ResolveLines = (lines: PlayUrl[]) => void;
    let holdLines = false;
    const pending720: ResolveLines[] = [];
    const requested: string[] = [];
    const metadata: PlaybackRecoveryMetadataAdapter = {
      fetchQualities: async () => tiers,
      fetchLines: ({ quality: tier }) => {
        requested.push(tier.quality);
        if (holdLines && tier.quality === "720p") {
          return new Promise((resolve) => pending720.push(resolve));
        }
        return Promise.resolve([
          { ...flvSource(`https://cdn.example/${tier.quality}.flv`), protocol: "hls" as const },
        ]);
      },
      cacheQualities: () => {},
      cacheLines: () => {},
    };
    const config = {
      siteId: "twitch" as const,
      roomId: "1000",
      detail: { ...detail, site_id: "twitch" as const },
      qualityLevel: "high" as const,
      preferLowestQuality: true,
      enabled: true,
    };
    const session = createPlaybackRecoverySession(config, { metadata });
    await flush();
    await flush();
    expect(session.getSnapshot().qualities[session.getSnapshot().qualityIndex]?.quality).toBe(
      "720p",
    );

    holdLines = true;
    session.refresh();
    await flush();
    await flush();
    expect(pending720).toHaveLength(1);

    session.updateConfig({ ...config, preferLowestQuality: false });
    await flush();
    await flush();
    expect(session.getSnapshot().qualities[session.getSnapshot().qualityIndex]?.quality).toBe("4K");
    expect(requested).toEqual(["720p", "720p", "4K"]);

    pending720.shift()?.([{ ...flvSource("https://cdn.example/stale-720p.flv"), protocol: "hls" }]);
    await flush();
    await flush();
    expect(session.getSnapshot().qualities[session.getSnapshot().qualityIndex]?.quality).toBe("4K");
    session.dispose();
  });

  test("刷新在途连续双向切换仍恢复原手动画质并忽略旧结果", async () => {
    type PendingLines = { quality: string; resolve: (lines: PlayUrl[]) => void };
    let holdLines = false;
    const pending: PendingLines[] = [];
    const requested: string[] = [];
    const metadata: PlaybackRecoveryMetadataAdapter = {
      fetchQualities: async () => tiers,
      fetchLines: ({ quality: tier }) => {
        requested.push(tier.quality);
        if (holdLines) {
          return new Promise((resolve) => pending.push({ quality: tier.quality, resolve }));
        }
        return Promise.resolve([
          { ...flvSource(`https://cdn.example/${tier.quality}.flv`), protocol: "hls" as const },
        ]);
      },
      cacheQualities: () => {},
      cacheLines: () => {},
    };
    const normalConfig = {
      siteId: "twitch" as const,
      roomId: "1000",
      detail: { ...detail, site_id: "twitch" as const },
      qualityLevel: "high" as const,
      preferLowestQuality: false,
      enabled: true,
    };
    const session = createPlaybackRecoverySession(normalConfig, { metadata });
    await flush();
    await flush();
    session.selectQuality(1);
    await flush();
    await flush();
    session.updateConfig({ ...normalConfig, preferLowestQuality: true });
    await flush();
    await flush();

    holdLines = true;
    session.refresh();
    await flush();
    await flush();
    session.updateConfig({ ...normalConfig, preferLowestQuality: false });
    await flush();
    await flush();
    session.updateConfig({ ...normalConfig, preferLowestQuality: true });
    await flush();
    await flush();
    session.updateConfig({ ...normalConfig, preferLowestQuality: false });
    await flush();
    await flush();

    expect(pending.map(({ quality }) => quality)).toEqual(["720p", "1080p", "720p", "1080p"]);
    const final = pending.at(-1);
    final?.resolve([{ ...flvSource("https://cdn.example/final-1080p.flv"), protocol: "hls" }]);
    await flush();
    await flush();
    expect(session.getSnapshot().qualities[session.getSnapshot().qualityIndex]?.quality).toBe(
      "1080p",
    );
    expect(session.getSnapshot().playUrl?.url).toBe("https://cdn.example/final-1080p.flv");

    for (const stale of pending.slice(0, -1)) {
      stale.resolve([
        { ...flvSource(`https://cdn.example/stale-${stale.quality}.flv`), protocol: "hls" },
      ]);
    }
    await flush();
    await flush();
    expect(session.getSnapshot().qualities[session.getSnapshot().qualityIndex]?.quality).toBe(
      "1080p",
    );
    expect(session.getSnapshot().playUrl?.url).toBe("https://cdn.example/final-1080p.flv");
    expect(requested).toEqual(["4K", "1080p", "720p", "720p", "1080p", "720p", "1080p"]);
    session.dispose();
  });

  test("单档取流在途切换节能不会作废唯一请求或停在加载态", async () => {
    type ResolveLines = (lines: PlayUrl[]) => void;
    const singleQuality: LivePlayQuality[] = [{ quality: "720p", data: 3_000 }];
    let resolveLines: ResolveLines | null = null;
    let linesFetched = 0;
    const metadata: PlaybackRecoveryMetadataAdapter = {
      fetchQualities: async () => singleQuality,
      fetchLines: () => {
        linesFetched += 1;
        return new Promise((resolve) => {
          resolveLines = resolve;
        });
      },
      cacheQualities: () => {},
      cacheLines: () => {},
    };
    const config = {
      siteId: "twitch" as const,
      roomId: "1000",
      detail: { ...detail, site_id: "twitch" as const },
      qualityLevel: "high" as const,
      enabled: true,
    };
    const session = createPlaybackRecoverySession(config, { metadata });
    await flush();
    await flush();
    expect(resolveLines).not.toBeNull();

    session.updateConfig({ ...config, preferLowestQuality: true });
    await flush();
    session.updateConfig({ ...config, preferLowestQuality: false });
    await flush();
    expect(linesFetched).toBe(1);
    expect(session.getSnapshot().loading).toBe(true);

    (resolveLines as unknown as ResolveLines)([
      { ...flvSource("https://cdn.example/only-720p.flv"), protocol: "hls" },
    ]);
    await flush();
    await flush();
    expect(session.getSnapshot().loading).toBe(false);
    expect(session.getSnapshot().playUrl?.url).toBe("https://cdn.example/only-720p.flv");
    expect(linesFetched).toBe(1);
    session.dispose();
  });

  test("最低档手动选档在途同档切换与过期线路回调不会取消取流", async () => {
    type ResolveLines = (lines: PlayUrl[]) => void;
    let resolveLines: ResolveLines | null = null;
    let linesFetched = 0;
    const metadata: PlaybackRecoveryMetadataAdapter = {
      fetchQualities: async () => tiers,
      fetchLines: ({ quality: tier }) => {
        linesFetched += 1;
        if (tier.quality === "720p") {
          return new Promise((resolve) => {
            resolveLines = resolve;
          });
        }
        return Promise.resolve([
          { ...flvSource(`https://cdn.example/${tier.quality}.flv`), protocol: "hls" as const },
        ]);
      },
      cacheQualities: () => {},
      cacheLines: () => {},
    };
    const config = {
      siteId: "twitch" as const,
      roomId: "1000",
      detail: { ...detail, site_id: "twitch" as const },
      qualityLevel: "high" as const,
      enabled: true,
    };
    const session = createPlaybackRecoverySession(config, { metadata });
    await flush();
    await flush();

    session.selectQuality(2);
    await flush();
    await flush();
    expect(resolveLines).not.toBeNull();
    expect(linesFetched).toBe(2);

    session.updateConfig({ ...config, preferLowestQuality: true });
    await flush();
    session.selectLine(0);
    await flush();
    session.updateConfig({ ...config, preferLowestQuality: false });
    await flush();
    expect(linesFetched).toBe(2);
    expect(session.getSnapshot().loading).toBe(true);

    (resolveLines as unknown as ResolveLines)([
      { ...flvSource("https://cdn.example/manual-720p.flv"), protocol: "hls" },
    ]);
    await flush();
    await flush();
    expect(session.getSnapshot().loading).toBe(false);
    expect(session.getSnapshot().qualities[session.getSnapshot().qualityIndex]?.quality).toBe(
      "720p",
    );
    expect(session.getSnapshot().playUrl?.url).toBe("https://cdn.example/manual-720p.flv");
    expect(linesFetched).toBe(2);
    session.dispose();
  });

  test("普通刷新匹配不到原画质时保留原顺序位置作为 fallback", async () => {
    const initialQualities: LivePlayQuality[] = [tiers[0], tiers[1], tiers[2]];
    const renamedQualities: LivePlayQuality[] = [
      { quality: "A", data: 20_000 },
      { quality: "B", data: 8_000 },
      { quality: "C", data: 3_000 },
    ];
    let qualityFetches = 0;
    const metadata: PlaybackRecoveryMetadataAdapter = {
      fetchQualities: async () => {
        qualityFetches += 1;
        return qualityFetches === 1 ? initialQualities : renamedQualities;
      },
      fetchLines: async ({ quality: tier }) => [
        { ...flvSource(`https://cdn.example/${tier.quality}.flv`), protocol: "hls" },
      ],
      cacheQualities: () => {},
      cacheLines: () => {},
    };
    const session = createPlaybackRecoverySession(
      {
        siteId: "twitch",
        roomId: "1000",
        detail: { ...detail, site_id: "twitch" },
        qualityLevel: "high",
        enabled: true,
      },
      { metadata },
    );
    await flush();
    await flush();
    session.selectQuality(1);
    await flush();
    await flush();

    session.refresh();
    await flush();
    await flush();
    expect(session.getSnapshot().qualities[session.getSnapshot().qualityIndex]?.quality).toBe("B");
    session.dispose();
  });

  test("最低视频档 helper 处理空、单档与纯音频边界", () => {
    expect(lowestVideoQualityIndex([])).toBeNull();
    expect(lowestVideoQualityIndex([{ quality: "4K" }])).toBe(0);
    expect(lowestVideoQualityIndex([{ quality: "4K" }, { quality: "audio only" }])).toBe(0);
    expect(lowestVideoQualityIndex([{ quality: "audio only" }])).toBeNull();
  });
});
