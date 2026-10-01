/**
 * 移动端 VOD 详情侧栏的占比拖动（按住页签条上下拖）。
 *
 * 抽成纯函数模块（不 import React）是为了让占比换算、边界阻尼与上下限都能单测；
 * 组件侧只负责把指针位移喂进来、把结果写成 CSS 变量。
 *
 * 「占比」一律指**详情侧栏**占播放页主区域（舞台 + 详情区）高度的百分比 ——
 * 这正是用户拖动时看到的那块区域，舞台拿到剩下的部分。
 */

/**
 * 占比上下限（%）。
 *
 * 未拖动过时，分界由视频画幅决定：横屏视频舞台按比值撑高（手机竖屏下约 30%），
 * 竖屏视频舞台封顶 70% —— 后者正是「拖大侧栏看评论」的典型场景。
 *
 * 下限 `20`：页签条本身 44px，401×757 的手机上剩约 107px，够露出两三行评论；
 * 再小就只剩一条页签，拖过头没有意义。
 * 上限 `85`：舞台仍留 15%（同一台手机上约 114px），横屏画幅会缩小、竖屏画幅
 * 还看得见画面。要「一边看画面一边刷评论」而不是把画面拖没，上限必须有。
 */
export const DETAILS_SHARE_MIN_PERCENT = 20;
export const DETAILS_SHARE_MAX_PERCENT = 85;

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

/** 越界阻尼：超出上下限后每像素只走 0.25px，读作「到头了」而不是硬停。 */
export const DETAILS_RESIZE_OVERSHOOT_DAMPING = 0.25;

/**
 * 手指纵向位移换算成侧栏占比。
 *
 * 手指向上（`deltaY < 0`）＝把分界往上拉＝侧栏变高，因此取反。超出上下限后只按
 * 阻尼系数继续走一小段，松手时按 `clampDetailsSharePercent` 收回范围内。
 */
export function detailsResizeSharePercent(
  startPercent: number,
  deltaY: number,
  containerHeight: number,
): number {
  if (!(containerHeight > 0)) return startPercent;
  const raw = startPercent - (deltaY / containerHeight) * 100;
  if (raw < DETAILS_SHARE_MIN_PERCENT) {
    return (
      DETAILS_SHARE_MIN_PERCENT -
      (DETAILS_SHARE_MIN_PERCENT - raw) * DETAILS_RESIZE_OVERSHOOT_DAMPING
    );
  }
  if (raw > DETAILS_SHARE_MAX_PERCENT) {
    return (
      DETAILS_SHARE_MAX_PERCENT +
      (raw - DETAILS_SHARE_MAX_PERCENT) * DETAILS_RESIZE_OVERSHOOT_DAMPING
    );
  }
  return raw;
}

/**
 * 把占比（可能因阻尼越界）收回合法范围，供提交与渲染使用。
 *
 * 只对 `NaN` 做特殊处理：它意味着上游量出了无效尺寸，回落到下限比写出
 * `height: NaN%` 好。无穷大交给 `Math.min` / `Math.max` 自然收到两端。
 */
export function clampDetailsSharePercent(percent: number): number {
  if (Number.isNaN(percent)) return DETAILS_SHARE_MIN_PERCENT;
  return Math.min(DETAILS_SHARE_MAX_PERCENT, Math.max(DETAILS_SHARE_MIN_PERCENT, percent));
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
