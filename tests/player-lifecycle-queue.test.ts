import { describe, expect, test } from "bun:test";
import { createSerialTaskQueue } from "../src/features/room/player/serialTaskQueue";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("播放器生命周期串行队列", () => {
  test("同实例的启动、切源、停止按入队顺序执行，并保留返回值", async () => {
    const queue = createSerialTaskQueue();
    const entered = deferred();
    const release = deferred();
    const calls: string[] = [];
    const start = queue.enqueue(async () => {
      calls.push("start");
      entered.resolve();
      await release.promise;
      calls.push("started");
      return "session";
    });
    const change = queue.enqueue(() => calls.push("switch"));
    const stop = queue.enqueue(() => calls.push("stop"));
    await entered.promise;
    expect(calls).toEqual(["start"]);
    release.resolve();
    expect(await start).toBe("session");
    await Promise.all([change, stop]);
    expect(calls).toEqual(["start", "started", "switch", "stop"]);
  });

  test("一路等待媒体就绪不阻塞其他五路的启动和停止", async () => {
    const queues = Array.from({ length: 6 }, createSerialTaskQueue);
    const entered = deferred();
    const release = deferred();
    let blockedFinished = false;
    const blocked = queues[0].enqueue(async () => {
      entered.resolve();
      await release.promise;
      blockedFinished = true;
    });
    await entered.promise;
    try {
      const calls: number[] = [];
      await Promise.all(
        queues.slice(1).map(async (queue, index) => {
          await queue.enqueue(() => calls.push(index));
          await queue.enqueue(() => calls.push(index));
        }),
      );
      expect(blockedFinished).toBe(false);
      expect(calls).toHaveLength(10);
      for (let index = 0; index < 5; index += 1) {
        expect(calls.filter((item) => item === index)).toHaveLength(2);
      }
    } finally {
      release.resolve();
      await blocked;
    }
  });

  test("异步失败传给调用者，但不阻断已经排队的清理", async () => {
    const queue = createSerialTaskQueue();
    const error = new Error("代理启动失败");
    const failed = queue.enqueue(async () => {
      throw error;
    });
    const cleanup = queue.enqueue(() => "stopped");
    await expect(failed).rejects.toBe(error);
    expect(await cleanup).toBe("stopped");
    expect(await queue.enqueue(() => "restarted")).toBe("restarted");
  });

  test("同步异常同样不会使队列永久失败", async () => {
    const queue = createSerialTaskQueue();
    const failed = queue.enqueue(() => {
      throw new Error("适配器初始化失败");
    });
    const cleanup = queue.enqueue(() => "stopped");
    await expect(failed).rejects.toThrow("适配器初始化失败");
    expect(await cleanup).toBe("stopped");
  });
});
