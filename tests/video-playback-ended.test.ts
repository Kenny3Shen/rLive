import { describe, expect, test } from "bun:test";
import {
  createVideoJsPlayer,
  type VideoJsPlayerModules,
} from "../src/features/room/player/videoJsPlayer";

class MediaStub extends EventTarget {
  currentTime = 10;
  ended = false;
  paused = true;
  src = "";
  play() {
    this.paused = false;
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  load() {}
  removeAttribute() {}
  seek(time: number) {
    this.currentTime = time;
    this.dispatchEvent(new Event("seeking"));
  }
}

function setup(
  kind: "dash" | "native" = "dash",
  options: { startTime?: number; url?: string } = {},
) {
  const media = new MediaStub();
  const sources: string[] = [];
  const engineEvents = new Map<string, Set<(event: { isLast: boolean }) => void>>();
  class DashStub extends EventTarget {
    engine = {
      on(name: string, callback: (event: { isLast: boolean }) => void) {
        const listeners = engineEvents.get(name) ?? new Set();
        listeners.add(callback);
        engineEvents.set(name, listeners);
      },
      off(name: string, callback: (event: { isLast: boolean }) => void) {
        engineEvents.get(name)?.delete(callback);
      },
    };
    set source(value: { src: string }) {
      sources.push(value.src);
    }
    src = "";
    attach() {}
    destroy() {}
  }
  const player = createVideoJsPlayer(
    { DashAdapter: DashStub as unknown as VideoJsPlayerModules["DashAdapter"] },
    {
      video: media as unknown as HTMLVideoElement,
      kind,
      url: "test.mpd",
      isLive: false,
      ...options,
    },
  );
  let ends = 0;
  player.on("ended", () => {
    ends += 1;
  });
  return {
    media,
    sources,
    player,
    engineEvents,
    get ends() {
      return ends;
    },
    dashEnd(isLast = true) {
      // dash.js 的兜底顺序：seek 到终点、pause、通知 playbackEnded。
      media.seek(10);
      media.pause();
      for (const callback of engineEvents.get("playbackEnded") ?? []) callback({ isLast });
    },
  };
}

describe("DASH 初始续播", () => {
  test("首个 source 携带起播锚点，保留查询及其他锚点且不提前写媒体时间", () => {
    const state = setup("dash", { startTime: 600.25, url: "test.mpd?token=one#period=0&t=4" });
    expect(state.sources).toEqual(["test.mpd?token=one#period=0&t=600.25"]);
    expect(state.media.currentTime).toBe(10);
    state.player.destroy();
  });

  test("无效位置与从头播放不添加锚点，原生音频不套用 DASH 起播参数", () => {
    for (const startTime of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const state = setup("dash", { startTime });
      expect(state.sources).toEqual(["test.mpd"]);
      state.player.destroy();
    }
    const native = setup("native", { startTime: 600, url: "audio.mp4" });
    expect(native.media.src).toBe("audio.mp4");
    expect(native.media.currentTime).toBe(10);
    native.player.destroy();
  });
});

describe("播放结束信号", () => {
  test("DASH 只有引擎结束事件且原生 ended 为 false 时仍通知连播", () => {
    const state = setup();
    state.dashEnd();
    expect(state.media.ended).toBe(false);
    expect(state.player.ended).toBe(true);
    expect(state.ends).toBe(1);
    // 引擎 seek 排队的 seeking 事件可能晚于 playbackEnded 到达。
    state.media.dispatchEvent(new Event("seeking"));
    expect(state.player.ended).toBe(true);
    state.player.destroy();
  });

  test("原生结束与 DASH 结束无论先后都只触发一次", () => {
    for (const nativeFirst of [true, false]) {
      const state = setup();
      const nativeEnd = () => state.media.dispatchEvent(new Event("ended"));
      if (nativeFirst) nativeEnd();
      state.dashEnd();
      nativeEnd();
      state.dashEnd();
      expect(state.ends).toBe(1);
      state.player.destroy();
    }
  });

  test("DASH 中间 Period 结束不触发切集", () => {
    const state = setup();
    state.dashEnd(false);
    expect(state.ends).toBe(0);
    expect(state.player.ended).toBe(false);
    state.player.destroy();
  });

  test("重播与回退进度取消结束状态，下次播完仍通知", async () => {
    const state = setup();
    state.dashEnd();
    state.media.seek(2);
    expect(state.player.ended).toBe(false);
    state.dashEnd();
    expect(state.ends).toBe(2);
    await state.media.play();
    expect(state.player.ended).toBe(false);
    state.dashEnd();
    expect(state.ends).toBe(3);
    state.player.destroy();
  });

  test("换源与销毁后不沿用旧结束状态或监听", () => {
    const state = setup();
    state.dashEnd();
    state.player.switchDashSource("next.mpd");
    expect(state.player.ended).toBe(false);
    state.player.destroy();
    expect(state.engineEvents.get("playbackEnded")?.size).toBe(0);
    state.dashEnd();
    state.media.dispatchEvent(new Event("ended"));
    expect(state.ends).toBe(1);
  });

  test("仅音频等原生媒体保持 ended 通知", () => {
    const state = setup("native");
    state.media.dispatchEvent(new Event("ended"));
    expect(state.ends).toBe(1);
    expect(state.player.ended).toBe(true);
    state.player.destroy();
  });
});
