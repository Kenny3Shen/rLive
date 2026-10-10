import { describe, expect, test } from "bun:test";
import type { DanmuJsInstance } from "danmu.js";
import {
  createDanmuJsPlayback,
  removeDanmuJsComment,
} from "../src/features/room/danmaku/danmuJsCompat";
import { removeDanmuJsPin } from "../src/features/room/danmaku/danmuJsPin";

/** 复现 danmu.js 1.2.1 同步 bullet_remove 监听器对 filter 中队列的 splice。 */
function fixture() {
  const detached: string[] = [];
  const elements = new Set(["first", "next", "later"]);
  const tracks = new Set(elements);
  const bullets = [...elements].map((id) => ({
    id,
    status: "started",
    remove() {
      if (this.status !== "forcedPause") this.status = "paused";
      elements.delete(id);
      tracks.delete(id);
      detached.push(id);
      const index = main.queue.findIndex((bullet) => bullet.id === id);
      if (index >= 0) main.queue.splice(index, 1);
    },
  }));
  const main = {
    status: "playing",
    queue: [...bullets],
    data: [...elements, "pending"].map((id) => ({ id })),
  };
  const instance = {
    main,
    freezeId: "first" as string | null,
    mouseControl: true,
    removeComment(id: string) {
      if (this.freezeId === id) {
        this.freezeId = null;
        this.mouseControl = false;
      }
      main.queue = main.queue.filter((bullet) => {
        if (bullet.id !== id) return true;
        bullet.remove();
        return false;
      });
      main.data = main.data.filter((comment) => comment.id !== id);
    },
  };
  return {
    instance: instance as unknown as DanmuJsInstance,
    internal: instance,
    main,
    bullets,
    detached,
    elements,
    tracks,
  };
}

describe("danmu.js 安全移除", () => {
  test("原生 filter + splice 会使相邻弹幕失去跟踪但残留在屏", () => {
    const { instance, main, elements, tracks } = fixture();
    instance.removeComment("first");
    expect(main.queue.map((bullet) => bullet.id)).toEqual(["later"]);
    expect(elements.has("next")).toBe(true);
    expect(tracks.has("next")).toBe(true);
  });

  test("只清理目标，保留相邻弹幕的队列、DOM 与车道", () => {
    const { instance, internal, main, detached, elements, tracks } = fixture();
    removeDanmuJsComment(instance, "first");
    expect(main.queue.map((bullet) => bullet.id)).toEqual(["next", "later"]);
    expect([...elements]).toEqual(["next", "later"]);
    expect([...tracks]).toEqual(["next", "later"]);
    expect(detached).toEqual(["first"]);
    expect(main.data.map((comment) => comment.id)).toEqual(["next", "later", "pending"]);
    expect(internal.freezeId).toBeNull();
    expect(internal.mouseControl).toBe(false);

    removeDanmuJsComment(instance, "next");
    expect(main.queue.map((bullet) => bullet.id)).toEqual(["later"]);
    removeDanmuJsComment(instance, "later");
    expect(main.queue).toEqual([]);
    expect(elements.size).toBe(0);
    expect(tracks.size).toBe(0);
    expect(detached).toEqual(["first", "next", "later"]);
  });

  test("清理待发、未知或已移除的 id 不影响在屏弹幕", () => {
    const { instance, main, detached } = fixture();
    removeDanmuJsComment(instance, "pending");
    removeDanmuJsComment(instance, "pending");
    removeDanmuJsComment(instance, "missing");
    expect(main.queue.map((bullet) => bullet.id)).toEqual(["first", "next", "later"]);
    expect(main.data.map((comment) => comment.id)).toEqual(["first", "next", "later"]);
    expect(detached).toEqual([]);
  });

  test("移除钉住弹幕也走安全路径并释放强制暂停", () => {
    const { instance, main, bullets, internal } = fixture();
    bullets[0]!.status = "forcedPause";
    removeDanmuJsPin(instance, "first");
    expect(bullets[0]!.status).toBe("paused");
    expect(internal.freezeId).toBeNull();
    expect(main.queue.map((bullet) => bullet.id)).toEqual(["next", "later"]);
  });

  test("实例销毁后清理无副作用", () => {
    const instance = {} as DanmuJsInstance;
    expect(() => removeDanmuJsComment(instance, "first")).not.toThrow();
    expect(() => removeDanmuJsPin(instance, "first")).not.toThrow();
  });
});

