import { describe, expect, test } from "bun:test";
import type { DanmuJsBullet, DanmuJsInstance } from "danmu.js";
import {
  releaseDanmuJsFreezeLock,
  releaseDanmuJsPin,
  removeDanmuJsPin,
  resumeDanmuJsPin,
} from "../src/features/room/danmaku/danmuJsPin";

type FakeBullet = DanmuJsBullet & {
  status: string;
  startMove: (force?: boolean) => void;
};

/**
 * 镜像钉住真正触碰到的 danmu.js 1.2.1 部分：唯一的全局冻结槽位、渲染队列，
 * 以及 `restartComment` 在主循环关闭后拒绝行动的行为。
 */
function fakeInstance(
  options: {
    mainStatus?: "idle" | "paused" | "playing" | "closed";
    /** `restartComment` 是否能靠自身离开 `forcedPause`。 */
    restartWorks?: boolean;
    /** 强制的 `startMove` 是否能离开 `forcedPause`。 */
    forceWorks?: boolean;
  } = {},
) {
  const { mainStatus = "playing", restartWorks = false, forceWorks = true } = options;
  const forcedMoves: boolean[] = [];
  const removed: string[] = [];
  const restarted: string[] = [];

  const bullet: FakeBullet = {
    id: "pinned",
    status: "forcedPause",
    startMove(force) {
      forcedMoves.push(force === true);
      if (forceWorks) bullet.status = "start";
    },
  } as FakeBullet;

  const instance = {
    main: { status: mainStatus, queue: [bullet] },
    freezeId: "pinned",
    mouseControl: true,
    restartComment(id: string) {
      restarted.push(id);
      instance.freezeId = null;
      instance.mouseControl = false;
      // danmu.js 只在主循环暂停时把 bullet 标记为 `paused`；
      // 真正让它重新移动的是下一次 `play()`。
      if (mainStatus === "paused") bullet.status = "paused";
      else if (restartWorks) bullet.status = "start";
    },
    removeComment(id: string) {
      removed.push(id);
    },
  } as unknown as DanmuJsInstance & {
    freezeId: string | null;
    mouseControl: boolean;
  };

  return { instance, bullet, forcedMoves, removed, restarted };
}

describe("danmu.js pin lifecycle", () => {
  test("hands the global freeze slot back so later presses still hit", () => {
    const { instance } = fakeInstance();

    releaseDanmuJsFreezeLock(instance, "pinned");

    expect(instance.freezeId).toBeNull();
    expect(instance.mouseControl).toBe(false);
  });

  test("leaves a freeze slot alone when another pin already took it", () => {
    const { instance } = fakeInstance();
    instance.freezeId = "someone-else";

    releaseDanmuJsFreezeLock(instance, "pinned");

    expect(instance.freezeId).toBe("someone-else");
    expect(instance.mouseControl).toBe(true);
  });

  test("forces the bullet to move when restartComment leaves it parked", () => {
    const { instance, bullet, forcedMoves, restarted } = fakeInstance();

    expect(resumeDanmuJsPin(instance, "pinned")).toBe(true);

    expect(restarted).toEqual(["pinned"]);
    expect(forcedMoves).toEqual([true]);
    expect(bullet.status).toBe("start");
  });

  test("does not force a bullet restartComment already revived", () => {
    const { instance, forcedMoves } = fakeInstance({ restartWorks: true });

    expect(resumeDanmuJsPin(instance, "pinned")).toBe(true);

    expect(forcedMoves).toEqual([]);
  });

  test("accepts the paused state a paused main loop restarts into", () => {
    const { instance, bullet, forcedMoves } = fakeInstance({ mainStatus: "paused" });

    expect(resumeDanmuJsPin(instance, "pinned")).toBe(true);

    expect(bullet.status).toBe("paused");
    expect(forcedMoves).toEqual([]);
  });

  test("reports failure when the bullet stays parked, so the caller removes it", () => {
    // 元素已消失的 bullet 永远不会离开 `paused`，
    // 运行中的主循环也不会再回到它身上。
    const { instance, bullet } = fakeInstance({ forceWorks: false });

    expect(resumeDanmuJsPin(instance, "pinned")).toBe(false);
    expect(bullet.status).toBe("paused");
  });

  test("reports failure on a closed main loop instead of calling restartComment", () => {
    const { instance, restarted, forcedMoves } = fakeInstance({ mainStatus: "closed" });

    expect(resumeDanmuJsPin(instance, "pinned")).toBe(false);
    expect(restarted).toEqual([]);
    expect(forcedMoves).toEqual([]);
    // 即使无法恢复 bullet，冻结槽位也要被释放。
    expect(instance.freezeId).toBeNull();
  });

  test("treats a bullet that already left the queue as resumed", () => {
    const { instance, restarted } = fakeInstance();
    (instance as unknown as { main: { queue: unknown[] } }).main.queue = [];

    expect(resumeDanmuJsPin(instance, "pinned")).toBe(true);
    expect(restarted).toEqual([]);
  });

  test("downgrades forcedPause before removing, so nothing revives parked", () => {
    const { instance, bullet, removed } = fakeInstance();

    removeDanmuJsPin(instance, "pinned");

    expect(bullet.status).toBe("paused");
    expect(removed).toEqual(["pinned"]);
    expect(instance.freezeId).toBeNull();
  });

  test("releases without restarting or removing when the bullet is being dropped", () => {
    const { instance, bullet, removed, restarted, forcedMoves } = fakeInstance();

    releaseDanmuJsPin(instance, "pinned");

    expect(bullet.status).toBe("paused");
    expect(removed).toEqual([]);
    expect(restarted).toEqual([]);
    expect(forcedMoves).toEqual([]);
    expect(instance.freezeId).toBeNull();
  });

  test("stays inert on a destroyed instance", () => {
    // `DanmuJs.destroy()` 会删除包括方法在内的所有自身属性。
    const destroyed = {} as DanmuJsInstance;

    expect(() => releaseDanmuJsFreezeLock(destroyed, "pinned")).not.toThrow();
    expect(() => releaseDanmuJsPin(destroyed, "pinned")).not.toThrow();
    expect(() => removeDanmuJsPin(destroyed, "pinned")).not.toThrow();
    expect(resumeDanmuJsPin(destroyed, "pinned")).toBe(true);
  });
});
