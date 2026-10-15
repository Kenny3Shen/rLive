import { expect, test } from "bun:test";
import type { DanmakuEvent } from "../src/shared/types/live";
import {
  DANMAKU_MAX_PENDING_COMMENTS,
  DANMAKU_PENDING_MAX_AGE_MS,
  enqueueDanmakuPending,
  flushDanmakuPending,
  type DanmakuPendingEvent,
} from "../src/features/room/danmaku/pendingQueue";

function chat(content: string, ts = 1): DanmakuEvent {
  return { kind: "chat", user: "观众", content, color: null, ts };
}

const contents = (events: readonly DanmakuEvent[]): string[] =>
  events.map((event) => (event.kind === "chat" ? event.content : ""));

test("入队保留事件并记录同一批次的时间戳", () => {
  const queue: DanmakuPendingEvent[] = [];
  enqueueDanmakuPending(queue, [chat("a"), chat("b")], 1_000);
  expect(queue).toEqual([
    { event: chat("a"), queuedAt: 1_000 },
    { event: chat("b"), queuedAt: 1_000 },
  ]);
});

test("空批次不入队", () => {
  const queue: DanmakuPendingEvent[] = [];
  enqueueDanmakuPending(queue, [], 1_000);
  expect(queue).toEqual([]);
});

test("溢出丢弃最旧的事件，保留最新的一批", () => {
  const queue: DanmakuPendingEvent[] = [];
  enqueueDanmakuPending(queue, [chat("old-1"), chat("old-2")], 1_000, 3);
  enqueueDanmakuPending(queue, [chat("new-1"), chat("new-2")], 2_000, 3);
  expect(contents(flushDanmakuPending(queue, 2_000, Infinity))).toEqual([
    "old-2",
    "new-1",
    "new-2",
  ]);
});

test("单批就超出容量时只留该批的尾部", () => {
  const queue: DanmakuPendingEvent[] = [];
  enqueueDanmakuPending(queue, [chat("a"), chat("b"), chat("c")], 1_000, 2);
  expect(contents(flushDanmakuPending(queue, 1_000, Infinity))).toEqual(["b", "c"]);
});

test.each([
  [0, [] as string[]],
  [1, ["c"]],
  [5, ["a", "b", "c"]],
])("容量 %i 时保留对应条数", (capacity, expected) => {
  const queue: DanmakuPendingEvent[] = [];
  enqueueDanmakuPending(queue, [chat("a"), chat("b"), chat("c")], 1_000, capacity);
  expect(contents(flushDanmakuPending(queue, 1_000, Infinity))).toEqual(expected);
});

test("容量非有限值回落默认上限", () => {
  const queue: DanmakuPendingEvent[] = [];
  const events = Array.from({ length: DANMAKU_MAX_PENDING_COMMENTS + 10 }, (_, index) =>
    chat(`m-${index}`),
  );
  enqueueDanmakuPending(queue, events, 1_000, Number.NaN);
  expect(queue.length).toBe(DANMAKU_MAX_PENDING_COMMENTS);
  expect(queue[0]!.event).toEqual(chat("m-10"));
});

test("flush 取空队列：重复调用不再返回事件", () => {
  const queue: DanmakuPendingEvent[] = [];
  enqueueDanmakuPending(queue, [chat("a")], 1_000);
  expect(contents(flushDanmakuPending(queue, 1_000, Infinity))).toEqual(["a"]);
  expect(queue).toEqual([]);
  expect(flushDanmakuPending(queue, 1_000, Infinity)).toEqual([]);
});

test("超龄事件被丢弃，未超龄的按原顺序重放", () => {
  const queue: DanmakuPendingEvent[] = [];
  enqueueDanmakuPending(queue, [chat("stale")], 0);
  enqueueDanmakuPending(queue, [chat("fresh")], 4_000);
  expect(contents(flushDanmakuPending(queue, 5_001, DANMAKU_PENDING_MAX_AGE_MS))).toEqual([
    "fresh",
  ]);
});

test("年龄恰好等于上限时仍然有效", () => {
  const queue: DanmakuPendingEvent[] = [];
  enqueueDanmakuPending(queue, [chat("edge")], 1_000);
  expect(contents(flushDanmakuPending(queue, 1_000 + DANMAKU_PENDING_MAX_AGE_MS))).toEqual([
    "edge",
  ]);
});

test("年龄超过上限一毫秒即丢弃", () => {
  const queue: DanmakuPendingEvent[] = [];
  enqueueDanmakuPending(queue, [chat("edge")], 1_000);
  expect(flushDanmakuPending(queue, 1_001 + DANMAKU_PENDING_MAX_AGE_MS)).toEqual([]);
});

test("上限为零时只有同一毫秒入队的事件有效", () => {
  const queue: DanmakuPendingEvent[] = [];
  enqueueDanmakuPending(queue, [chat("a")], 1_000);
  expect(contents(flushDanmakuPending(queue, 1_000, 0))).toEqual(["a"]);
  enqueueDanmakuPending(queue, [chat("b")], 1_000);
  expect(flushDanmakuPending(queue, 1_001, 0)).toEqual([]);
});

test("上限非有限值回落默认值", () => {
  const queue: DanmakuPendingEvent[] = [];
  enqueueDanmakuPending(queue, [chat("a")], 0);
  expect(flushDanmakuPending(queue, DANMAKU_PENDING_MAX_AGE_MS, Number.NaN)).toHaveLength(1);
  enqueueDanmakuPending(queue, [chat("b")], 0);
  expect(flushDanmakuPending(queue, DANMAKU_PENDING_MAX_AGE_MS + 1, Number.NaN)).toEqual([]);
});

test("默认年龄上限是 5 秒", () => {
  const queue: DanmakuPendingEvent[] = [];
  enqueueDanmakuPending(queue, [chat("a")], 0);
  expect(flushDanmakuPending(queue, DANMAKU_PENDING_MAX_AGE_MS)).toHaveLength(1);
  enqueueDanmakuPending(queue, [chat("b")], 0);
  expect(flushDanmakuPending(queue, DANMAKU_PENDING_MAX_AGE_MS + 1)).toEqual([]);
});
