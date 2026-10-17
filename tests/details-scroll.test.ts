import { describe, expect, test } from "bun:test";
import { detailsScrollTopFor, scrollDetailsContent } from "../src/shared/gestures/detailsScroll";

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

describe("详情侧栏滚动位置读取", () => {
  test("上滑扩侧栏不读取任何滚动容器", () => {
    const inner = scroller(30, 100);
    const outer = scroller(20, 100);
    for (const delta of [0, -10, -500]) {
      expect(detailsScrollTopFor([inner, outer], delta)).toBe(0);
    }
    expect(inner.snapshot().reads).toBe(0);
    expect(outer.snapshot().reads).toBe(0);
  });

  test("下滑在攒够本次位移后停止，不再遍历滚动链后半段", () => {
    const inner = scroller(5, 100);
    const middle = scroller(10, 100);
    const outer = scroller(10, 100);
    expect(detailsScrollTopFor([inner, middle, outer], 8)).toBe(15);
    expect(outer.snapshot().reads).toBe(0);
    expect(detailsScrollTopFor([inner, middle, outer], 15)).toBe(15);
    expect(outer.snapshot().reads).toBe(0);
    expect(detailsScrollTopFor([inner, middle, outer], 16)).toBe(25);
    expect(outer.snapshot().reads).toBe(1);
  });

  test("读取到的位置与滚动消费一致：只会先回到顶部，不越过边界", () => {
    const inner = scroller(5, 100);
    const outer = scroller(10, 100);
    expect(detailsScrollTopFor([inner, outer], 200)).toBe(15);
    expect(scrollDetailsContent([inner, outer], -15)).toBe(-15);
    expect(inner.snapshot().value).toBe(0);
    expect(outer.snapshot().value).toBe(0);
  });
});
