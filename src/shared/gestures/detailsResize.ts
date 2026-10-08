/**
 * 移动端 VOD 详情侧栏的自适应占比（滑动内容区时让出或恢复画面空间）。
 *
 * 抽成纯函数模块（不 import React）是为了让占比换算、边界与上下限都能单测；
 * 组件侧只负责把指针位移喂进来、把结果写成 CSS 变量。
 *
 * 「占比」一律指**详情侧栏**占播放页主区域（舞台 + 详情区）高度的百分比 ——
 * 这正是用户拖动时看到的那块区域，舞台拿到剩下的部分。
 */

/**
 * 尺寸或画幅不可用时的占比下限（%）。已知画幅使用 `detailsShareMinPercent`
 * 算出的原始布局作为下限，不能继续下滑到这个兜底值。
 */
export const DETAILS_SHARE_MIN_PERCENT = 20;

/**
 * 占比的兜底硬顶（%），不覆盖已知画幅的原始布局。
 *
 * 用于两种情况：16:9 窗口在容器里**放不下**时回退（见
 * `detailsShareMaxPercent`），以及容器尺寸不可用时的兜底。
 */
export const DETAILS_SHARE_HARD_MAX_PERCENT = 85;

/** 舞台至少要保住的窗口比例：满宽 16:9。 */
export const DETAILS_STAGE_ASPECT_RATIO = 16 / 9;

/** 与播放页默认舞台的 `max-h-[70%]` 保持一致。 */
export const DETAILS_STAGE_DEFAULT_MAX_PERCENT = 70;

/**
 * 恢复原始画幅布局时的侧栏占比下限（%）。
 *
 * 原始舞台高度为 `min(width / aspectRatio, height × 70%)`，侧栏拿剩余空间。
 * 此下限只依赖画幅与容器尺寸，不能取每次手势的起点，否则上滑松手后就缩不回去。
 * 超宽画幅的原始侧栏占比可能超过 85%，仍须完整保留，不能被兜底硬顶截断。
 */
export function detailsShareMinPercent(
  containerWidth: number,
  containerHeight: number,
  aspectRatio: number | null = null,
): number {
  if (
    !Number.isFinite(containerWidth) ||
    !(containerWidth > 0) ||
    !Number.isFinite(containerHeight) ||
    !(containerHeight > 0) ||
    aspectRatio === null ||
    !Number.isFinite(aspectRatio) ||
    !(aspectRatio > 0)
  ) {
    return DETAILS_SHARE_MIN_PERCENT;
  }
  const stageShare = Math.min(
    (containerWidth / aspectRatio / containerHeight) * 100,
    DETAILS_STAGE_DEFAULT_MAX_PERCENT,
  );
  return 100 - stageShare;
}

/** 只对已知的非 16:9 画幅启用；容忍编码取整/补边带来的 1% 偏差。 */
export function canResizeVideoDetails(aspectRatio: number | null): boolean {
  return (
    aspectRatio !== null &&
    Number.isFinite(aspectRatio) &&
    aspectRatio > 0 &&
    Math.abs(aspectRatio / DETAILS_STAGE_ASPECT_RATIO - 1) > 0.01
  );
}

/**
 * 一次纵向滑动的位移分配：上滑先扩侧栏、下滑先回内容顶部。
 * 返回的 scrollDelta 是交给内容滚动的剩余位移（正数向下滚）。
 */
export function detailsContentScrollStep(
  percent: number,
  deltaY: number,
  scrollTop: number,
  containerHeight: number,
  maxPercent: number,
  minPercent: number = DETAILS_SHARE_MIN_PERCENT,
): { percent: number; scrollDelta: number } {
  if (!(containerHeight > 0)) return { percent, scrollDelta: -deltaY };
  const scrollFirst = deltaY > 0 ? Math.min(deltaY, Math.max(0, scrollTop)) : 0;
  const resizeDelta = deltaY - scrollFirst;
  const next = detailsResizeSharePercent(
    percent,
    resizeDelta,
    containerHeight,
    maxPercent,
    minPercent,
  );
  const consumed = ((percent - next) / 100) * containerHeight;
  return { percent: next, scrollDelta: -deltaY + consumed };
}

