import { describe, expect, test } from "bun:test";
import type { LivePlayQuality, LiveRoomDetail, PlayUrl } from "../src/shared/types/live";
import type { PlayerEvent } from "../src/shared/types/player";
import { createPlaybackRecoverySession } from "../src/features/room/playback/playbackRecoverySession";
import {
  classifyTransportFailure,
  createVideoJsPlayer,
  type VideoJsPlayerModules,
} from "../src/features/room/player/videoJsPlayer";
import { softSwitchOwnsTransport } from "../src/features/room/player/softSwitchTransaction";
import { MediaStub } from "./helpers/media";
import { settle } from "./helpers/async";

/**
 * 复刻 `useWebPlayer` 软切事务的关键步骤：准备期登记事务、`reportPlayerError`
 * 按事务归属决定是否上报、`switchSource` 的 error 监听负责 reject、reject 后由
 * 调用方走硬回退。不渲染 React，也不代替 hook 的实机验证。
 */

const EARLY_EOF = {
  type: "NetworkError",
  detail: "UnrecoverableEarlyEof",
  engineCode: -1,
  message: "Fetch stream meet Early-EOF",
};

class LiveMedia extends MediaStub {
  error: MediaError | null = null;
  readyState = 0;
  bufferedRanges: Array<[number, number]> = [];
  get buffered() {
    const ranges = this.bufferedRanges;
    return {
      get length() {
        return ranges.length;
      },
      start: (index: number) => ranges[index][0],
      end: (index: number) => ranges[index][1],
    };
  }
  play() {
    this.paused = false;
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  }
}

type FakeCore = {
  handlers: Map<string, (...args: unknown[]) => void>;
  destroyed: number;
  attachMediaElement: () => void;
  load: () => void;
  destroy: () => void;
  emit: (event: string, ...args: unknown[]) => void;
};

function createMpegtsFake() {
  const cores: FakeCore[] = [];
  const library = {
    isSupported: () => true,
    Events: { ERROR: "error", LOADING_COMPLETE: "loading_complete" },
    createPlayer: () => {
      const handlers = new Map<string, (...args: unknown[]) => void>();
      const core: FakeCore = {
        handlers,
        destroyed: 0,
        attachMediaElement() {},
        load() {},
        destroy() {
          core.destroyed += 1;
        },
        emit(event, ...args) {
          handlers.get(event)?.(...args);
        },
      };
      (core as unknown as { on: (event: string, handler: () => void) => void }).on = (
        event,
        handler,
      ) => handlers.set(event, handler);
      cores.push(core);
      return core;
    },
  };
  return { library, cores };
}

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

function readyMedia(media: LiveMedia) {
  media.readyState = 4;
  media.dispatchEvent(new Event("loadstart"));
  media.dispatchEvent(new Event("canplay"));
}

async function harness() {
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
  const transaction: { current: { player: unknown; sequence: number } | null } = {
    current: null,
  };
  const published: PlayerEvent[] = [];
  let fallbackCount = 0;
  // 与 hook 中 reportPlayerError 相同的归属判断。
  const reportPlayerError = (error: unknown) => {
    if (softSwitchOwnsTransport(transaction.current, player)) return;
    const failure = classifyTransportFailure(error, "flv");
    published.push({
      epoch: 1,
      generation: 1,
      kind: failure.kind,
      message: failure.message,
      protocol: "flv",
      ...(failure.decodeError ? { decodeError: true } : {}),
    });
  };
  player.on("error", reportPlayerError);

  const session = createPlaybackRecoverySession(
    {
      siteId: "bilibili",
      roomId: "1000",
      detail: undefined,
      qualityLevel: "high",
      enabled: false,
    },
    {
      metadata: {
        fetchQualities: async () => [quality],
        fetchLines: async () => [flvSource()],
        cacheQualities: () => {},
        cacheLines: () => {},
      },
    },
  );
  session.updateConfig({
    siteId: "bilibili",
    roomId: "1000",
    detail,
    qualityLevel: "high",
    enabled: true,
  });
  await settle();
  await settle();
  const flushSession = () => {
    for (const event of published.splice(0)) session.acceptTransportFact(event);
  };

  return {
    media,
    player,
    cores,
    transaction,
    published,
    session,
    flushSession,
    hardFallback: () => {
      fallbackCount += 1;
    },
    fallbackCount: () => fallbackCount,
  };
}

