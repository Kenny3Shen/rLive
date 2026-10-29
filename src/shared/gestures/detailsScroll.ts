type DetailsScroller = Pick<HTMLElement, "scrollTop">;
type DetailsScrollRange = Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">;

export type DetailsScrollMetrics = {
  top: number;
  maxTop: number;
};

/** 每次 RAF 只读一次滚动链；舞台缩放和内容追加都会改变可滚余量。 */
export function detailsScrollMetrics(
  scrollers: readonly DetailsScrollRange[],
): DetailsScrollMetrics {
  let top = 0;
  let maxTop = 0;
  for (const node of scrollers) {
    top += Math.max(0, node.scrollTop);
    maxTop += Math.max(0, node.scrollHeight - node.clientHeight);
  }
  return { top, maxTop };
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
