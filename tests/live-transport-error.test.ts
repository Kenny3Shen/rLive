import { describe, expect, test } from "bun:test";
import {
  canSwitchVideoJsSource,
  classifyTransportFailure,
  createVideoJsPlayer,
  isMpegtsEarlyEof,
  type VideoJsPlayerModules,
} from "../src/features/room/player/videoJsPlayer";
import { MediaStub } from "./helpers/media";
import { settle } from "./helpers/async";

const EARLY_EOF = {
  type: "NetworkError",
  detail: "UnrecoverableEarlyEof",
  engineCode: -1,
  message: "Fetch stream meet Early-EOF",
};

class LiveMedia extends MediaStub {
  error: MediaError | null = null;
  readyState = 0;
  play() {
    this.paused = false;
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  }
}

type FakeCore = {
  handlers: Map<string, (...args: unknown[]) => void>;
  destroyCalls: number;
  destroyedDuringDispatch: boolean;
  url: string;
  attachMediaElement: (media: HTMLVideoElement) => void;
  load: () => void;
  destroy: () => void;
  emit: (event: string, ...args: unknown[]) => void;
};

/** 只实现播放器用到的事件与生命周期；记录销毁是否发生在事件回调内。 */
function createMpegtsFake() {
  const cores: FakeCore[] = [];
  let dispatching = false;
  const library = {
    isSupported: () => true,
    Events: { ERROR: "error", LOADING_COMPLETE: "loading_complete" },
    createPlayer: (dataSource: { url: string }) => {
      const handlers = new Map<string, (...args: unknown[]) => void>();
      const core: FakeCore = {
        handlers,
        destroyCalls: 0,
        destroyedDuringDispatch: false,
        url: dataSource.url,
        attachMediaElement() {},
        load() {},
        destroy() {
          core.destroyCalls += 1;
          if (dispatching) core.destroyedDuringDispatch = true;
        },
        emit(event, ...args) {
          dispatching = true;
          try {
            handlers.get(event)?.(...args);
          } finally {
            dispatching = false;
          }
        },
      };
      // 与真实实例一致：同一事件名允许注册多个监听。
      const originalOn = (event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler);
      };
      (core as unknown as { on: typeof originalOn }).on = originalOn;
      cores.push(core);
      return core;
    },
  };
  return { library, cores };
}

function setup() {
  const media = new LiveMedia();
  const { library, cores } = createMpegtsFake();
  const player = createVideoJsPlayer(
    { mpegts: library as unknown as VideoJsPlayerModules["mpegts"] },
    {
      video: media as unknown as HTMLVideoElement,
      url: "proxy://live.flv?token=one",
      kind: "flv",
      isLive: true,
    },
  );
  const errors: unknown[] = [];
  const loadingComplete: number[] = [];
  player.on("error", (error) => errors.push(error));
  player.on("loading_complete", () => loadingComplete.push(1));
  return { media, player, cores, errors, loadingComplete };
}

/** 软切换等到 `canplay` 且 readyState ≥ 3 才完成。 */
function readyMedia(media: LiveMedia) {
  media.readyState = 4;
  media.dispatchEvent(new Event("loadstart"));
  media.dispatchEvent(new Event("canplay"));
}

describe("mpegts 错误事实", () => {
  test("只把直播 NetworkError + UnrecoverableEarlyEof 认作早断流", () => {
    expect(isMpegtsEarlyEof(EARLY_EOF)).toBe(true);
    expect(isMpegtsEarlyEof({ type: "NetworkError", detail: "Exception" })).toBe(false);
    expect(isMpegtsEarlyEof({ type: "MediaError", detail: "UnrecoverableEarlyEof" })).toBe(false);
    expect(isMpegtsEarlyEof({ message: "network unrecoverable early eof" })).toBe(false);
    expect(isMpegtsEarlyEof(null)).toBe(false);
  });

  test("FLV 早断流映射为 eof，MPEG-TS 与普通网络错误仍为 error", () => {
    expect(classifyTransportFailure(EARLY_EOF, "flv")).toEqual({
      kind: "eof",
      message: "Fetch stream meet Early-EOF",
      decodeError: false,
    });
    expect(classifyTransportFailure(EARLY_EOF, "mpegts").kind).toBe("error");
    expect(
      classifyTransportFailure(
        { type: "NetworkError", detail: "Exception", message: "network failed" },
        "flv",
      ),
    ).toEqual({ kind: "error", message: "network failed", decodeError: false });
    expect(
      classifyTransportFailure(
        { type: "MediaError", detail: "MediaMSEError", message: "decode failed" },
        "flv",
      ).decodeError,
    ).toBe(true);
  });
});

