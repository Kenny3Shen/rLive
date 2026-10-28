import { describe, expect, test } from "bun:test";
import {
  consumeDetailsResizeDeltas,
  createDetailsResizeFrameQueue,
  type DetailsResizeFrameBounds,
} from "../src/shared/gestures/detailsResizeFrame";

const bounds: DetailsResizeFrameBounds = {
  containerHeight: 1000,
  minPercent: 20,
  maxPercent: 70,
  maxScrollTop: 100,
};

describe("详情侧栏单帧位移消费", () => {
  test("同一帧的多个触摸位移一次消费，输入游标不被修改", () => {
    const cursor = { percent: 30, scrollTop: 0 };
    const result = consumeDetailsResizeDeltas(cursor, [-20, -30], bounds);

    expect(result.cursor.percent).toBe(35);
    expect(result.cursor.scrollTop).toBe(0);
    expect(result.scrollDelta).toBe(0);
    expect(result.percentChanged).toBe(true);
    expect(cursor).toEqual({ percent: 30, scrollTop: 0 });
  });

  test("边界反转按事件顺序消费，不被净位移吞掉", () => {
    const result = consumeDetailsResizeDeltas(
      { percent: 65, scrollTop: 0 },
      [-100, 20],
      { ...bounds, maxScrollTop: 0 },
    );

    expect(result.cursor.percent).toBe(68);
    expect(result.cursor.scrollTop).toBe(0);
    expect(result.percentChanged).toBe(true);
  });

  test("旧缓存已到底时，追加内容后仍请求重读滚动余量", () => {
    const result = consumeDetailsResizeDeltas(
      { percent: 70, scrollTop: 100 },
      [-10],
      bounds,
    );

    expect(result.scrollDelta).toBe(0);
    expect(result.percentChanged).toBe(false);
    expect(result.needsScrollMetrics).toBe(true);
  });

  test("同帧下滑再上滑净滚动为零，但中间请求过滚动仍要重读", () => {
    const result = consumeDetailsResizeDeltas(
      { percent: 70, scrollTop: 0 },
      [-10, 10],
      bounds,
    );

    expect(result.cursor).toEqual({ percent: 70, scrollTop: 0 });
    expect(result.scrollDelta).toBe(0);
    expect(result.needsScrollMetrics).toBe(true);
  });

  test("缓存位置为零的下滑仍请求真实滚动位置", () => {
    const result = consumeDetailsResizeDeltas(
      { percent: 40, scrollTop: 0 },
      [20],
      bounds,
    );

    expect(result.scrollDelta).toBe(0);
    expect(result.percentChanged).toBe(true);
    expect(result.needsScrollMetrics).toBe(true);
  });

  test("上滑越过上限的余量进入滚动，反向位移先滚回顶部", () => {
    const expanded = consumeDetailsResizeDeltas(
      { percent: 65, scrollTop: 20 },
      [-100],
      bounds,
    );
    expect(expanded.cursor.percent).toBe(70);
    expect(expanded.cursor.scrollTop).toBe(70);
    expect(expanded.scrollDelta).toBe(50);

    const retracted = consumeDetailsResizeDeltas(expanded.cursor, [40], bounds);
    expect(retracted.cursor.percent).toBe(70);
    expect(retracted.cursor.scrollTop).toBe(30);
    expect(retracted.scrollDelta).toBe(-40);
    expect(retracted.percentChanged).toBe(false);
  });

  test("滚动余量与输入位移异常值都被安全收口", () => {
    const result = consumeDetailsResizeDeltas(
      { percent: 30, scrollTop: 999 },
      [1000, Number.NaN, Number.POSITIVE_INFINITY],
      { ...bounds, containerHeight: 0, maxScrollTop: Number.NaN },
    );

    expect(result.cursor).toEqual({ percent: 30, scrollTop: 0 });
    expect(result.scrollDelta).toBe(0);
    expect(result.percentChanged).toBe(false);
  });
});

describe("详情侧栏帧调度", () => {
  function scheduler() {
    let nextHandle = 1;
    const callbacks = new Map<number, (time: number) => void>();
    const cancelled: number[] = [];
    return {
      requestFrame: (callback: (time: number) => void) => {
        const handle = nextHandle++;
        callbacks.set(handle, callback);
        return handle;
      },
      cancelFrame: (handle: number) => {
        cancelled.push(handle);
        callbacks.delete(handle);
      },
      run: (time: number) => {
        const [handle, callback] = callbacks.entries().next().value as [
          number,
          (time: number) => void,
        ];
        callbacks.delete(handle);
        callback(time);
      },
      size: () => callbacks.size,
      cancelled,
    };
  }

  test("同一帧多次调度只保留一个回调，取消后队列不再待执行", () => {
    const timers = scheduler();
    const frames: number[] = [];
    const queue = createDetailsResizeFrameQueue((time) => frames.push(time), timers);

    expect(queue.schedule()).toBe(true);
    expect(queue.schedule()).toBe(false);
    expect(queue.isScheduled()).toBe(true);
    expect(timers.size()).toBe(1);

    expect(queue.cancel()).toBe(true);
    expect(queue.isScheduled()).toBe(false);
    expect(timers.cancelled).toEqual([1]);
    expect(queue.cancel()).toBe(false);
    expect(frames).toEqual([]);
  });

  test("已取消但仍在派发途中的旧回调被 generation 拦住", () => {
    let callback: ((time: number) => void) | null = null;
    const frames: number[] = [];
    const queue = createDetailsResizeFrameQueue((time) => frames.push(time), {
      requestFrame: (next) => {
        callback = next;
        return 1;
      },
      cancelFrame: () => {},
    });

    queue.schedule();
    queue.cancel();
    callback?.(16);
    expect(frames).toEqual([]);

    queue.schedule();
    callback?.(32);
    expect(frames).toEqual([32]);
  });

  test("同步 flush 会撤销排队回调并立即提交传入时间", () => {
    const timers = scheduler();
    const frames: number[] = [];
    const queue = createDetailsResizeFrameQueue((time) => frames.push(time), timers);

    queue.schedule();
    expect(queue.flush(24)).toBe(true);
    expect(queue.isScheduled()).toBe(false);
    expect(timers.cancelled).toEqual([1]);
    expect(frames).toEqual([24]);
    expect(queue.flush(32)).toBe(false);
    expect(frames).toEqual([24]);
  });

  test("帧回调执行后可以继续安排下一帧", () => {
    const timers = scheduler();
    const frames: number[] = [];
    const queue = createDetailsResizeFrameQueue((time) => frames.push(time), timers);

    queue.schedule();
    timers.run(16);
    expect(queue.isScheduled()).toBe(false);
    expect(queue.schedule()).toBe(true);
    expect(timers.size()).toBe(1);
    timers.run(32);
    expect(frames).toEqual([16, 32]);
  });
});
