import { describe, expect, test } from "bun:test";
import {
  createVideoJsPlayer,
  videoJsDashBufferSettings,
  type VideoJsPlayerModules,
} from "../src/features/room/player/videoJsPlayer";

class Media extends EventTarget {
  currentTime = 0;
  paused = true;
  src = "";
  load() {}
  pause() {
    this.paused = true;
  }
  removeAttribute() {
    this.src = "";
  }
}

class Dash extends EventTarget {
  static last: Dash;
  source: { src?: string; engine?: { dashJs?: unknown } } | null = null;
  destroyed = false;
  handlers = new Map<string, (event: unknown) => void>();
  engine = {
    on: (name: string, handler: (event: unknown) => void) => this.handlers.set(name, handler),
    off: (name: string) => this.handlers.delete(name),
  };
  constructor() {
    super();
    Dash.last = this;
  }
  attach() {}
  destroy() {
    this.destroyed = true;
  }
  set src(value: string) {
    this.source = { ...this.source, src: value };
  }
}

describe("短视频 DASH 缓冲策略", () => {
  test("预热仅有小缓冲目标，暂停后禁止新增分片调度", () => {
    const warm = videoJsDashBufferSettings("warm").streaming!;
    expect(warm.buffer?.bufferTimeDefault).toBe(2);
    expect(warm.buffer?.bufferTimeAtTopQuality).toBe(2);
    expect(warm.buffer?.bufferTimeAtTopQualityLongForm).toBe(2);
    expect(warm.scheduling?.scheduleWhilePaused).toBe(true);
    expect(videoJsDashBufferSettings("paused").streaming?.scheduling?.scheduleWhilePaused).toBe(
      false,
    );
    expect(videoJsDashBufferSettings("active").streaming?.buffer?.bufferTimeDefault).toBe(18);
  });

  test("共享播放器可原位改预算、换源、持续报错与幂等销毁", () => {
    const player = createVideoJsPlayer({ DashAdapter: Dash } as unknown as VideoJsPlayerModules, {
      video: new Media() as unknown as HTMLVideoElement,
      kind: "dash",
      url: "http://localhost/one.mpd",
      dash: videoJsDashBufferSettings("warm"),
    });
    const dash = Dash.last;
    player.setDashBufferMode("paused");
    expect(dash.source?.src).toBe("http://localhost/one.mpd");
    expect(dash.source?.engine?.dashJs).toEqual(videoJsDashBufferSettings("paused"));
    player.switchDashSource("http://localhost/two.mpd");
    player.setDashBufferMode("active");
    expect(Dash.last).toBe(dash);
    expect(dash.source?.src).toBe("http://localhost/two.mpd");
    const errors: unknown[] = [];
    player.on("error", (error) => errors.push(error));
    dash.handlers.get("error")?.({ error: "第二条出错" });
    expect(errors).toEqual(["第二条出错"]);
    player.destroy();
    player.destroy();
    expect(dash.destroyed).toBe(true);
    expect(dash.handlers.size).toBe(0);
  });
});
