export type DetailsResizeTransformInput = {
  containerHeight: number;
  /** 按下时冻结的真实舞台高度 Hs。拖动期所有位移都相对它计算。 */
  stageHeight: number;
  minPercent: number;
  currentPercent: number;
  maxPercent: number;
};

export type DetailsResizeTransform = {
  minStageHeight: number;
  maxAsideHeight: number;
  currentStageHeight: number;
  stageScale: number;
  chromeOffset: number;
  asideOffset: number;
  composerOffset: number;
};

/**
 * 把拖动期的占比换算成一组互不触发布局的视觉参数。
 *
 * `stageHeight` 是按下时冻结的舞台高度 Hs，`minPercent`/`maxPercent` 约束当前
 * 占比，`maxPercent` 同时决定最大侧栏高度 Hm。当前占比只改变视频缩放、控制栏/
 * 字幕位移与侧栏位移，不再改变真实布局。
 */
export function detailsResizeTransform({
  containerHeight,
  stageHeight,
  minPercent,
  currentPercent,
  maxPercent,
}: DetailsResizeTransformInput): DetailsResizeTransform | null {
  if (
    !Number.isFinite(containerHeight) ||
    !(containerHeight > 0) ||
    !Number.isFinite(stageHeight) ||
    !(stageHeight > 0) ||
    !Number.isFinite(minPercent) ||
    minPercent < 0 ||
    minPercent >= 100 ||
    !Number.isFinite(maxPercent) ||
    maxPercent < minPercent ||
    maxPercent > 100 ||
    !Number.isFinite(currentPercent)
  ) {
    return null;
  }

  const clampedPercent = Math.min(maxPercent, Math.max(minPercent, currentPercent));
  const minStageHeight = ((100 - maxPercent) / 100) * containerHeight;
  const currentStageHeight = ((100 - clampedPercent) / 100) * containerHeight;

  return {
    minStageHeight,
    maxAsideHeight: containerHeight - minStageHeight,
    currentStageHeight,
    stageScale: currentStageHeight / stageHeight,
    chromeOffset: currentStageHeight - stageHeight,
    asideOffset: currentStageHeight - stageHeight,
    composerOffset: minStageHeight - currentStageHeight,
  };
}