describe("mpegts 传输所有权", () => {
  test("首个错误保留 type/detail/engineCode 与完整 message，且回调内不同步销毁", () => {
    const state = setup();
    state.cores[0].emit("error", EARLY_EOF.type, EARLY_EOF.detail, {
      code: EARLY_EOF.engineCode,
      msg: EARLY_EOF.message,
    });

    expect(state.errors).toEqual([
      {
        type: "NetworkError",
        detail: "UnrecoverableEarlyEof",
        engineCode: -1,
        message: "Fetch stream meet Early-EOF",
      },
    ]);
    // 回调返回前不得重入引擎自身的卸载流程。
    expect(state.cores[0].destroyedDuringDispatch).toBe(false);
    expect(state.cores[0].destroyCalls).toBe(0);
  });

  test("旧实例迟到的 error 与 loading_complete 不覆盖首错也不误报结束", async () => {
    const state = setup();
    const core = state.cores[0];
    core.emit("error", "NetworkError", "UnrecoverableEarlyEof", { msg: "first" });
    await settle();

    core.emit("error", "NetworkError", "Exception", { msg: "second" });
    core.emit("loading_complete");
    await settle();

    expect(state.errors).toHaveLength(1);
    expect((state.errors[0] as { message: string }).message).toBe("first");
    expect(state.loadingComplete).toHaveLength(0);
    expect(core.destroyCalls).toBe(1);
  });

  test("新传输建立后重新接受错误", async () => {
    const state = setup();
    state.cores[0].emit("error", "NetworkError", "Exception", { msg: "first" });
    await settle();

    const switched = state.player.switchSource("proxy://live.flv?token=two", "flv");
    // 旧传输的销毁排在微任务里，新传输要等它 detach 完才附着。
    await settle();
    expect(state.cores).toHaveLength(2);
    readyMedia(state.media);
    await switched;

    state.cores[1].emit("error", "NetworkError", "Exception", { msg: "second" });
    expect(state.errors.map((error) => (error as { message: string }).message)).toEqual([
      "first",
      "second",
    ]);
  });

  test("媒体元素已报错时软切换直接拒绝，不创建第二份传输", async () => {
    const state = setup();
    state.media.error = { code: 3, message: "MEDIA_ERR_DECODE" } as unknown as MediaError;
    state.media.dispatchEvent(new Event("error"));

    await expect(state.player.switchSource("proxy://live.flv?token=two", "flv")).rejects.toEqual(
      state.media.error,
    );
    expect(state.cores).toHaveLength(1);
  });

  test("destroy 会同步回收待销毁的失败传输，供同一 video 立即重建", async () => {
    const state = setup();
    state.cores[0].emit("error", "NetworkError", "UnrecoverableEarlyEof", { msg: "first" });
    // 正常情况下销毁排在微任务；显式 destroy 必须当场落地，避免旧实例 detach
    // 时清掉随后复用同一 <video> 的新传输。
    expect(state.cores[0].destroyCalls).toBe(0);
    state.player.destroy();
    expect(state.cores[0].destroyCalls).toBe(1);
    await settle();
    expect(state.cores[0].destroyCalls).toBe(1);
  });

  test("首个解码事实在 media.error 被 load 清空后仍阻止原地重连", async () => {
    const state = setup();
    const decodeError = { code: 3, message: "MEDIA_ERR_DECODE" } as unknown as MediaError;
    state.media.error = decodeError;
    state.media.dispatchEvent(new Event("error"));
    // 失败传输 detach 时的 load() 会把媒体错误清掉，事实不能随之丢失。
    state.media.error = null;

    await expect(state.player.switchSource("proxy://live.flv?token=two", "flv")).rejects.toBe(
      decodeError,
    );
    expect(state.cores).toHaveLength(1);
  });

  test("mpegts 引擎先报解码失败时也锁存首错并拒绝原地重连", async () => {
    const state = setup();
    expect(canSwitchVideoJsSource(state.player)).toBe(true);

    state.cores[0].emit("error", "MediaError", "MediaMSEError", {
      msg: "PipelineStatus::PIPELINE_ERROR_DECODE: video decode error! source=player",
    });

    expect(canSwitchVideoJsSource(state.player)).toBe(false);
    await expect(state.player.switchSource("proxy://live.flv?token=two", "flv")).rejects.toEqual({
      type: "MediaError",
      detail: "MediaMSEError",
      message: "PipelineStatus::PIPELINE_ERROR_DECODE: video decode error! source=player",
    });
    expect(state.cores).toHaveLength(1);
  });

  test("解码失败先断开旧传输所有权，微任务销毁且迟到错误不再上报", async () => {
    const state = setup();
    const decodeError = { code: 3, message: "MEDIA_ERR_DECODE" } as unknown as MediaError;
    state.media.error = decodeError;
    state.media.dispatchEvent(new Event("error"));

    // 媒体事件栈里同步销毁会重入引擎卸载流程。
    expect(state.cores[0].destroyedDuringDispatch).toBe(false);
    expect(state.errors).toHaveLength(1);
    await settle();
    expect(state.cores[0].destroyCalls).toBe(1);

    // 旧实例在销毁后的迟到错误不覆盖首错。
    state.cores[0].emit("error", "NetworkError", "Exception", { msg: "late" });
    state.cores[0].emit("loading_complete");
    expect(state.errors).toHaveLength(1);
    expect(state.loadingComplete).toHaveLength(0);
  });
});