/** 最小化的 danmu.js 实例：原生 pauseMove/startMove 对 `paused`/`start` 早退，与 1.2.1 一致。 */
function playbackFixture() {
  const calls: string[] = [];
  const animation = (property: string) => ({
    transitionProperty: property,
    playState: "running" as AnimationPlayState,
    pause() {
      this.playState = "paused";
      calls.push(`pause:${property}`);
    },
    play() {
      this.playState = "running";
      calls.push(`play:${property}`);
    },
  });
  const element = (animations: ReturnType<typeof animation>[]) => ({
    isConnected: true,
    getAnimations: () => animations,
  });
  const scrollAnimation = animation("transform");
  const bullets = [
    {
      id: "scroll",
      mode: "scroll",
      status: "start",
      _lastMoveTime: 1_000,
      el: element([scrollAnimation]),
    },
    { id: "top", mode: "top", status: "start", el: element([animation("visibility")]) },
    { id: "waiting", mode: "scroll", status: "waiting", el: element([]) },
  ];
  let updates = 0;
  const instance = {
    state: { bullets },
    main: { channel: { addBullet: () => null, updatePos: () => updates++ } },
    pause() {
      calls.push("instance.pause");
      for (const bullet of bullets) if (bullet.status !== "paused") bullet.status = "paused";
    },
    play() {
      calls.push("instance.play");
      for (const bullet of bullets) if (bullet.status === "paused") bullet.status = "start";
    },
  } as unknown as DanmuJsInstance;
  return { instance, bullets, scrollAnimation, calls, updates: () => updates };
}

describe("danmu.js 滚动弹幕暂停", () => {
  test("只用 WAAPI 定格运行中的滚动 transition，其余交给原生暂停", () => {
    const { instance, bullets, scrollAnimation, calls, updates } = playbackFixture();
    createDanmuJsPlayback(instance).pause();
    expect(scrollAnimation.playState).toBe("paused");
    expect(calls).toEqual(["pause:transform", "instance.pause"]);
    expect(bullets.map((bullet) => bullet.status)).toEqual(["paused", "paused", "paused"]);
    expect(updates()).toBe(1);
  });

  test("恢复同一条动画并顺延车道判定的墙钟起点", () => {
    const { instance, bullets, scrollAnimation, calls } = playbackFixture();
    const playback = createDanmuJsPlayback(instance);
    const now = Date.now;
    try {
      Date.now = () => 5_000;
      playback.pause();
      Date.now = () => 7_500;
      playback.play();
    } finally {
      Date.now = now;
    }
    expect(scrollAnimation.playState).toBe("running");
    expect(bullets[0]!._lastMoveTime).toBe(3_500);
    expect(calls).toEqual(["pause:transform", "instance.pause", "play:transform", "instance.play"]);
  });

  test("重复暂停不重新计时，也不重复接管", () => {
    const { instance, bullets, calls } = playbackFixture();
    const playback = createDanmuJsPlayback(instance);
    const now = Date.now;
    try {
      Date.now = () => 5_000;
      playback.pause();
      Date.now = () => 6_000;
      playback.pause();
      Date.now = () => 8_000;
      playback.play();
    } finally {
      Date.now = now;
    }
    expect(calls.filter((call) => call === "pause:transform")).toHaveLength(1);
    expect(bullets[0]!._lastMoveTime).toBe(4_000);
  });

  test("暂停期间被点选冻结的弹幕不被 WAAPI 拉起", () => {
    const { instance, bullets, scrollAnimation, calls } = playbackFixture();
    const playback = createDanmuJsPlayback(instance);
    playback.pause();
    bullets[0]!.status = "forcedPause";
    playback.play();
    expect(scrollAnimation.playState).toBe("paused");
    expect(calls).not.toContain("play:transform");
  });

  test("已取消的 transition 与 seek 清屏后的记录不复活", () => {
    const cancelled = playbackFixture();
    const playback = createDanmuJsPlayback(cancelled.instance);
    playback.pause();
    cancelled.scrollAnimation.playState = "idle";
    playback.play();
    expect(cancelled.calls).not.toContain("play:transform");

    const seeked = playbackFixture();
    const cleared = createDanmuJsPlayback(seeked.instance);
    cleared.pause();
    cleared.clear();
    cleared.play();
    expect(seeked.calls).not.toContain("play:transform");
  });
});
