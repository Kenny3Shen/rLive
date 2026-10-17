type DetailsScroller = Pick<HTMLElement, "scrollTop">;

/**
 * 下滑要先回内容顶部时，这次位移最多能消费掉多少滚动位置。
 *
 * 只有向下（`delta > 0`）的位移会先消耗 `scrollTop`；上滑直接扩侧栏，不需要
 * 读取任何滚动容器。读取也在攒够本次位移后立即停止：滚动链后面的容器与这次
 * 分配无关，多读一次就多一次布局结算。
 */
export function detailsScrollTopFor(scrollers: readonly DetailsScroller[], delta: number): number {
  if (!(delta > 0)) return 0;
  let top = 0;
  let remaining = delta;
  for (const node of scrollers) {
    const value = Math.max(0, node.scrollTop);
    top += value;
    remaining -= value;
    if (remaining <= 0) break;
  }
  return top;
}

/** 按命中顺序消费滚动位移，返回实际滚动量，供惯性判断是否已到边界。 */
export function scrollDetailsContent(scrollers: readonly DetailsScroller[], delta: number): number {
  // 纯布局帧的剩余位移可能有浮点尾差，不能因此读写 scrollTop、强制结算刚改的布局。
  if (Math.abs(delta) < 1e-9) return 0;
  const requested = delta;
  for (const node of scrollers) {
    const before = node.scrollTop;
    node.scrollTop = before + delta;
    delta -= node.scrollTop - before;
    if (Math.abs(delta) < 0.5) break;
  }
  return requested - delta;
}
