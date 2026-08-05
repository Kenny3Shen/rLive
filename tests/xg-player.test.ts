import { describe, expect, test } from "bun:test";
import type { IPlayerOptions } from "xgplayer";
import { iptvPlaybackKind } from "../src/features/iptv/IptvPlayer";
import {
  createXgPlayer,
  getXgHlsCore,
  xgPlayerErrorMessage,
  type XgPlayerInstance,
  type XgPlayerModules,
} from "../src/features/room/player/xgPlayer";

describe("xgplayer transport selection", () => {
  test("selects the protocol plugin from common IPTV URL forms", () => {
    expect(iptvPlaybackKind("https://cdn.example/live.flv?token=one")).toBe("flv");
    expect(iptvPlaybackKind("https://cdn.example/live?id=1&type=flv")).toBe("flv");
    expect(iptvPlaybackKind("https://cdn.example/live.ts?token=one")).toBe("mpegts");
    expect(iptvPlaybackKind("https://cdn.example/live?format=mpegts")).toBe("mpegts");
    expect(iptvPlaybackKind("https://cdn.example/channel.m3u8")).toBe("hls");
    expect(iptvPlaybackKind("https://cdn.example/channel?id=1")).toBe("hls");
    expect(iptvPlaybackKind("https://cdn.example/archive.mp4")).toBe("native");
    expect(
      iptvPlaybackKind({
        url: "https://cdn.example/opaque",
        protocol: "mpeg_ts",
      }),
    ).toBe("mpegts");
  });

  test("normalizes xgplayer protocol and media errors", () => {
    expect(xgPlayerErrorMessage({ errorMessage: "network failed" })).toBe("network failed");
    expect(xgPlayerErrorMessage({ mediaError: { message: "decode failed" } })).toBe(
      "decode failed",
    );
    expect(xgPlayerErrorMessage({}, "fallback")).toBe("fallback");
  });

  test("binds the media element to a dedicated root that fills its stage", () => {
    let capturedOptions: IPlayerOptions | null = null;

    class PlayerStub implements XgPlayerInstance {
      media: HTMLMediaElement;

      constructor(options: IPlayerOptions) {
        capturedOptions = options;
        this.media = options.mediaEl as HTMLMediaElement;
      }

      async play(): Promise<void> {}
      pause(): void {}
      destroy(): void {}
      on(): void {}
      getPlugin(): null {
        return null;
      }
    }

    const stage = {} as HTMLElement;
    const root = { parentElement: stage } as unknown as HTMLElement;
    const video = { canPlayType: () => "" } as unknown as HTMLVideoElement;

    createXgPlayer(
      { Player: PlayerStub as XgPlayerModules["Player"] },
      { root, video, url: "https://cdn.example/archive.mp4", kind: "native", isLive: false },
    );

    expect(capturedOptions?.el).toBe(root);
    expect(capturedOptions?.el).not.toBe(stage);
    expect(capturedOptions?.mediaEl).toBe(video);
    expect(capturedOptions?.width).toBe("100%");
    expect(capturedOptions?.height).toBe("100%");
  });

  test("passes HLS options through the official xgplayer-hls namespace", () => {
    let capturedOptions: IPlayerOptions | null = null;

    class PlayerStub {
      media: HTMLMediaElement;

      constructor(options: IPlayerOptions) {
        capturedOptions = options;
        this.media = options.mediaEl as HTMLMediaElement;
      }

      async play(): Promise<void> {}
      pause(): void {}
      destroy(): void {}
      on(): void {}
      getPlugin(): null {
        return null;
      }
    }

    const plugin = { isSupported: () => true };
    const hls = { retryCount: 3, targetLatency: 3, maxLatency: 6 };
    createXgPlayer(
      {
        Player: PlayerStub as XgPlayerModules["Player"],
        plugin,
      },
      {
        root: {} as HTMLElement,
        video: { canPlayType: () => "" } as unknown as HTMLVideoElement,
        url: "https://cdn.example/live.m3u8",
        kind: "hls",
        hls,
      },
    );

    expect(capturedOptions?.plugins).toEqual([plugin]);
    expect(capturedOptions?.hls).toEqual(hls);
    expect("hlsJsPlugin" in (capturedOptions ?? {})).toBe(false);
  });

  test("reads the official HLS core from the lowercase plugin name", () => {
    const core = { replay: async () => {} };
    let requestedPlugin = "";
    const player = {
      getPlugin: (condition: string | Function) => {
        requestedPlugin = String(condition);
        return { core };
      },
    } as XgPlayerInstance;

    expect(getXgHlsCore(player)).toBe(core);
    expect(requestedPlugin).toBe("hls");
  });
});
