import { describe, expect, test } from "bun:test";
import {
  iptvFlvPlaybackOptions,
  liveFlvPlaybackOptions,
  liveMpegtsPlaybackOptions,
} from "../src/features/room/player/useWebPlayer";
import { streamProxyStartArgs } from "../src/features/room/player/streamProxyStart";
import {
  BILIBILI_FLV_STARTUP_BUFFER_SECONDS,
  bilibiliFlvLatencyConfig,
  contiguousBufferedAheadSeconds,
  shouldPrimeBilibiliFlvStartup,
  waitForContinuousBuffer,
} from "../src/features/room/player/liveStartupBuffer";

describe("直播 mpegts 配置", () => {
  // mpegts.js 默认开启 `fixAudioTimestampGap`，并按缺口帧数无上限地生成静音帧：
  // 上游时间戳跳变时 `push.apply` 会以 RangeError 结束，再被网络层报成一次
  // NetworkError。直播三处配置都必须显式关闭它。
  test("FLV、MPEG-TS 与 IPTV 都关闭无上限的静音帧补齐", () => {
    expect(liveFlvPlaybackOptions(false).mpegtsConfig?.fixAudioTimestampGap).toBe(false);
    expect(liveFlvPlaybackOptions(true).mpegtsConfig?.fixAudioTimestampGap).toBe(false);
    expect(liveFlvPlaybackOptions(true, true).mpegtsConfig?.fixAudioTimestampGap).toBe(false);
    expect(liveMpegtsPlaybackOptions(false).mpegtsConfig?.fixAudioTimestampGap).toBe(false);
    expect(liveMpegtsPlaybackOptions(true).mpegtsConfig?.fixAudioTimestampGap).toBe(false);
    expect(iptvFlvPlaybackOptions().mpegtsConfig?.fixAudioTimestampGap).toBe(false);
  });

  test("关闭补齐不影响既有缓冲与延迟策略", () => {
    const desktop = liveFlvPlaybackOptions(false);
    expect(desktop.mediaDataSource).toEqual({
      type: "flv",
      isLive: true,
      hasAudio: true,
      hasVideo: true,
    });
    expect(desktop.mpegtsConfig).toMatchObject({
      enableWorker: false,
      enableStashBuffer: true,
      stashInitialSize: 384,
      liveBufferLatencyChasing: true,
      liveBufferLatencyMaxLatency: 5,
      liveBufferLatencyMinRemain: 1,
      autoCleanupSourceBuffer: true,
      autoCleanupMaxBackwardDuration: 15,
      autoCleanupMinBackwardDuration: 8,
    });

    const mobile = liveFlvPlaybackOptions(true).mpegtsConfig;
    expect(mobile).toMatchObject({
      liveBufferLatencyMaxLatency: 6,
      liveBufferLatencyMinRemain: 1.5,
    });
    expect(mobile?.autoCleanupMaxBackwardDuration).toBe(20);

    const hold = liveFlvPlaybackOptions(false, true).mpegtsConfig;
    expect(hold).toMatchObject({
      liveBufferLatencyChasing: false,
      autoCleanupMaxBackwardDuration: 42,
      autoCleanupMinBackwardDuration: 30,
    });
  });

  test("MPEG-TS 与 IPTV 保留各自延迟参数", () => {
    expect(liveMpegtsPlaybackOptions(false).mpegtsConfig).toMatchObject({
      liveBufferLatencyChasing: true,
      liveBufferLatencyMaxLatency: 3,
      liveBufferLatencyMinRemain: 0.5,
    });
    expect(liveMpegtsPlaybackOptions(true).mpegtsConfig).toMatchObject({
      liveBufferLatencyChasing: false,
      autoCleanupMaxBackwardDuration: 42,
      autoCleanupMinBackwardDuration: 30,
    });
    expect(iptvFlvPlaybackOptions().mpegtsConfig).toMatchObject({
      liveBufferLatencyChasing: true,
      liveBufferLatencyMaxLatency: 3,
      liveBufferLatencyMinRemain: 0.5,
    });
    expect(iptvFlvPlaybackOptions().mediaDataSource).toMatchObject({ type: "flv", isLive: true });
  });

  test("仅 Bilibili FLV 提高追帧余量，其他站点与对齐模式不变", () => {
    expect(liveFlvPlaybackOptions(false, false, "bilibili").mpegtsConfig).toMatchObject({
      liveBufferLatencyChasing: true,
      liveBufferLatencyMaxLatency: 5,
      liveBufferLatencyMinRemain: 3,
    });
    expect(liveFlvPlaybackOptions(true, false, "bilibili").mpegtsConfig).toMatchObject({
      liveBufferLatencyMaxLatency: 6,
      liveBufferLatencyMinRemain: 3,
    });
    expect(liveFlvPlaybackOptions(false, false, "huya").mpegtsConfig).toMatchObject({
      liveBufferLatencyMaxLatency: 5,
      liveBufferLatencyMinRemain: 1,
    });
    expect(liveFlvPlaybackOptions(false, true, "bilibili").mpegtsConfig).toMatchObject({
      liveBufferLatencyChasing: false,
      autoCleanupMaxBackwardDuration: 42,
      autoCleanupMinBackwardDuration: 30,
    });
    expect(bilibiliFlvLatencyConfig("bilibili", true)).toEqual({});
    expect(bilibiliFlvLatencyConfig("iptv", false)).toEqual({});
  });
});

