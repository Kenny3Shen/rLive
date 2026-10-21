import { describe, expect, test } from "bun:test";
import {
  iptvFlvPlaybackOptions,
  liveFlvPlaybackOptions,
  liveMpegtsPlaybackOptions,
} from "../src/features/room/player/useWebPlayer";

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
});
