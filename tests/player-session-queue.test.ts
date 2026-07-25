import { describe, expect, test } from "bun:test";
import { createSerialTaskQueue } from "../src/features/room/player/serialTaskQueue";
import { playUrlKey } from "../src/features/room/player/useWebPlayer";

describe("player session queue", () => {
  test("does not start the replacement until the prior lifecycle has finished", async () => {
    const queue = createSerialTaskQueue();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.enqueue(async () => {
      order.push("first:start");
      await firstGate;
      order.push("first:end");
    });
    const second = queue.enqueue(() => {
      order.push("second:start");
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  test("continues after a failed lifecycle operation", async () => {
    const queue = createSerialTaskQueue();
    const order: string[] = [];

    await expect(
      queue.enqueue(() => {
        order.push("failed");
        throw new Error("expected failure");
      }),
    ).rejects.toThrow("expected failure");

    await queue.enqueue(() => {
      order.push("replacement");
    });

    expect(order).toEqual(["failed", "replacement"]);
  });

  test("keeps an equivalent play source stable across query object replacement", () => {
    const first = playUrlKey({
      url: "https://cdn.example/live.flv",
      headers: { Referer: "https://example/", Cookie: "SESS=one" },
    });
    const equivalent = playUrlKey({
      url: "https://cdn.example/live.flv",
      headers: { Cookie: "SESS=one", Referer: "https://example/" },
    });
    const changed = playUrlKey({
      url: "https://cdn.example/live.flv",
      headers: { Cookie: "SESS=two", Referer: "https://example/" },
    });

    expect(equivalent).toBe(first);
    expect(changed).not.toBe(first);
  });
});