describe("Bilibili FLV 启动缓冲", () => {
  test("只匹配 Bilibili FLV 的普通起播", () => {
    expect(shouldPrimeBilibiliFlvStartup("bilibili", "flv", false)).toBe(true);
    expect(shouldPrimeBilibiliFlvStartup("bilibili", "flv", true)).toBe(false);
    expect(shouldPrimeBilibiliFlvStartup("bilibili", "hls", false)).toBe(false);
    expect(shouldPrimeBilibiliFlvStartup("huya", "flv", false)).toBe(false);
    expect(shouldPrimeBilibiliFlvStartup(undefined, "flv", false)).toBe(false);
  });

  test("连续区间从当前位置起算，不跨越空洞，也不累计多段", () => {
    const ranges = (items: Array<[number, number]>) => ({
      length: items.length,
      start: (index: number) => items[index][0],
      end: (index: number) => items[index][1],
    });
    expect(contiguousBufferedAheadSeconds({ currentTime: 10, buffered: ranges([[0, 13]]) })).toBe(
      3,
    );
    expect(
      contiguousBufferedAheadSeconds({
        currentTime: 10,
        buffered: ranges([
          [8, 11],
          [11.4, 14],
        ]),
      }),
    ).toBe(1);
    expect(
      contiguousBufferedAheadSeconds({
        currentTime: 10,
        buffered: ranges([
          [9.9, 11],
          [11.2, 14],
        ]),
      }),
    ).toBe(1);
    expect(
      contiguousBufferedAheadSeconds({
        currentTime: 10,
        buffered: ranges([[10.4, 14]]),
      }),
    ).toBe(0);
  });

  test("达到目标即放行，并清理轮询与事件监听", async () => {
    const items: Array<[number, number]> = [[0, 1]];
    const listeners = new Map<string, () => void>();
    const media = {
      currentTime: 0,
      buffered: {
        get length() {
          return items.length;
        },
        start: (index: number) => items[index][0],
        end: (index: number) => items[index][1],
      },
      addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
    };
    const pending = waitForContinuousBuffer(media, BILIBILI_FLV_STARTUP_BUFFER_SECONDS, () => true);
    expect(await Promise.race([pending, Promise.resolve("pending")])).toBe("pending");
    items[0] = [0, 4];
    listeners.get("progress")?.();
    expect(await pending).toBe("ready");
    expect(listeners.size).toBe(0);
  });

  test("取消、用户停止、错误与结束立即释放等待，并区分结果", async () => {
    const listeners = new Map<string, () => void>();
    const media = {
      currentTime: 0,
      buffered: { length: 0, start: () => 0, end: () => 0 },
      addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
    };
    const abort = new AbortController();
    const cancelled = waitForContinuousBuffer(media, 3, () => true, abort.signal);
    abort.abort();
    expect(await cancelled).toBe("cancelled");
    expect(listeners.size).toBe(0);

    let current = true;
    const replaced = waitForContinuousBuffer(media, 3, () => current);
    current = false;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await replaced).toBe("stopped");
    expect(listeners.size).toBe(0);

    const errored = waitForContinuousBuffer(media, 3, () => true);
    listeners.get("error")?.();
    expect(await errored).toBe("error");
    expect(listeners.size).toBe(0);

    const ended = waitForContinuousBuffer(media, 3, () => true);
    listeners.get("ended")?.();
    expect(await ended).toBe("ended");
    expect(listeners.size).toBe(0);
  });
});

describe("直播代理启动参数", () => {
  test("斗鱼 FLV 恢复元数据随主播放会话透传", () => {
    const recovery = { room_id: "6979222", rate: 4, cdn: "hw-h5" };
    expect(
      streamProxyStartArgs(
        {
          url: "https://cdn.example/live.flv?token=secret",
          headers: { referer: "https://www.douyu.com/6979222" },
          douyu_flv_recovery: recovery,
        },
        "web-player:1",
        false,
      ),
    ).toEqual({
      url: "https://cdn.example/live.flv?token=secret",
      headers: { referer: "https://www.douyu.com/6979222" },
      sessionId: "web-player:1",
      hls: false,
      douyuFlvRecovery: recovery,
    });
  });

  test("Twitch 恢复元数据继续透传，普通来源不产生空参数", () => {
    const recovery = {
      login: "channel",
      selector: "video",
      target_width: 1920,
      target_height: 1080,
      target_frame_rate_milli: 30_000,
    };
    expect(
      streamProxyStartArgs(
        {
          url: "https://cdn.example/live.m3u8",
          headers: {},
          twitch_ad_recovery: recovery,
        },
        "web-player:2",
        true,
      ),
    ).toMatchObject({ hls: true, twitchAdRecovery: recovery });
    expect(
      streamProxyStartArgs(
        { url: "https://cdn.example/live.flv", headers: {} },
        "web-player:3",
        false,
      ),
    ).not.toHaveProperty("twitchAdRecovery");
  });
});