function beginSoftSwitch(h: Awaited<ReturnType<typeof harness>>, sequence = 1): Promise<void> {
  // 事务在排队/准备前登记，覆盖代理重开与 switchSource 之间。
  h.transaction.current = { player: h.player, sequence };
  const switching = h.player.switchSource("proxy://live.flv?token=two", "flv");
  switching.catch(() => h.hardFallback());
  return switching;
}

const STARTUP_BUFFER_OPTIONS = {
  minBufferedAheadSeconds: 3,
  canAutoPlay: () => true,
};

describe("软切事务与恢复会话的分工", () => {
  test("准备期旧传输早断只退役旧传输，不额外续期，新传输照常建立", async () => {
    const h = await harness();
    const initialRenew = h.session.getSnapshot().renewToken;
    h.transaction.current = { player: h.player, sequence: 1 };

    // 准备期（代理重开、switchSource 尚未发起）旧 core 报早断。
    h.cores[0].emit("error", EARLY_EOF.type, EARLY_EOF.detail, {
      code: EARLY_EOF.engineCode,
      msg: EARLY_EOF.message,
    });
    await settle();
    expect(h.published).toHaveLength(0);
    h.flushSession();
    expect(h.session.getSnapshot().renewToken).toBe(initialRenew);

    // 新传输照常建立并就绪。
    const switched = h.player.switchSource("proxy://live.flv?token=two", "flv");
    await settle();
    expect(h.cores).toHaveLength(2);
    readyMedia(h.media);
    await switched;
    expect(h.fallbackCount()).toBe(0);
    expect(h.published).toHaveLength(0);
    h.player.destroy();
    h.session.dispose();
  });

  test("switchSource 期间的传输错误由它 reject，并交给既有硬回退", async () => {
    const h = await harness();
    const switching = beginSoftSwitch(h);
    await settle();
    expect(h.cores).toHaveLength(2);

    // 新传输在就绪前失败：switchSource 的 error 监听负责结算。
    h.cores[1].emit("error", "NetworkError", "Exception", { msg: "new transport failed" });
    await expect(switching).rejects.toMatchObject({ message: "new transport failed" });
    await settle();
    expect(h.fallbackCount()).toBe(1);
    // 同一个失败不再额外发布给恢复会话，否则会同时触发续期与硬重建。
    expect(h.published).toHaveLength(0);
    h.flushSession();
    expect(h.session.getSnapshot().renewToken).toBe(0);
    h.player.destroy();
    h.session.dispose();
  });

  test("事务外的新错误照常上报给恢复会话", async () => {
    const h = await harness();
    expect(h.transaction.current).toBeNull();

    h.cores[0].emit("error", EARLY_EOF.type, EARLY_EOF.detail, {
      code: EARLY_EOF.engineCode,
      msg: EARLY_EOF.message,
    });
    expect(h.published).toHaveLength(1);
    expect(h.published[0]).toMatchObject({ kind: "eof", protocol: "flv" });

    h.flushSession();
    await settle();
    expect(h.session.getSnapshot().renewToken).toBe(1);
    h.player.destroy();
    h.session.dispose();
  });

  test("事务结算后同一播放器的新错误恢复上报", async () => {
    const h = await harness();
    const switching = beginSoftSwitch(h);
    await settle();
    readyMedia(h.media);
    await switching;
    h.transaction.current = null;

    h.cores[1].emit("error", EARLY_EOF.type, EARLY_EOF.detail, {
      code: EARLY_EOF.engineCode,
      msg: "later failure",
    });
    expect(h.published).toHaveLength(1);
    h.flushSession();
    await settle();
    expect(h.session.getSnapshot().renewToken).toBe(1);
    h.player.destroy();
    h.session.dispose();
  });
});

