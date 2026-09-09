import { describe, expect, test } from "bun:test";
import {
  iptvChannelPlayUrl,
  iptvLifecycleReloadToken,
  iptvPlaybackKind,
  nextIptvReconnectAction,
} from "../src/features/iptv/IptvPlayer";
import {
  isInterruptedPlayRequest,
  isVideoJsDecodeError,
  videoJsPlayerErrorMessage,
  webPlaybackKind,
} from "../src/features/room/player/videoJsPlayer";
import { inferPlaybackProtocol } from "../src/lib/playUrl";

describe("video.js transport selection", () => {
  test("keeps IPTV reconnects bounded with the existing delays", () => {
    expect(nextIptvReconnectAction(0)).toEqual({ type: "retry", attempt: 1, delayMs: 1_000 });
    expect(nextIptvReconnectAction(1)).toEqual({ type: "retry", attempt: 2, delayMs: 2_500 });
    expect(nextIptvReconnectAction(2)).toEqual({ type: "fail" });
  });

  test("keeps manual refresh and automatic reconnect rebuild keys distinct", () => {
    expect(iptvLifecycleReloadToken(0, 1)).toBe("0:1");
    expect(iptvLifecycleReloadToken(1, 0)).toBe("1:0");
    expect(iptvLifecycleReloadToken(0, 1)).not.toBe(iptvLifecycleReloadToken(1, 0));
  });

  test("selects the protocol plugin from common IPTV URL forms", () => {
    const cases = [
      ["https://cdn.example/live.flv?token=one", "flv"],
      ["https://cdn.example/live?id=1&type=flv", "flv"],
      ["https://cdn.example/live.ts?token=one", "mpegts"],
      ["https://cdn.example/live?format=mpegts", "mpegts"],
      ["https://cdn.example/channel.m3u8", "hls"],
      ["https://cdn.example/channel?id=1", "hls"],
      ["https://cdn.example/archive.mp4", "native"],
    ] as const;

    for (const [url, expected] of cases) {
      expect(iptvPlaybackKind(url)).toBe(expected);
    }
    expect(
      iptvPlaybackKind({
        url: "https://cdn.example/opaque",
        protocol: "mpeg_ts",
      }),
    ).toBe("mpegts");
  });

  test("translates opaque IPTV channels into explicit shared lifecycle sources", () => {
    const base = {
      id: "one",
      name: "频道",
      group: "",
      logo: null,
      protocol: "unknown" as const,
      headers: {},
    };
    expect(iptvChannelPlayUrl({ ...base, url: "https://cdn.example/live.m2ts" })).toMatchObject({
      source_id: "iptv:one",
      protocol: "mpeg_ts",
    });
    expect(iptvChannelPlayUrl({ ...base, url: "https://cdn.example/archive.mov" })).toMatchObject({
      protocol: "native",
    });
  });

  test("maps site playback protocols onto Video.js media adapters", () => {
    expect(webPlaybackKind({ url: "https://cdn.example/live.flv", protocol: "flv" })).toBe("flv");
    expect(webPlaybackKind({ url: "https://cdn.example/channel.m3u8", protocol: "hls" })).toBe(
      "hls",
    );
    expect(webPlaybackKind({ url: "https://cdn.example/live.ts", protocol: "mpeg_ts" })).toBe(
      "mpegts",
    );
    expect(webPlaybackKind({ url: "https://cdn.example/archive.mp4", protocol: "native" })).toBe(
      "native",
    );
    // 站点声明 unknown 时按 URL 特征推导，而不是全部压给 FLV。
    expect(webPlaybackKind({ url: "https://cdn.example/channel.m3u8", protocol: "unknown" })).toBe(
      "hls",
    );
  });

  test("shares URL inference while preserving IPTV and live fallbacks", () => {
    expect(inferPlaybackProtocol("https://cdn.example/channel.m3u8")).toBe("hls");
    expect(inferPlaybackProtocol("https://cdn.example/live.m2ts?token=one")).toBe("mpeg_ts");
    expect(inferPlaybackProtocol("https://cdn.example/archive.mov")).toBe("native");
    expect(inferPlaybackProtocol("https://cdn.example/opaque")).toBe("flv");
    expect(inferPlaybackProtocol("https://cdn.example/opaque", { fallback: "hls" })).toBe("hls");
  });

  test("normalizes native and protocol-level media errors", () => {
    expect(videoJsPlayerErrorMessage("network failed")).toBe("network failed");
    expect(videoJsPlayerErrorMessage({ message: "network failed" })).toBe("network failed");
    expect(videoJsPlayerErrorMessage({ error: { message: "decode failed" } })).toBe(
      "decode failed",
    );
    expect(videoJsPlayerErrorMessage({ details: "manifestLoadError" })).toBe("manifestLoadError");
    expect(videoJsPlayerErrorMessage({}, "fallback")).toBe("fallback");
  });

  test("treats a superseded play() request as no failure at all", () => {
    const pauseInterrupt = new DOMException(
      "The play() request was interrupted by a call to pause().",
      "AbortError",
    );
    expect(isInterruptedPlayRequest(pauseInterrupt)).toBe(true);
    expect(isInterruptedPlayRequest({ name: "NotAllowedError" })).toBe(false);
    expect(isInterruptedPlayRequest({ message: "network failed" })).toBe(false);
    expect(isInterruptedPlayRequest(null)).toBe(false);
  });

  test("recognizes native decoder failures without mistaking network errors", () => {
    expect(isVideoJsDecodeError({ code: 3 })).toBe(true);
    expect(isVideoJsDecodeError({ error: { code: 3, message: "MEDIA_ERR_DECODE" } })).toBe(true);
    expect(
      isVideoJsDecodeError({
        message: "PipelineStatus::PIPELINE_ERROR_DECODE: Failed to send video packet",
      }),
    ).toBe(true);
    expect(
      isVideoJsDecodeError(
        "PipelineStatus::CHUNK_DEMUXER_ERROR_APPEND_FAILED: Failed to prepare video sample",
      ),
    ).toBe(true);
    // hls.js 网络错误只带 details 与响应信息，没有解码码位。
    expect(isVideoJsDecodeError({ details: "manifestLoadError" })).toBe(false);
    expect(isVideoJsDecodeError({ message: "bad network response" })).toBe(false);
  });
});
