/** 针对手机触摸目标调校的下拉刷新阈值。 */
export const PULL_TO_REFRESH_THRESHOLD_PX = 64;
export const PULL_TO_REFRESH_MAX_PX = 96;
export const PULL_TO_REFRESH_DIRECTION_RATIO = 1.2;
export const PULL_TO_REFRESH_LOCK_DISTANCE_PX = 8;

export type PullToRefreshProgress = {
  distance: number;
  armed: boolean;
};

/** 只有滚动容器已在顶部时才开始下拉。 */
export function canStartPullToRefresh(scrollTop: number): boolean {
  return scrollTop <= 0;
}

export function isPullToRefreshGesture(deltaX: number, deltaY: number): boolean {
  // 手指下移 → 使用 clientY 起止相减取反后在屏幕坐标中为正 deltaY：我们传
  // (currentY - startY)。
  return (
    deltaY >= PULL_TO_REFRESH_LOCK_DISTANCE_PX &&
    deltaY > Math.abs(deltaX) * PULL_TO_REFRESH_DIRECTION_RATIO
  );
}

export function pullToRefreshDistance(deltaY: number): number {
  if (deltaY <= 0) return 0;
  // 橡皮筋效果：阈值的前半程完全跟随，之后放缓。
  const damped =
    deltaY < PULL_TO_REFRESH_THRESHOLD_PX
      ? deltaY
      : PULL_TO_REFRESH_THRESHOLD_PX + (deltaY - PULL_TO_REFRESH_THRESHOLD_PX) * 0.35;
  return Math.min(PULL_TO_REFRESH_MAX_PX, damped);
}

export function isPullToRefreshArmed(distance: number): boolean {
  return distance >= PULL_TO_REFRESH_THRESHOLD_PX;
}

/** 解析最近的纵向可滚动祖先，包括元素自身。 */
export function findVerticalScrollParent(start: Element | null): HTMLElement | null {
  let node: Element | null = start;
  while (node) {
    if (node instanceof HTMLElement) {
      const style = window.getComputedStyle(node);
      const overflowY = style.overflowY;
      const canScroll =
        (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
        node.scrollHeight > node.clientHeight + 1;
      if (canScroll) return node;
      // 带动画的页面包装层是主页面滚动容器。ScrollArea 视口在空态/错误态也需要同样
      // 处理；否则没有行的关注面板就没有下拉目标。
      if (node.dataset.slot === "app-page" || node.dataset.slot === "scroll-area-viewport") {
        return node;
      }
    }
    node = node.parentElement;
  }
  return null;
}
