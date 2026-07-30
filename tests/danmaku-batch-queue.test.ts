import { describe, expect, test } from "bun:test";
import {
  batchEvents,
  validatedDanmakuBatch,
  validatedBatchEvents,
} from "../src/features/room/danmaku/batch";
import { BoundedQueue } from "../src/features/room/danmaku/boundedQueue";

describe("batched danmaku queue", () => {
  test("keeps the newest bounded items and drains them in FIFO batches", () => {
    const queue = new BoundedQueue<number>(3);
    queue.pushAll([1, 2, 3]);
    expect(queue.take(2)).toEqual([1, 2]);

    // The queue currently holds 3. Adding three more must evict the oldest
    // values without changing the order of the retained messages.
    queue.pushAll([4, 5, 6]);
    expect(queue.length).toBe(3);
    expect(queue.take(2)).toEqual([4, 5]);
    expect(queue.take(10)).toEqual([6]);
    expect(queue.length).toBe(0);
  });

  test("retains FIFO semantics through a 10k-message overflow", () => {
    const queue = new BoundedQueue<number>(4);
    for (let value = 0; value < 10_000; value += 1) queue.push(value);

    expect(queue.take(10)).toEqual([9_996, 9_997, 9_998, 9_999]);
    queue.pushAll([1, 2]);
    queue.clear();
    expect(queue.take(1)).toEqual([]);
  });
});

describe("danmaku batch envelope", () => {
  test("accepts only an array-shaped events field at the native boundary", () => {
    const events = [{ kind: "chat" }];
    expect(batchEvents({ connection_epoch: 1, events })).toBe(events);
    expect(batchEvents({ connection_epoch: 1, events: "not-an-array" })).toEqual([]);
    expect(batchEvents(null)).toEqual([]);
  });

  test("validates each native event once before room views fan out", () => {
    const valid = {
      kind: "chat",
      user: "观众",
      content: "你好",
      color: null,
      is_self: true,
      ts: 1,
    };
    const malformed = { kind: "chat", user: "观众", content: null, color: null, ts: 2 };
    const malformedSelfMarker = {
      kind: "chat",
      user: "观众",
      content: "你好",
      color: null,
      is_self: "true",
      ts: 3,
    };

    expect(validatedBatchEvents({ events: [valid, malformed, malformedSelfMarker] })).toEqual([
      valid,
    ]);
    expect(validatedBatchEvents({ events: "not-an-array" })).toEqual([]);
  });

  test("keeps the native connection fence with a validated batch", () => {
    const event = { kind: "chat", user: "观众", content: "你好", color: null, ts: 1 };

    expect(validatedDanmakuBatch({ connection_epoch: 42, events: [event] })).toEqual({
      connectionEpoch: 42,
      events: [event],
    });
    expect(validatedDanmakuBatch({ events: [event] })).toBeNull();
    expect(validatedDanmakuBatch({ connection_epoch: 1.5, events: [event] })).toBeNull();
  });
});