describe("Bilibili FLV 软切起播缓冲", () => {
  test("无缓冲目标时沿原路径立即起播并完成", async () => {
    const h = await harness();
    h.media.paused = false;
    let playCalls = 0;
    h.media.play = () => {
      playCalls += 1;
      return Promise.resolve();
    };

    const switching = h.player.switchSource("proxy://live.flv?token=two", "flv", 1000);
    await settle();
    h.media.paused = true;
    h.media.readyState = 4;
    h.media.dispatchEvent(new Event("loadstart"));
    h.media.dispatchEvent(new Event("canplay"));
    await expect(switching).resolves.toBeUndefined();
    expect(playCalls).toBe(1);
    h.player.destroy();
  });

  test("等待期间用户暂停会成功停止门闩，不拒绝也不重新起播", async () => {
    const h = await harness();
    h.media.paused = false;
    let playCalls = 0;
    h.media.play = () => {
      playCalls += 1;
      return Promise.resolve();
    };

    const switching = h.player.switchSource("proxy://live.flv?token=two", "flv", 1000, {
      ...STARTUP_BUFFER_OPTIONS,
    });
    await settle();
    h.media.paused = true;
    h.media.dispatchEvent(new Event("loadstart"));
    h.media.readyState = 4;
    h.media.bufferedRanges = [[0, 1]];
    h.media.dispatchEvent(new Event("canplay"));
    await settle();
    h.player.pause();
    h.media.dispatchEvent(new Event("pause"));
    expect(playCalls).toBe(0);
    await expect(switching).resolves.toBeUndefined();
    h.player.destroy();
  });

  test("等待期间手动起播立即完成门闩，且不重复调用 play", async () => {
    const h = await harness();
    h.media.paused = false;
    let playCalls = 0;
    h.media.play = () => {
      playCalls += 1;
      return Promise.resolve();
    };
    const switching = h.player.switchSource("proxy://live.flv?token=two", "flv", 1000, {
      ...STARTUP_BUFFER_OPTIONS,
    });
    await settle();
    h.media.paused = true;
    h.media.dispatchEvent(new Event("loadstart"));
    h.media.readyState = 4;
    h.media.bufferedRanges = [[0, 1]];
    h.media.dispatchEvent(new Event("canplay"));
    await settle();
    h.media.paused = false;
    h.media.dispatchEvent(new Event("play"));
    await expect(switching).resolves.toBeUndefined();
    expect(playCalls).toBe(0);
    h.player.destroy();
  });

  test("autoPlay:false 在低缓冲时沿用 canplay 完成，不进入等待也不起播", async () => {
    const h = await harness();
    h.media.paused = false;
    let playCalls = 0;
    h.media.play = () => {
      playCalls += 1;
      return Promise.resolve();
    };

    const switching = h.player.switchSource("proxy://live.flv?token=two", "flv", 1000, {
      ...STARTUP_BUFFER_OPTIONS,
      autoPlay: false,
    });
    await settle();
    readyMedia(h.media);
    await expect(switching).resolves.toBeUndefined();
    expect(playCalls).toBe(0);
    h.player.destroy();
  });

  test("非 Bilibili 目标或 HLS 不传缓冲目标时保持原 canplay 同步完成", async () => {
    const h = await harness();
    const switching = h.player.switchSource("proxy://live.flv?token=two", "flv", 1000);
    await settle();
    h.media.readyState = 4;
    h.media.bufferedRanges = [];
    h.media.dispatchEvent(new Event("loadstart"));
    h.media.dispatchEvent(new Event("canplay"));
    // 用户原本暂停时无需起播，仍同步结算，不需要 progress 或 100ms 轮询。
    await expect(switching).resolves.toBeUndefined();
    h.player.destroy();
  });

  test("没有 pause 事件时，轮询到 canAutoPlay=false 也成功结束门闩", async () => {
    const h = await harness();
    h.media.paused = false;
    let playCalls = 0;
    h.media.play = () => {
      playCalls += 1;
      return Promise.resolve();
    };
    let canAutoPlay = true;
    const switching = h.player.switchSource("proxy://live.flv?token=two", "flv", 1000, {
      minBufferedAheadSeconds: 3,
      canAutoPlay: () => canAutoPlay,
    });
    await settle();
    h.media.paused = true;
    h.media.readyState = 4;
    h.media.bufferedRanges = [[0, 1]];
    h.media.dispatchEvent(new Event("loadstart"));
    h.media.dispatchEvent(new Event("canplay"));
    await settle();
    canAutoPlay = false;
    // 不派发 pause/progress，只等 helper 自己的轮询观察播放意图变化。
    await new Promise((resolve) => setTimeout(resolve, 150));
    await expect(switching).resolves.toBeUndefined();
    expect(playCalls).toBe(0);
    h.player.destroy();
  });

  test("等待中切换新源会以 AbortError 取消旧门闩", async () => {
    const h = await harness();
    h.media.paused = false;
    const first = h.player.switchSource("proxy://live.flv?token=two", "flv", 1000, {
      ...STARTUP_BUFFER_OPTIONS,
    });
    await settle();
    h.media.paused = true;
    h.media.readyState = 4;
    h.media.bufferedRanges = [[0, 1]];
    h.media.dispatchEvent(new Event("loadstart"));
    h.media.dispatchEvent(new Event("canplay"));
    await settle();

    const second = h.player.switchSource("proxy://live.flv?token=three", "flv", 1000);
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await settle();
    readyMedia(h.media);
    await expect(second).resolves.toBeUndefined();
    h.player.destroy();
  });

  test("达到目标缓冲后才起播", async () => {
    const h = await harness();
    h.media.paused = false;
    h.media.playRequested = true;
    let playCalls = 0;
    h.media.play = () => {
      playCalls += 1;
      h.media.paused = false;
      return Promise.resolve();
    };

    const switching = h.player.switchSource("proxy://live.flv?token=two", "flv", 1000, {
      ...STARTUP_BUFFER_OPTIONS,
    });
    await settle();
    h.media.paused = true;
    h.media.dispatchEvent(new Event("loadstart"));
    h.media.readyState = 4;
    h.media.bufferedRanges = [[0, 2]];
    h.media.dispatchEvent(new Event("canplay"));
    await settle();
    expect(playCalls).toBe(0);
    h.media.bufferedRanges = [[0, 3.5]];
    h.media.dispatchEvent(new Event("progress"));
    await expect(switching).resolves.toBeUndefined();
    expect(playCalls).toBe(1);
    expect(h.fallbackCount()).toBe(0);
    h.player.destroy();
  });

  test("prepareAutoplay 只登记意图，不启动媒体", async () => {
    const h = await harness();
    h.media.paused = true;
    let playCalls = 0;
    h.media.play = () => {
      playCalls += 1;
      return Promise.resolve();
    };

    h.player.prepareAutoplay();
    await settle();
    expect(playCalls).toBe(0);
    expect(h.media.paused).toBe(true);
    h.player.destroy();
  });

  test("初始门闩意图在媒体仍暂停时连续两次软切仍等待 3 秒再起播", async () => {
    const h = await harness();
    h.media.paused = true;
    let playCalls = 0;
    h.media.play = () => {
      playCalls += 1;
      h.media.paused = false;
      return Promise.resolve();
    };

    h.player.prepareAutoplay();
    const first = h.player.switchSource("proxy://live.flv?token=two", "flv", 1000, {
      ...STARTUP_BUFFER_OPTIONS,
    });
    await settle();
    h.media.dispatchEvent(new Event("loadstart"));
    h.media.readyState = 4;
    h.media.bufferedRanges = [[0, 1]];
    h.media.dispatchEvent(new Event("canplay"));
    await settle();

    const second = h.player.switchSource("proxy://live.flv?token=three", "flv", 1000, {
      ...STARTUP_BUFFER_OPTIONS,
    });
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await settle();
    h.media.dispatchEvent(new Event("loadstart"));
    h.media.bufferedRanges = [[0, 2]];
    h.media.dispatchEvent(new Event("canplay"));
    await settle();
    expect(playCalls).toBe(0);

    h.media.bufferedRanges = [[0, 3.5]];
    h.media.dispatchEvent(new Event("progress"));
    await expect(second).resolves.toBeUndefined();
    expect(playCalls).toBe(1);
    h.player.destroy();
  });

  test("prepareAutoplay 后 player.pause 会终止等待且不启动", async () => {
    const h = await harness();
    h.media.paused = true;
    let playCalls = 0;
    h.media.play = () => {
      playCalls += 1;
      h.media.paused = false;
      return Promise.resolve();
    };

    h.player.prepareAutoplay();
    const switching = h.player.switchSource("proxy://live.flv?token=two", "flv", 1000, {
      minBufferedAheadSeconds: 3,
    });
    await settle();
    h.media.dispatchEvent(new Event("loadstart"));
    h.media.readyState = 4;
    h.media.bufferedRanges = [[0, 1]];
    h.media.dispatchEvent(new Event("canplay"));
    await settle();
    expect(playCalls).toBe(0);

    h.player.pause();
    h.media.bufferedRanges = [[0, 3.5]];
    h.media.dispatchEvent(new Event("progress"));
    await expect(switching).resolves.toBeUndefined();
    expect(playCalls).toBe(0);
    expect(h.fallbackCount()).toBe(0);
    h.player.destroy();
  });

  test("prepareAutoplay 后用户暂停仍按成功结算且不启动", async () => {
    const h = await harness();
    h.media.paused = true;
    let canAutoPlay = true;
    let playCalls = 0;
    h.media.play = () => {
      playCalls += 1;
      h.media.paused = false;
      return Promise.resolve();
    };

    h.player.prepareAutoplay();
    const switching = h.player.switchSource("proxy://live.flv?token=two", "flv", 1000, {
      ...STARTUP_BUFFER_OPTIONS,
      canAutoPlay: () => canAutoPlay,
    });
    await settle();
    h.media.dispatchEvent(new Event("loadstart"));
    h.media.readyState = 4;
    h.media.bufferedRanges = [[0, 1]];
    h.media.dispatchEvent(new Event("canplay"));
    await settle();
    expect(playCalls).toBe(0);

    canAutoPlay = false;
    await new Promise((resolve) => setTimeout(resolve, 150));
    await expect(switching).resolves.toBeUndefined();
    expect(playCalls).toBe(0);
    expect(h.fallbackCount()).toBe(0);
    h.player.destroy();
  });

  test("超时、媒体错误与销毁都会拒绝等待并清理", async () => {
    {
      const h = await harness();
      h.media.paused = false;
      h.media.playRequested = true;
      const switching = h.player.switchSource("proxy://live.flv?token=two", "flv", 25, {
        ...STARTUP_BUFFER_OPTIONS,
      });
      await settle();
      h.media.paused = true;
      h.media.dispatchEvent(new Event("loadstart"));
      h.media.readyState = 4;
      h.media.bufferedRanges = [[0, 1]];
      h.media.dispatchEvent(new Event("canplay"));
      await expect(switching).rejects.toThrow("软切换等待媒体就绪超时");
      h.player.destroy();
    }

    {
      const h = await harness();
      h.media.paused = false;
      h.media.playRequested = true;
      const switching = h.player.switchSource("proxy://live.flv?token=two", "flv", 1000, {
        ...STARTUP_BUFFER_OPTIONS,
      });
      await settle();
      h.media.paused = true;
      h.media.readyState = 4;
      h.media.bufferedRanges = [[0, 1]];
      h.media.dispatchEvent(new Event("canplay"));
      h.media.dispatchEvent(new Event("error"));
      await expect(switching).rejects.toBeInstanceOf(Event);
      h.player.destroy();
    }

    {
      const h = await harness();
      h.media.paused = false;
      h.media.playRequested = true;
      const switching = h.player.switchSource("proxy://live.flv?token=two", "flv", 1000, {
        ...STARTUP_BUFFER_OPTIONS,
      });
      await settle();
      h.media.paused = true;
      h.media.readyState = 4;
      h.media.bufferedRanges = [[0, 1]];
      h.media.dispatchEvent(new Event("loadstart"));
      h.media.dispatchEvent(new Event("canplay"));
      h.player.destroy();
      await expect(switching).rejects.toMatchObject({ name: "AbortError" });
    }
  });
});