/**
 * 满宽 16:9 画面的高度（px）。
 *
 * 「占比最大需要保留 16:9 视频窗口大小」是这条手势的产品约束：详情区再大，
 * 上面那块舞台也必须放得下一个**满宽 16:9** 的画面 —— 拖动因此是「把画面压小
 * 到刚好看得清」，而不是把画面压成一条。
 */
export function detailsStageMinHeight(containerWidth: number): number {
  if (!(containerWidth > 0)) return 0;
  return containerWidth / DETAILS_STAGE_ASPECT_RATIO;
}

/**
 * 16:9 约束给出的占比上限（%）。
 *
 * 舞台高度是容器高度的补集，要求 `(1 - share) × height ≥ minHeight`，解出
 * `share ≤ (1 - minHeight / height) × 100`。同一台手机上容器越矮，能给侧栏的
 * 份额越少：401×757 的手机上限约 `70.2%`（舞台高约 `225.6px`），
 * 900×1200 的平板约 `57.8%`。
 *
 * 两个回退：
 *
 * - **放不下**（横屏手机：满宽 16:9 比容器还高，解出的份额低于下限）时不做
 *   额外约束，回退到 `DETAILS_SHARE_HARD_MAX_PERCENT`。此时没有任何取值能满足
 *   该约束，硬夹会把侧栏顶到下限、连往上拖的余地都没有。
 * - 容器尺寸不可用（未布局 / `NaN`）同样回退到文本硬顶。
 */
export function detailsShareMaxPercent(containerWidth: number, containerHeight: number): number {
  if (!(containerWidth > 0) || !(containerHeight > 0)) return DETAILS_SHARE_HARD_MAX_PERCENT;
  const percent = (1 - detailsStageMinHeight(containerWidth) / containerHeight) * 100;
  if (!(percent >= DETAILS_SHARE_MIN_PERCENT)) return DETAILS_SHARE_HARD_MAX_PERCENT;
  return Math.min(DETAILS_SHARE_HARD_MAX_PERCENT, percent);
}

/**
 * 一次手势的实际占比上限（%）。
 *
 * 取 16:9 约束与**手势起点的占比**的较大者。默认布局本来就可能已经超过 16:9
 * 约束——宽画幅视频（≥16:9，含 16:9 本身）按比值撑高时给的舞台就比满宽 16:9
 * 窗口矮，横屏手机更是根本放不下。此时若严格夹到约束值，用户拖动的第一帧
 * 就会把侧栏直接弹掉一截；保住起点意味着不能再扩大侧栏，下滑则只允许恢复到
 * 原始布局。
 *
 * 尺寸或画幅变化后的收口还要保住原始布局下限；当它超过 16:9 约束时，区间
 * 收为原始占比一个点。默认超宽画幅因此上下滑都保持原位，不会突然扩大舞台。
 *
 * 因此不变量是：**拖动不会让占比超过 `max(起点, 原始布局, 16:9 约束)`**。
 */
export function detailsResizeCeiling(
  startPercent: number,
  containerWidth: number,
  containerHeight: number,
  minPercent: number = DETAILS_SHARE_MIN_PERCENT,
): number {
  const cap = Math.max(minPercent, detailsShareMaxPercent(containerWidth, containerHeight));
  if (!Number.isFinite(startPercent)) return cap;
  return Math.max(startPercent, cap);
}

/**
 * 轴向锁定距离（px）。
 *
 * 与 `HORIZONTAL_SWIPE_LOCK_DISTANCE_PX` 取同一个量级（10px）：页签条上纵向拖动
 * 调占比、横向拖动翻页，两者都在捕获阶段监听同一串指针事件，谁先越过锁定距离谁
 * 赢，另一个在本次手势里彻底放手。
 */
export const DETAILS_RESIZE_LOCK_DISTANCE_PX = 10;
/** 纵向位移要压过横向位移的倍数，避免斜着划一下同时触发两个意图。 */
export const DETAILS_RESIZE_DIRECTION_RATIO = 1.25;

