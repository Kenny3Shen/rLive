import { describe, expect, test } from "bun:test";
import { PendingPlaybackRequests } from "../src/features/shorts/pendingPlaybackRequests";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("短视频取流所有权", () => {
  test("取消不能中止 invoke，但迟到的成功结果立即释放", async () => {
    const stopped: object[] = [];
    const pool = new PendingPlaybackRequests<object>((info) => stopped.push(info));
    const controller = new AbortController();
    const pending = deferred<object>();
    const request = pool.acquire(controller.signal, () => pending.promise);
    controller.abort();
    const info = {};
    pending.resolve(info);
    await expect(request).rejects.toHaveProperty("name", "AbortError");
    pool.clear();
    expect(stopped).toEqual([info]);
  });

  test("卸载释放尚未提交的结果与在途结果，且不会重复释放", async () => {
    const stopped: object[] = [];
    const pool = new PendingPlaybackRequests<object>((info) => stopped.push(info));
    const info = {};
    await pool.acquire(new AbortController().signal, async () => info);
    const pending = deferred<object>();
    const request = pool.acquire(new AbortController().signal, () => pending.promise);
    pool.clear();
    pool.clear();
    const late = {};
    pending.resolve(late);
    await expect(request).rejects.toHaveProperty("name", "AbortError");
    expect(stopped).toEqual([info, late]);
  });

  test("claim 后仅槽位持有，取消与请求池清理不能误停它", async () => {
    const stopped: object[] = [];
    const pool = new PendingPlaybackRequests<object>((info) => stopped.push(info));
    const controller = new AbortController();
    const info = await pool.acquire(controller.signal, async () => ({}));
    pool.claim(info);
    controller.abort();
    pool.clear();
    expect(stopped).toEqual([]);
  });

  test("已返回未接管时取消释放一次；清理后能建立新请求", async () => {
    const stopped: object[] = [];
    const pool = new PendingPlaybackRequests<object>((info) => stopped.push(info));
    const controller = new AbortController();
    const info = await pool.acquire(controller.signal, async () => ({}));
    controller.abort();
    pool.clear();
    const next = await pool.acquire(new AbortController().signal, async () => ({}));
    pool.claim(next);
    pool.clear();
    expect(stopped).toEqual([info]);
  });

  test("已取消的请求不进入 IPC；失败请求不残留资源", async () => {
    const pool = new PendingPlaybackRequests<object>(() => {
      throw new Error("不应释放");
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      pool.acquire(controller.signal, async () => {
        throw new Error("不应调用");
      }),
    ).rejects.toHaveProperty("name", "AbortError");
    await expect(
      pool.acquire(new AbortController().signal, async () => {
        throw new Error("上游失败");
      }),
    ).rejects.toThrow("上游失败");
    pool.clear();
  });
});
