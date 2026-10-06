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
 * 占比下限（%）。
 *
 * 页签条本身 44px，401×757 的手机上剩约 107px，够露出两三行评论；再小就只剩
 * 一条页签，拖过头没有意义。
 */
export const DETAILS_SHARE_MIN_PERCENT = 20;

/**
 * 占比的硬顶（%）。
 *
 * 用于两种情况：16:9 窗口在容器里**放不下**时回退（见
 * `detailsShareMaxPercent`），以及容器尺寸不可用时的兜底。
 */
export const DETAILS_SHARE_HARD_MAX_PERCENT = 85;

/** 舞台至少要保住的窗口比例：满宽 16:9。 */
export const DETAILS_STAGE_ASPECT_RATIO = 16 / 9;

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
): { percent: number; scrollDelta: number } {
  if (!(containerHeight > 0)) return { percent, scrollDelta: -deltaY };
  const scrollFirst = deltaY > 0 ? Math.min(deltaY, Math.max(0, scrollTop)) : 0;
  const resizeDelta = deltaY - scrollFirst;
  const next = detailsResizeSharePercent(percent, resizeDelta, containerHeight, maxPercent);
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
 * 份额越少：401×757 的手机上限约 `70.2%`（正好是竖屏视频未拖动时的默认占比，
 * 即「竖屏画面铺满舞台」那个位置），900×1200 的平板约 `57.8%`。
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
 * 窗口矮，横屏手机更是根本放不下。此时若严格夹到约束值，用户往下拖的第一帧
 * 就会把侧栏直接弹掉一截；取较大者则读作「只能往小拖、不能再往大拖」，
 * 既不偷偷改动当前布局，也不再允许越过约束。
 *
 * 因此不变量是：**拖动不会让占比超过 `max(起点, 16:9 约束)`**，且任何一次
 * 从约束内开始的手势都会停在约束上。
 */
export function detailsResizeCeiling(
  startPercent: number,
  containerWidth: number,
  containerHeight: number,
): number {
  const cap = detailsShareMaxPercent(containerWidth, containerHeight);
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
): number {
  if (!(containerHeight > 0)) return startPercent;
  const raw = startPercent - (deltaY / containerHeight) * 100;
  const upper = Math.max(DETAILS_SHARE_MIN_PERCENT, maxPercent);
  return Math.min(upper, Math.max(DETAILS_SHARE_MIN_PERCENT, raw));
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
): number {
  if (Number.isNaN(percent)) return DETAILS_SHARE_MIN_PERCENT;
  const upper = Math.max(DETAILS_SHARE_MIN_PERCENT, maxPercent);
  return Math.min(upper, Math.max(DETAILS_SHARE_MIN_PERCENT, percent));
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

/** 把占比写成 CSS 变量的取值。单位与精度由这里决定，组件不再拼字符串。 */
export function detailsShareCssValue(percent: number): string {
  return `${clampDetailsSharePercent(percent).toFixed(3)}%`;
}

/**
 * 把占比收敛到写进 DOM 的精度（三位小数）。
 *
 * 拖动期间逐帧写的 CSS 变量就是三位小数，提交与尺寸重算后的 JS 状态必须用同一
 * 精度 —— 否则内联值与拖动末帧只差一个浮点尾数，那一帧会重排一次（虽不可见，
 * 但会让「总和守恒」这类几何断言出现 0.001px 级的噪声），状态里也白存一串尾数。
 */
export function roundDetailsShare(percent: number): number {
  return Math.round(clampDetailsSharePercent(percent) * 1000) / 1000;
}
