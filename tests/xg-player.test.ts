import { describe, expect, test } from "bun:test";
import type { IPlayerOptions } from "xgplayer";
import {
  iptvChannelPlayUrl,
  iptvLifecycleReloadToken,
  iptvPlaybackKind,
  nextIptvReconnectAction,
} from "../src/features/iptv/IptvPlayer";
import {
  applyXgDashSegmentTimeline,
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
    let startedFrom: number | undefined | "none" = "none";
    let requestedPlugin = "";
    const core = {
      startLoad: (position?: number) => {
        startedFrom = position;
      },
      playingDate: new Date(1_700_000_000_000),
    };
    const player = {
      getPlugin: (condition: string | Function) => {
        requestedPlugin = String(condition);
        return { hls: core };
      },
    } as XgPlayerInstance;

    const wrapper = getXgHlsCore(player);
    expect(requestedPlugin).toBe("HlsJsPlugin");
    wrapper?.startLoad(12);
    expect(startedFrom).toBe(12);
    // 节目时钟是多视图对齐实现精确同步所读取的内容。
    expect(wrapper?.programDateMs()).toBe(1_700_000_000_000);
  });

  test("reports no program clock for a playlist without EXT-X-PROGRAM-DATE-TIME", () => {
    const player = {
      getPlugin: () => ({ hls: { startLoad: () => {}, playingDate: null } }),
    } as unknown as XgPlayerInstance;

    expect(getXgHlsCore(player)?.programDateMs()).toBeNull();
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

  test("seeks recordings through the attached mpegts.js core", () => {
    let currentTime = 0;
    const core = {
      on: () => {},
      get currentTime() {
        return currentTime;
      },
      set currentTime(value: number) {
        currentTime = value;
      },
    };
    const player = {
      getPlugin: () => ({ mpegts: core }),
      on: () => {},
    } as unknown as XgPlayerInstance;

    expect(getXgMpegtsCore(player)?.seek?.(95.5)).toBe(true);
    expect(currentTime).toBe(95.5);
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

  test("rewrites the DASH segment table to the real sidx boundaries", () => {
    // 插件按等长分片展开出的表：末片区间倒挂（120 ≥ 119.97），任何时刻都选不中它。
    const video = [
      { start: 0, end: 5, segmentDuration: 5 },
      { start: 5, end: 10, segmentDuration: 5 },
      { start: 10, end: 119.967, segmentDuration: 5 },
    ];
    const audio = [
      { start: 0, end: 5, segmentDuration: 5 },
      { start: 5, end: 119.978, segmentDuration: 5 },
    ];
    const player = {
      getPlugin: () => ({
        dash: {
          mpd: {
            mediaList: {
              video: [{ mediaSegments: video }],
              audio: [{ mediaSegments: audio }],
            },
          },
        },
      }),
    } as unknown as XgPlayerInstance;

    expect(
      applyXgDashSegmentTimeline(player, {
        video: [0, 5, 112.7, 119.967],
        audio: [0, 115.357, 119.978],
      }),
    ).toBe(true);
    expect(video.map((segment) => [segment.start, segment.end])).toEqual([
      [0, 5],
      [5, 112.7],
      [112.7, 119.967],
    ]);
    expect(audio.map((segment) => [segment.start, segment.end])).toEqual([
      [0, 115.357],
      [115.357, 119.978],
    ]);
    // 插件用 segmentDuration 当选片窗口的半径，必须跟着边界一起改。
    expect(video[2]!.segmentDuration).toBeCloseTo(7.267, 3);
    expect(audio[1]!.segmentDuration).toBeCloseTo(4.621, 3);
    // 每片都覆盖一段非空区间:seek 目标落在任意时刻都能选中唯一一片。
    for (const segment of [...video, ...audio]) {
      expect(segment.end).toBeGreaterThan(segment.start);
    }
  });

  test("leaves a segment table alone when it does not match the timeline", () => {
    // 条数不符 = 这份时间轴描述的不是这条轨（画质/编码不同),改写会把表写坏。
    const video = [{ start: 0, end: 5, segmentDuration: 5 }];
    const player = {
      getPlugin: () => ({
        dash: { mpd: { mediaList: { video: [{ mediaSegments: video }], audio: [] } } },
      }),
    } as unknown as XgPlayerInstance;

    expect(applyXgDashSegmentTimeline(player, { video: [0, 5, 10], audio: [] })).toBe(false);
    expect(video).toEqual([{ start: 0, end: 5, segmentDuration: 5 }]);
  });

  test("applies the DASH timeline once the plugin attaches its parsed manifest", async () => {
    // 插件要到 `beforePlayerInit` 的异步链里才挂上 `dash`，构造函数返回时还没有:
    // 播放器创建时写不进去,必须等 resourceReady/canplay 再补。
    const handlers = new Map<string, () => void>();
    let dash: unknown = null;
    // 等长展开的表：末片 end 是标称槽位（10s），真实边界在 7.7s。
    const segments = [
      { start: 0, end: 5, segmentDuration: 5 },
      { start: 5, end: 10, segmentDuration: 5 },
    ];
    class PlayerStub {
      on(event: string, handler: () => void) {
        handlers.set(event, handler);
      }
      getPlugin() {
        return dash ? { dash } : null;
      }
    }

    createXgPlayer({ Player: PlayerStub as unknown as XgPlayerModules["Player"] }, {
      root: {} as HTMLElement,
      video: { canPlayType: () => "" } as unknown as HTMLVideoElement,
      url: "http://127.0.0.1:5001/mpd",
      kind: "dash",
      isLive: false,
      dashSegmentTimeline: { video: [0, 5, 7.7], audio: [] },
    });

    // 构造函数返回时插件还没挂上 dash，写不进去。
    expect(segments[1]!.end).toBe(10);
    dash = { mpd: { mediaList: { video: [{ mediaSegments: segments }], audio: [] } } };
    handlers.get("resourceReady")?.();
    await Promise.resolve();
    expect(segments.map((segment) => [segment.start, segment.end])).toEqual([
      [0, 5],
      [5, 7.7],
    ]);
    expect(segments[1]!.segmentDuration).toBeCloseTo(2.7, 3);
  });
});
