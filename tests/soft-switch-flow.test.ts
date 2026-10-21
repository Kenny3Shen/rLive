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