describe("媒体元素错误的首错语义", () => {
  test("原生媒体重复 error 只上报首个事实", () => {
    const media = new LiveMedia();
    const player = createVideoJsPlayer(
      {},
      {
        video: media as unknown as HTMLVideoElement,
        url: "proxy://live.mp4",
        kind: "native",
      },
    );
    const errors: unknown[] = [];
    player.on("error", (error) => errors.push(error));

    const first = { code: 3, message: "MEDIA_ERR_DECODE" };
    const second = { code: 4, message: "MEDIA_ERR_SRC_NOT_SUPPORTED" };
    media.error = first as unknown as MediaError;
    media.dispatchEvent(new Event("error"));
    media.error = second as unknown as MediaError;
    media.dispatchEvent(new Event("error"));

    expect(errors).toEqual([first]);
    player.destroy();
  });

  test("HLS 媒体元素实际报错时续期拒绝原地重连，但 hls.js 恢复路径不受影响", async () => {
    const media = new LiveMedia();
    class HlsStub extends EventTarget {
      source: unknown = null;
      preload = "";
      streamType = "";
      engine = null;
      attach() {}
      destroy() {}
    }
    const player = createVideoJsPlayer(
      { HlsJsAdapter: HlsStub as unknown as VideoJsPlayerModules["HlsJsAdapter"] },
      {
        video: media as unknown as HTMLVideoElement,
        url: "proxy://live.m3u8",
        kind: "hls",
        isLive: true,
      },
    );
    const decodeError = { code: 3, message: "MEDIA_ERR_DECODE" } as unknown as MediaError;
    media.error = decodeError;

    await expect(player.switchSource("proxy://live.m3u8?switch=1", "hls")).rejects.toBe(
      decodeError,
    );
    player.destroy();
  });
});
