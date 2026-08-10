import { describe, expect, test } from "bun:test";
import type { IPlayerOptions } from "xgplayer";
import {
  iptvChannelPlayUrl,
  iptvLifecycleReloadToken,
  iptvPlaybackKind,
  nextIptvReconnectAction,
} from "../src/features/iptv/IptvPlayer";
import {
  createXgPlayer,
  getXgHlsCore,
  getXgMpegtsCore,
  isXgPlayerDecodeError,
  switchXgPlaybackSource,
  xgPlaybackSwitchOptions,
  xgPlayerErrorMessage,
  type XgPlayerInstance,
  type XgPlayerModules,
} from "../src/features/room/player/xgPlayer";

describe("xgplayer transport selection", () => {
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

  test("translates legacy IPTV channels into explicit shared lifecycle sources", () => {
    const base = { id: "one", name: "频道", group: "", logo: null, headers: {} };
    expect(iptvChannelPlayUrl({ ...base, url: "https://cdn.example/live.m2ts" })).toMatchObject({
      source_id: "iptv:one",
      protocol: "mpeg_ts",
    });
    expect(iptvChannelPlayUrl({ ...base, url: "https://cdn.example/archive.mov" })).toMatchObject({
      protocol: "native",
    });
  });

  test("normalizes xgplayer protocol and media errors", () => {
    expect(xgPlayerErrorMessage({ errorMessage: "network failed" })).toBe("network failed");
    expect(xgPlayerErrorMessage({ mediaError: { message: "decode failed" } })).toBe(
      "decode failed",
    );
    expect(xgPlayerErrorMessage({}, "fallback")).toBe("fallback");
  });

  test("recognizes Chromium and xgplayer decoder failures", () => {
    expect(isXgPlayerDecodeError({ errorCode: 5103 })).toBe(true);
    expect(
      isXgPlayerDecodeError({
        message: "PipelineStatus::PIPELINE_ERROR_DECODE: Failed to send video packet",
      }),
    ).toBe(true);
    expect(
      isXgPlayerDecodeError(
        "PipelineStatus::CHUNK_DEMUXER_ERROR_APPEND_FAILED: Failed to prepare video sample",
      ),
    ).toBe(true);
    expect(isXgPlayerDecodeError({ errorCode: 2100, message: "bad network response" })).toBe(false);
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

  test("passes every HLS source through the hls.js plugin namespace", () => {
    let capturedOptions: (IPlayerOptions & { hlsJsPlugin?: Record<string, unknown> }) | null = null;

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
    const hls = { hlsOpts: { lowLatencyMode: false } };
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
    expect(capturedOptions?.hlsJsPlugin).toEqual(hls);
    expect("hls" in (capturedOptions ?? {})).toBe(false);
  });

  test("does not bypass hls.js when the browser exposes native HLS", () => {
    const PlayerStub = class {} as XgPlayerModules["Player"];
    expect(() =>
      createXgPlayer(
        {
          Player: PlayerStub,
          plugin: { isSupported: () => false },
        },
        {
          root: {} as HTMLElement,
          video: {
            canPlayType: () => "probably",
          } as unknown as HTMLVideoElement,
          url: "https://cdn.example/live.m3u8",
          kind: "hls",
        },
      ),
    ).toThrow("当前环境不支持 HLS 直播播放");
  });

  test("passes FLV options through the mpegts.js plugin namespace", () => {
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
    const flv = {
      mediaDataSource: { type: "flv", isLive: true },
      mpegtsConfig: { liveBufferLatencyChasing: true },
    };
    createXgPlayer(
      {
        Player: PlayerStub as XgPlayerModules["Player"],
        plugin,
      },
      {
        root: {} as HTMLElement,
        video: { canPlayType: () => "" } as unknown as HTMLVideoElement,
        url: "https://cdn.example/live.flv",
        kind: "flv",
        flv,
      },
    );

    expect(capturedOptions?.plugins).toEqual([plugin]);
    expect(capturedOptions?.MpegtsPlugin).toEqual(flv);
    expect("flv" in (capturedOptions ?? {})).toBe(false);
  });

  test("reads the hls.js core from its plugin wrapper", () => {
    const core = { startLoad: () => {} };
    let requestedPlugin = "";
    const player = {
      getPlugin: (condition: string | Function) => {
        requestedPlugin = String(condition);
        return { hls: core };
      },
    } as XgPlayerInstance;

    expect(getXgHlsCore(player)).toBe(core);
    expect(requestedPlugin).toBe("HlsJsPlugin");
  });

  test("reattaches mpegts.js subscriptions after a soft URL switch", () => {
    const firstHandlers = new Map<string, (...args: unknown[]) => void>();
    const secondHandlers = new Map<string, (...args: unknown[]) => void>();
    const detached: string[] = [];
    const firstCore = {
      on: (event: string, handler: (...args: unknown[]) => void) => {
        firstHandlers.set(event, handler);
      },
      off: (event: string) => detached.push(event),
    };
    const secondCore = {
      on: (event: string, handler: (...args: unknown[]) => void) => {
        secondHandlers.set(event, handler);
      },
    };
    const playerHandlers = new Map<string, (...args: unknown[]) => void>();
    const plugin: { mpegts: typeof firstCore | typeof secondCore } = { mpegts: firstCore };
    let requestedPlugin = "";
    const player = {
      getPlugin: (condition: string | Function) => {
        requestedPlugin = String(condition);
        return plugin;
      },
      on: (event: string, handler: (...args: unknown[]) => void) => {
        playerHandlers.set(event, handler);
      },
    } as XgPlayerInstance;

    const core = getXgMpegtsCore(player);
    core?.on("loading_complete", () => {});
    expect(firstHandlers.has("loading_complete")).toBe(true);
    plugin.mpegts = secondCore;
    playerHandlers.get("urlchange")?.();

    expect(detached).toEqual(["loading_complete"]);
    expect(secondHandlers.has("loading_complete")).toBe(true);
    expect(requestedPlugin).toBe("MpegtsPlugin");
  });

  test("keeps repeated FLV switches on the mpegts player without seamless timestamps", async () => {
    const calls: Array<{ url: string; options: unknown }> = [];
    const player = {
      switchURL: async (url: string | object, options?: unknown) => {
        calls.push({ url: String(url), options });
      },
    } as XgPlayerInstance;

    for (let index = 0; index < 25; index += 1) {
      await switchXgPlaybackSource(player, `https://cdn.example/line-${index}.flv`, "flv");
    }

    expect(calls).toHaveLength(25);
    expect(calls.every(({ options }) => JSON.stringify(options) === '{"seamless":false}')).toBe(
      true,
    );
    expect(xgPlaybackSwitchOptions("hls")).toEqual({ seamless: true });
    expect(xgPlaybackSwitchOptions("mpegts")).toEqual({ seamless: true });
  });

  test("times out a soft switch that never reaches canplay", async () => {
    const player = {
      switchURL: () => new Promise(() => {}),
    } as XgPlayerInstance;

    await expect(
      switchXgPlaybackSource(player, "https://cdn.example/stuck.flv", "flv", 1),
    ).rejects.toThrow("软切换等待媒体就绪超时");
  });

  test("defers mpegts.js subscriptions until the core is attached", async () => {
    const playerHandlers = new Map<string, (...args: unknown[]) => void>();
    const coreHandlers = new Map<string, (...args: unknown[]) => void>();
    const plugin: { mpegts: { on: XgPlayerInstance["on"] } | null } = { mpegts: null };
    const player = {
      getPlugin: () => plugin,
      on: (event: string, handler: (...args: unknown[]) => void) => {
        playerHandlers.set(event, handler);
      },
    } as XgPlayerInstance;

    const deferredCore = getXgMpegtsCore(player);
    deferredCore?.on("loading_complete", () => {});
    plugin.mpegts = {
      on: (event, handler) => {
        coreHandlers.set(event, handler);
      },
    };
    await Promise.resolve();

    expect(playerHandlers.has("ready")).toBe(true);
    expect(playerHandlers.has("urlchange")).toBe(true);
    expect(coreHandlers.has("loading_complete")).toBe(true);
  });

  test("keeps hls.js recovery calls safe before the core is attached", () => {
    let core: { startLoad: (startPosition?: number) => void } | null = null;
    const player = {
      getPlugin: () => ({
        get hls() {
          return core;
        },
      }),
    } as XgPlayerInstance;

    const deferredCore = getXgHlsCore(player);
    expect(deferredCore).not.toBeNull();
    expect(() => deferredCore?.startLoad()).not.toThrow();

    let startPosition: number | undefined;
    core = {
      startLoad: (position) => {
        startPosition = position;
      },
    };
    deferredCore?.startLoad(7);
    expect(startPosition).toBe(7);
  });
});
