import { describe, expect, test } from "bun:test";
import {
  iptvFlvPlaybackOptions,
  liveFlvPlaybackOptions,
  liveMpegtsPlaybackOptions,
} from "../src/features/room/player/useWebPlayer";
import { streamProxyStartArgs } from "../src/features/room/player/streamProxyStart";

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
