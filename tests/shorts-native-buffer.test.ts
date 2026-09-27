import { describe, expect, test } from "bun:test";
import {
  createVideoJsPlayer,
  loadVideoJsModules,
  videoJsDashBufferSettings,
  type VideoJsPlayerModules,
} from "../src/features/room/player/videoJsPlayer";

/** 只桩可观察的媒体副作用；load 会丢缓冲，用来抓角色提升误重载。 */
class Media extends EventTarget {
  currentTime = 0;
  paused = true;
  preload = "metadata";
  src = "";
  loads = 0;
  bufferedSeconds = 0;
  load() {
    this.loads += 1;
    this.bufferedSeconds = 0;
  }
  pause() {
    this.paused = true;
  }
  removeAttribute() {
    this.src = "";
  }
}

function nativePlayer() {
  const media = new Media();
  const player = createVideoJsPlayer(
    {},
    {
      video: media as unknown as HTMLVideoElement,
      kind: "native",
      url: "http://127.0.0.1/one.mp4",
      isLive: false,
    },
  );
  return { media, player };
}

describe("短视频原生播放器复用", () => {
  test("原生加载无需 DASH/HLS 内核", async () => {
    expect(await loadVideoJsModules("native")).toEqual({});
  });

  test("换源保留播放器、媒体及监听，同 URL 不重复 load", () => {
    const { media, player } = nativePlayer();
    let readyEvents = 0;
    player.on("canplay", () => {
      readyEvents += 1;
    });
    media.dispatchEvent(new Event("canplay"));
    expect(media.loads).toBe(1);
    media.currentTime = 13;
    media.dispatchEvent(new Event("ended"));
    expect(player.ended).toBe(true);
    player.switchNativeSource("http://127.0.0.1/two.mp4");
    expect(player.media).toBe(media as unknown as HTMLVideoElement);
    expect(media.src).toBe("http://127.0.0.1/two.mp4");
    expect(media.loads).toBe(2);
    expect(player.ended).toBe(false);
    media.bufferedSeconds = 4;
    player.switchNativeSource("http://127.0.0.1/two.mp4");
    expect(media.loads).toBe(2);
    expect(media.bufferedSeconds).toBe(4);
    media.dispatchEvent(new Event("canplay"));
    expect(readyEvents).toBe(2);
    player.destroy();
    player.destroy();
    expect(media.loads).toBe(3);
    media.dispatchEvent(new Event("canplay"));
    expect(readyEvents).toBe(2);
  });

  test("warm → paused → active 只改 preload，不丢已预热缓冲", () => {
    const { media, player } = nativePlayer();
    media.bufferedSeconds = 5;
    player.setShortsBufferMode("warm");
    expect(media.preload).toBe("auto");
    player.setShortsBufferMode("paused");
    expect(media.preload).toBe("none");
    player.setShortsBufferMode("active");
    expect(media.preload).toBe("auto");
    expect(media.loads).toBe(1);
    expect(media.bufferedSeconds).toBe(5);
    expect(media.src).toBe("http://127.0.0.1/one.mp4");
    expect(media.paused).toBe(true);
    player.destroy();
    const loads = media.loads;
    player.setShortsBufferMode("paused");
    player.switchNativeSource("http://127.0.0.1/three.mp4");
    expect(media.loads).toBe(loads);
    expect(media.src).toBe("");
  });

  test("原生槽位不扩大直播 switchSource 的软切协议边界", async () => {
    const { media, player } = nativePlayer();
    await expect(player.switchSource("http://127.0.0.1/two.mp4", "native")).rejects.toThrow(
      "当前协议不支持软切换",
    );
    expect(media.loads).toBe(1);
    expect(media.src).toBe("http://127.0.0.1/one.mp4");
    player.destroy();
  });
});

class Dash extends EventTarget {
  static last: Dash;
  source: { src?: string; engine?: { dashJs?: unknown } } | null = null;
  scheduleStarts = 0;
  engine = {
    on() {},
    off() {},
    getActiveStream: () => ({
      getStreamProcessors: () => [
        {
          getScheduleController: () => ({
            startScheduleTimer: () => {
              this.scheduleStarts += 1;
            },
          }),
        },
      ],
    }),
  };
  constructor() {
    super();
    Dash.last = this;
  }
  attach() {}
  destroy() {}
  set src(value: string) {
    this.source = { ...this.source, src: value };
  }
}

describe("共用短视频门控保留 DASH 语义", () => {
  test("仍用 2 秒预热预算，并仅在解除暂停门控时恢复调度", () => {
    const player = createVideoJsPlayer({ DashAdapter: Dash } as unknown as VideoJsPlayerModules, {
      video: new Media() as unknown as HTMLVideoElement,
      kind: "dash",
      url: "http://127.0.0.1/one.mpd",
      dash: videoJsDashBufferSettings("warm"),
    });
    const dash = Dash.last;
    player.setShortsBufferMode("warm");
    expect(dash.source?.engine?.dashJs).toEqual(videoJsDashBufferSettings("warm"));
    expect(videoJsDashBufferSettings("warm").streaming?.buffer?.bufferTimeDefault).toBe(2);
    player.setShortsBufferMode("paused");
    expect(dash.scheduleStarts).toBe(0);
    player.setShortsBufferMode("active");
    player.setShortsBufferMode("active");
    expect(dash.scheduleStarts).toBe(1);
    expect(dash.source?.src).toBe("http://127.0.0.1/one.mpd");
    player.switchNativeSource("http://127.0.0.1/native.mp4");
    expect(dash.source?.src).toBe("http://127.0.0.1/one.mpd");
    player.destroy();
  });
});
