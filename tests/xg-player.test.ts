import { describe, expect, test } from "bun:test";
import type { IPlayerOptions } from "xgplayer";
import { iptvPlaybackKind } from "../src/features/iptv/IptvPlayer";
import {
  createXgPlayer,
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
});