/**
 * 手势意图判定。
 *
 * `resize`：纵向拖动（手指上移＝分界上移＝侧栏变高）；
 * `swipe`：横向拖动，本次手势归页签条自己的 `useHorizontalSwipe`；
 * `pending`：还没越过锁定距离，两边都继续等。
 *
 * 两套阈值刻意互斥：纵向要求 `|dy| > |dx|`，横向要求 `|dx| > 1.25|dy|`，
 * 因此同一次手势不会两边同时锁定。
 */
export function detailsResizeIntent(
  deltaX: number,
  deltaY: number,
): "pending" | "resize" | "swipe" {
  const horizontal = Math.abs(deltaX);
  const vertical = Math.abs(deltaY);
  if (vertical >= DETAILS_RESIZE_LOCK_DISTANCE_PX && vertical > horizontal) return "resize";
  if (
    horizontal >= DETAILS_RESIZE_LOCK_DISTANCE_PX &&
    horizontal > vertical * DETAILS_RESIZE_DIRECTION_RATIO
  ) {
    return "swipe";
  }
  return "pending";
}

/**
 * 手指纵向位移换算成侧栏占比。
 *
 * 手指向上（`deltaY < 0`）＝把分界往上拉＝侧栏变高，因此取反。结果夹在
 * `[下限, 上限]` 内：边界是硬停，越界只靠「数值不再变化」表达，不做回弹式过冲
 * —— 过冲的取值从来写不进 CSS 变量（写之前就被收回范围），只会让提交值比手指
 * 位置多退一截，读作卡顿。
 */
export function detailsResizeSharePercent(
  startPercent: number,
  deltaY: number,
  containerHeight: number,
  maxPercent: number = DETAILS_SHARE_HARD_MAX_PERCENT,
  minPercent: number = DETAILS_SHARE_MIN_PERCENT,
): number {
  if (!(containerHeight > 0)) return startPercent;
  const raw = startPercent - (deltaY / containerHeight) * 100;
  return clampDetailsSharePercent(raw, maxPercent, minPercent);
}

/**
 * 把占比收回合法范围，供提交与渲染使用。
 *
 * 只对 `NaN` 做特殊处理：它意味着上游量出了无效尺寸，回落到下限比写出
 * `height: NaN%` 好。无穷大交给 `Math.min` / `Math.max` 自然收到两端。
 */
export function clampDetailsSharePercent(
  percent: number,
  maxPercent: number = DETAILS_SHARE_HARD_MAX_PERCENT,
  minPercent: number = DETAILS_SHARE_MIN_PERCENT,
): number {
  if (Number.isNaN(percent)) return minPercent;
  const upper = Math.max(minPercent, maxPercent);
  return Math.min(upper, Math.max(minPercent, percent));
}

/**
 * 侧栏高度换算成占比。
 *
 * 直接量 DOM 而不是读 React 状态：占比未调整过时状态里没有值（舞台按画幅比撑高，
 * 侧栏拿剩下的），此时必须按当前真实布局起算，否则第一次拖动会跳一下。
 */
export function detailsShareFromHeights(sidebarHeight: number, containerHeight: number): number {
  if (!(containerHeight > 0)) return DETAILS_SHARE_MIN_PERCENT;
  return (sidebarHeight / containerHeight) * 100;
}

/**
 * 把占比写成 CSS 变量的取值。动态手势边界已由调用方计算；格式化只做物理范围
 * 保护，不再套用 85% 兜底上限，以免合法的超宽画幅原始占比在预览/提交时跳变。
 */
export function detailsShareCssValue(percent: number): string {
  return `${roundDetailsShare(percent).toFixed(3)}%`;
}

/**
 * 把占比收敛到写进 DOM 的精度（三位小数）。
 *
 * 拖动期间逐帧写的 CSS 变量就是三位小数，提交与尺寸重算后的 JS 状态必须用同一
 * 精度 —— 否则内联值与拖动末帧只差一个浮点尾数，那一帧会重排一次（虽不可见，
 * 但会让「总和守恒」这类几何断言出现 0.001px 级的噪声），状态里也白存一串尾数。
 */
export function roundDetailsShare(percent: number): number {
  return Math.round(clampDetailsSharePercent(percent, 100, 0) * 1000) / 1000;
}
