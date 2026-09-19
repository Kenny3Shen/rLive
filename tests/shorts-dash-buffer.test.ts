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

/** `getScheduleController().startScheduleTimer()` 的调用记录（短视频第二分片回归）。 */
const scheduleStarts: string[] = [];

class Dash extends EventTarget {
  static last: Dash;
  source: { src?: string; engine?: { dashJs?: unknown } } | null = null;
  destroyed = false;
  handlers = new Map<string, (event: unknown) => void>();
  engine = {
    on: (name: string, handler: (event: unknown) => void) => this.handlers.set(name, handler),
    off: (name: string) => this.handlers.delete(name),
    /**
     * 只桩两件事：轨道与其调度控制器。`paused` 闸门靠 `setDashBufferMode` 解除，
     * 而 dash.js 不会因此重启调度 —— 被测的就是这里有没有补上那一次。
     */
    getActiveStream: () => ({
      getStreamProcessors: () => this.processors,
    }),
  };
  processors: { type: string; getScheduleController: () => object }[] = [
    {
      type: "video",
      getScheduleController: () => ({
        startScheduleTimer: () => scheduleStarts.push("video"),
      }),
    },
    {
      type: "audio",
      getScheduleController: () => ({
        startScheduleTimer: () => scheduleStarts.push("audio"),
      }),
    },
  ];
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

function create(dash: unknown = Dash) {
  return createVideoJsPlayer({ DashAdapter: dash } as unknown as VideoJsPlayerModules, {
    video: new Media() as unknown as HTMLVideoElement,
    kind: "dash",
    url: "http://localhost/one.mpd",
    dash: videoJsDashBufferSettings("warm"),
  });
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
    const player = create();
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

  /**
   * 回归：预热槽位提升为活动后第二分片再也取不下来。
   *
   * dash.js 的 `scheduleWhilePaused: false` 会清掉调度定时器，而改回 `true`
   * 只是改一个值 —— 定时器不会重建；`PLAYBACK_STARTED` 那条自愈路径又恰好不覆盖
   * 「闸门解除时媒体仍暂停」的短视频序列。因此 `paused` → 非 `paused` 的转换必须
   * 自己补一次调度，否则媒体播完已缓冲的 2 秒就会永久停在 `waiting`。
   */
  test("解除 paused 闸门时重启各轨调度，重复调用不重复补", () => {
    scheduleStarts.length = 0;
    const player = create();
    // warm → paused（预热到 canplay 后的禁调度）：闸门本身不触发调度。
    player.setDashBufferMode("paused");
    expect(scheduleStarts).toEqual([]);
    // paused → active（槽位提升）：两条轨道各补一次。
    player.setDashBufferMode("active");
    expect(scheduleStarts).toEqual(["video", "audio"]);
    // active → warm（角色回退到预热）：没有闸门被解除，不该再补。
    player.setDashBufferMode("warm");
    player.setDashBufferMode("active");
    expect(scheduleStarts).toEqual(["video", "audio"]);
    // 同一模式重复设置是空操作。
    player.setDashBufferMode("paused");
    player.setDashBufferMode("paused");
    expect(scheduleStarts).toEqual(["video", "audio"]);
    player.setDashBufferMode("active");
    expect(scheduleStarts).toEqual(["video", "audio", "video", "audio"]);
    player.destroy();
  });

  /** 换源会重置 dash.js 的播放控制器与调度定时器，闸门快照必须一并作废。 */
  test("换源后重新建立的闸门照常重启调度", () => {
    scheduleStarts.length = 0;
    const player = create();
    player.setDashBufferMode("paused");
    player.switchDashSource("http://localhost/two.mpd");
    // 新源的调度由 dash.js 自己在 attachSource 里启动；换源本身不补。
    expect(scheduleStarts).toEqual([]);
    player.setDashBufferMode("paused");
    player.setDashBufferMode("active");
    expect(scheduleStarts).toEqual(["video", "audio"]);
    player.destroy();
  });
});
