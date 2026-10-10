import { describe, expect, test } from "bun:test";
import type { DanmuJsInstance } from "danmu.js";
import { removeDanmuJsComment } from "../src/features/room/danmaku/danmuJsCompat";
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
