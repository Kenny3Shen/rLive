import { describe, expect, test } from "bun:test";
import { detailsScrollMetrics, scrollDetailsContent } from "../src/shared/gestures/detailsScroll";

function scroller(top: number, max: number) {
  let value = top;
  let reads = 0;
  let writes = 0;
  return {
    get scrollTop() {
      reads++;
      return value;
    },
    set scrollTop(next: number) {
      writes++;
      value = Math.max(0, Math.min(max, next));
    },
    snapshot: () => ({ value, reads, writes }),
  };
}

describe("详情侧栏滚动消费", () => {
  test("纯布局帧及浮点尾差不读写任何滚动容器", () => {
    const node = scroller(30, 100);
    for (const delta of [0, 1e-12, -1e-12]) {
      expect(scrollDetailsContent([node], delta)).toBe(0);
    }
    expect(node.snapshot()).toEqual({ value: 30, reads: 0, writes: 0 });
  });

  test("返回真实消费量，不需要再回读整条滚动链", () => {
    const inner = scroller(80, 100);
    const outer = scroller(10, 100);
    expect(scrollDetailsContent([inner, outer], 50)).toBe(50);
    expect(inner.snapshot()).toEqual({ value: 100, reads: 2, writes: 1 });
    expect(outer.snapshot()).toEqual({ value: 40, reads: 2, writes: 1 });
  });

  test("反向滚动先回内层顶部，剩余位移交给外层", () => {
    const inner = scroller(15, 100);
    const outer = scroller(20, 100);
    expect(scrollDetailsContent([inner, outer], -60)).toBe(-35);
    expect(inner.snapshot().value).toBe(0);
    expect(outer.snapshot().value).toBe(0);
    expect(scrollDetailsContent([inner, outer], -10)).toBe(0);
  });

  test("内层消费完后不访问外层，亚像素真实滚动不被舍弃", () => {
    const inner = scroller(10, 100);
    const outer = scroller(10, 100);
    expect(scrollDetailsContent([inner, outer], 0.25)).toBe(0.25);
    expect(outer.snapshot()).toEqual({ value: 10, reads: 0, writes: 0 });
    expect(scrollDetailsContent([], 10)).toBe(0);
  });
});

describe("详情侧栏滚动链缓存", () => {
  test("每帧一次读出逻辑位置与总可滚余量", () => {
    let reads = 0;
    const range = (scrollTop: number, scrollHeight: number, clientHeight: number) => ({
      get scrollTop() {
        reads += 1;
        return scrollTop;
      },
      get scrollHeight() {
        reads += 1;
        return scrollHeight;
      },
      get clientHeight() {
        reads += 1;
        return clientHeight;
      },
    });
    const inner = range(30, 180, 100);
    const outer = range(12, 260, 100);

    expect(detailsScrollMetrics([inner, outer])).toEqual({ top: 42, maxTop: 240 });
    expect(reads).toBe(6);
  });

  test("负值与布局未就绪的滚动余量读作零", () => {
    expect(
      detailsScrollMetrics([
        { scrollTop: -20, scrollHeight: 80, clientHeight: 100 },
        { scrollTop: 0, scrollHeight: 100, clientHeight: 100 },
      ]),
    ).toEqual({ top: 0, maxTop: 0 });
  });
});
