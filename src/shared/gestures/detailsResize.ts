/** 移动端 VOD 侧栏占比的纯计算：舞台取补集，手势模块只消费这些边界。 */

import { LONG_PRESS_TRIGGER_MS } from "./longPress";

const DETAILS_SHARE_MIN_PERCENT = 20;

const DETAILS_SHARE_HARD_MAX_PERCENT = 100;

/** 舞台至少要保住的窗口比例：满宽 16:9。 */
export const DETAILS_STAGE_ASPECT_RATIO = 16 / 9;

const DETAILS_STAGE_DEFAULT_MAX_PERCENT = 70;

/** 原始画幅布局的侧栏占比（也是拖动下限）。 */
function detailsShareMinPercent(
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

/** 仅比 16:9 更高的画幅联动；超宽及 16:9 附近的取整误差保持固定。 */
export function canResizeVideoDetails(aspectRatio: number | null): boolean {
  return (
    aspectRatio !== null &&
    Number.isFinite(aspectRatio) &&
    aspectRatio > 0 &&
    aspectRatio < DETAILS_STAGE_ASPECT_RATIO * 0.99
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

/** 满宽 16:9 画面的高度。 */
function detailsStageMinHeight(containerWidth: number): number {
  if (!(containerWidth > 0)) return 0;
  return containerWidth / DETAILS_STAGE_ASPECT_RATIO;
}

/** 缩到满宽 16:9 时侧栏可占的原始上限。 */
function detailsShareMaxPercent(containerWidth: number, containerHeight: number): number {
  if (!(containerWidth > 0) || !(containerHeight > 0)) return DETAILS_SHARE_HARD_MAX_PERCENT;
  const percent = (1 - detailsStageMinHeight(containerWidth) / containerHeight) * 100;
  return Math.min(DETAILS_SHARE_HARD_MAX_PERCENT, Math.max(0, percent));
}

export type DetailsResizeLayout = {
  /** 原始画幅布局；也是拖动下限。 */
  initialPercent: number;
  minPercent: number;
  maxPercent: number;
};

/**
 * 统一的初始/拖动边界。默认就是这个区间的下限，因此无需再维护 flex 与 grid
 * 两套视觉规则；满宽 16:9 放不下时返回 null，保持原始布局。
 */
export function detailsResizeLayout(
  containerWidth: number,
  containerHeight: number,
  aspectRatio: number | null,
): DetailsResizeLayout | null {
  if (
    !canResizeVideoDetails(aspectRatio) ||
    !Number.isFinite(containerWidth) ||
    !(containerWidth > 0) ||
    !Number.isFinite(containerHeight) ||
    !(containerHeight > 0)
  ) {
    return null;
  }
  const initialPercent = detailsShareMinPercent(containerWidth, containerHeight, aspectRatio);
  const maxPercent = Math.max(initialPercent, detailsShareMaxPercent(containerWidth, containerHeight));
  if (initialPercent >= 100 || maxPercent - initialPercent < 0.01) return null;
  return { initialPercent, minPercent: initialPercent, maxPercent };
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
 * 「这一步值得认领手势」的最小布局变化（px）。
 *
 * 按压初期要靠 `preventDefault` 从合成器手里赢下手势归属（见 `useDetailsResize`
 * 的 `claimPendingMove`），但只能在本步**真能**改变布局时才抢，否则会吞掉原生
 * 滚动与惯性。比较用像素而不是百分比：占比由侧栏真实高度反算，而容器高度只有
 * `clientHeight` 的整数精度，边界处会留下约 `0.05%` 的测量偏差 —— 在上限处直接
 * 比较百分比会把这个偏差读成「还能再拖」，于是每次到达上限都恰好抢走原生滚动。
 */
export const DETAILS_RESIZE_CLAIM_MIN_PX = 1;

/** 一步手势带来的布局变化是否值得认领（见 `DETAILS_RESIZE_CLAIM_MIN_PX`）。 */
export function detailsResizeStepIsVisible(
  percent: number,
  nextPercent: number,
  containerHeight: number,
): boolean {
  if (!(containerHeight > 0)) return false;
  return (Math.abs(nextPercent - percent) / 100) * containerHeight >= DETAILS_RESIZE_CLAIM_MIN_PX;
}

/**
 * 松手后继续推进的惯性（内容滑动自适应侧栏的「甩出去」）。
 *
 * 只在手指确实拖动过侧栏、且松手速度足够快时启用：占比是一个持久状态，
 * 没有原生滚动的回弹，慢速松手后再溜一段会读作「没对准」。速度按指数衰减，
 * 与原生惯性同形，因此停下是渐变的而不是硬停。
 */

/** 只取最近这段时间内的位移估算速度（ms）。 */
export const DETAILS_MOMENTUM_WINDOW_MS = 100;

/**
 * 速度采样的最小时间跨度（ms）：比这更短时，1px 的坐标取整会放大成极大速度。
 * 与 60Hz 的一帧同量级，因此逐帧采样的正常手势不会被误判。
 */
export const DETAILS_MOMENTUM_MIN_SPAN_MS = 16;

/** 启动惯性的最小速度（px/ms，约 300px/s）。低于此速度的松手就是「停下来」。 */
export const DETAILS_MOMENTUM_MIN_VELOCITY = 0.3;

/** 惯性衰减到这个速度就停下（px/ms）。比启动阈值低一个数量级，形成滞回。 */
export const DETAILS_MOMENTUM_STOP_VELOCITY = 0.02;

/** 指数衰减的时间常数（ms）：速度乘 `e^-1` 所需的时间。 */
export const DETAILS_MOMENTUM_DECAY_MS = 325;

/**
 * 单帧参与衰减的最大时长（ms）。
 *
 * 后台页签恢复、长任务后的 `dt` 可上百毫秒；不夹住就会把整段惯性在一帧里走完，
 * 侧栏「唰」地弹到位。夹住只影响这一次的节奏，总位移仍由 `v₀·τ` 决定。
 */
export const DETAILS_MOMENTUM_MAX_STEP_MS = 64;

/** 速度采样保留的条数（环形，只留最近几条）。 */
export const DETAILS_MOMENTUM_SAMPLE_LIMIT = 5;

/**
 * 惯性结束后抑制点击的时间（ms）。
 *
 * 与拖动结束用的是同一套抑制：惯性期间手指已抬起，紧接的那一次点按落在内容
 * 控件上时应被吞掉，否则「甩一下侧栏」会顺手点进评论。
 */
export const DETAILS_RESIZE_TAP_SUPPRESSION_MS = 420;

/** 一次速度采样：手指位置与事件时间戳。 */
export type DetailsMomentumSample = { time: number; y: number };

/**
 * 按最近一段采样估算手指速度（px/ms，向上为负）。
 *
 * 只取 `DETAILS_MOMENTUM_WINDOW_MS` 内的位移：更早的采样属于上一段动作，
 * 混进来会把「先慢后快」读成中等速度。采样不足、跨度太短或取值无效时返回 0
 * （不接惯性）—— 宁可少接一次，也不要用噪声把侧栏弹出去。
 */
export function detailsResizeVelocity(
  samples: readonly DetailsMomentumSample[],
  releasedAt?: number,
): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  if (!Number.isFinite(last.time) || !Number.isFinite(last.y)) return 0;
  const releaseTime =
    releasedAt !== undefined && Number.isFinite(releasedAt) && releasedAt >= last.time
      ? releasedAt
      : last.time;
  let first = { time: releaseTime, y: last.y };
  for (let index = samples.length - 2; index >= 0; index -= 1) {
    const sample = samples[index];
    if (!Number.isFinite(sample.time) || !Number.isFinite(sample.y)) continue;
    if (releaseTime - sample.time > DETAILS_MOMENTUM_WINDOW_MS) break;
    first = sample;
  }
  const span = releaseTime - first.time;
  if (span < DETAILS_MOMENTUM_MIN_SPAN_MS) return 0;
  return (last.y - first.y) / span;
}

/**
 * 惯性的一步：速度按 `v(t) = v₀·e^(-t/τ)` 衰减，返回这段时间的位移与步末速度。
 *
 * 位移是速度在这段时间上的积分 `Δ = v₀·τ·(1 - e^(-dt/τ))`，直接喂给
 * `detailsContentScrollStep`；步末速度作为下一帧的初速度，因此总位移收敛于 `v₀·τ`。
 */
export function detailsMomentumStep(
  velocity: number,
  dtMs: number,
): { delta: number; velocity: number } {
  if (!Number.isFinite(velocity)) return { delta: 0, velocity: 0 };
  if (!(dtMs > 0)) return { delta: 0, velocity };
  const step = Math.min(dtMs, DETAILS_MOMENTUM_MAX_STEP_MS);
  const decay = Math.exp(-step / DETAILS_MOMENTUM_DECAY_MS);
  return {
    delta: velocity * DETAILS_MOMENTUM_DECAY_MS * (1 - decay),
    velocity: velocity * decay,
  };
}

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
/**
 * 轴锁前按住超过系统长按时长仍未锁定，判为「按住」而不是拖动。
 *
 * 侧栏卡片的长按（打开操作抽屉）同样在 `LONG_PRESS_TRIGGER_MS` 触发，阈值 10px 与
 * 本手势的轴锁距离相同。极慢的上滑在 500ms 内走不到 10px 时，两者会同时生效：
 * 抽屉弹出的同时侧栏也被拉高。让慢于长按的未锁定按压让位给长按，两者互斥。
 */
export function detailsResizePressIsHold(pressedAt: number, now: number): boolean {
  return now - pressedAt >= LONG_PRESS_TRIGGER_MS;
}

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
