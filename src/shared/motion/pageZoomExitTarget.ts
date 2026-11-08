import { zoomRectTransform, type ZoomRect } from "./pageZoomOrigin";

/** 播放页缩回动画的终点；卡片尚未挂载时沿用进入时的记忆窗口。 */
export type PageZoomExitTarget = {
  transform: string;
  /** 是否还要在列表提交后把终点换成真实卡片坐标。 */
  resolveLater: boolean;
};

export function pageZoomExitTarget({
  originPage,
  destinationPage,
  originRect,
  cardRect,
  fallbackScale = 0.96,
}: {
  originPage: string | null;
  destinationPage: string;
  originRect: ZoomRect | null;
  cardRect: ZoomRect | null;
  fallbackScale?: number;
}): PageZoomExitTarget {
  const samePage = originPage !== null && originPage === destinationPage;
  const rect = cardRect ?? (samePage ? originRect : null);
  return {
    transform: rect ? zoomRectTransform(rect) : `scale(${fallbackScale})`,
    // 用记忆窗口启动时，列表随后挂载的真实卡片可能位于不同滚动位置。
    resolveLater: !cardRect && samePage && originRect !== null,
  };
}
