/**
 * 图片查看器的缩放几何：双指缩放、双击放大与放大后的平移。
 *
 * 变换统一写作 `translate3d(x, y, 0) scale(scale)`，`transform-origin` 取元素中心。
 * 于是未变换时位于 `q`（client 坐标）的内容点，在屏幕上的落点是
 * `c + scale × (q − c) + (x, y)`，其中 `c` 为图片未变换时的中心：缩放围绕中心、
 * 平移发生在缩放之后，`(x, y)` 因此就是屏幕像素位移，与手指位移一一对应。
 *
 * 这里只放纯函数与常量，指针接线与 WAAPI 收尾在 `useImageZoom`。
 */

/** 最小倍率：图片始终按适配尺寸完整可见，不允许再缩小。 */
export const IMAGE_ZOOM_MIN_SCALE = 1;
/** 双指缩放的最大倍率。 */
export const IMAGE_ZOOM_MAX_SCALE = 4;
/** 双击进入的倍率：留出余量，让双击之后还能用双指微调。 */
export const IMAGE_ZOOM_DOUBLE_TAP_SCALE = 2.5;
/** 双击判定窗口（ms）：比系统双击间隔稍宽，容错的同时不会把两次独立点按并起来。 */
export const IMAGE_ZOOM_DOUBLE_TAP_INTERVAL_MS = 320;
/** 双击两次落点的容差（px）。 */
export const IMAGE_ZOOM_DOUBLE_TAP_SLOP_PX = 12;
/** 点按位移容差（px）：与横滑锁定距离同量级，超过它就不是点按而是拖动。 */
export const IMAGE_ZOOM_TAP_SLOP_PX = 10;
/** 释放后的收尾时长（ms）：与按压释放同一档，读作「松手回位」而不是一段动画。 */
export const IMAGE_ZOOM_SETTLE_MS = 220;
/** 鼠标滚轮缩放的灵敏度（按归一化到像素的 delta 计）。一格约 `1.28` 倍。 */
export const IMAGE_ZOOM_WHEEL_SENSITIVITY = 0.0025;
/**
 * 触控板捏合的灵敏度。
 *
 * 浏览器把触控板捏合翻译成 `ctrl + wheel`：每个事件的 delta 只有个位数，而鼠标滚轮
 * 一格就是 `100`。因此捏合走大一档的灵敏度，两种输入的手感才落在同一量级。
 */
export const IMAGE_ZOOM_WHEEL_PINCH_SENSITIVITY = 0.01;
/** 键盘缩放的步进倍率。 */
export const IMAGE_ZOOM_KEY_STEP = 1.25;
/**
 * 一次滚轮/捏合序列结束后的等待时长（ms）。
 *
 * 滚轮事件成串到达。逐个事件起一段收尾动画会互相打断成抖动，因此序列期间逐帧直接写，
 * 停手这么久之后才做一次收口（范围修正与「几乎没放大」的归位）。
 */
export const IMAGE_ZOOM_WHEEL_IDLE_MS = 160;
/** 收尾后残留倍率低于它的变换直接归位：避免留下一条看不出的缩放层。 */
const IMAGE_ZOOM_SNAP_BACK_EPSILON = 0.02;

export type ImageZoomPoint = Readonly<{ x: number; y: number }>;
export type ImageZoomTransform = Readonly<{ scale: number; x: number; y: number }>;

export const IMAGE_ZOOM_IDENTITY: ImageZoomTransform = { scale: 1, x: 0, y: 0 };

/** 图片未变换的布局尺寸，以及可平移视口的尺寸与图片中心（client 坐标）。 */
export type ImageZoomGeometry = {
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  centerX: number;
  centerY: number;
};

export function clampImageZoomScale(scale: number): number {
  if (!Number.isFinite(scale)) return IMAGE_ZOOM_MIN_SCALE;
  return Math.min(IMAGE_ZOOM_MAX_SCALE, Math.max(IMAGE_ZOOM_MIN_SCALE, scale));
}

/**
 * 平移范围（px）。
 *
 * 放大后图片比视口大时，图片边缘最多移动到与视口边缘重合 —— 再多就会把图拖出屏幕、
 * 露出空背景。小于视口的方向恒为 0：图片居中，平移没有意义。
 */
export function imageZoomPanBounds(
  scale: number,
  geometry: ImageZoomGeometry,
): { x: number; y: number } {
  return {
    x: Math.max(0, (geometry.width * scale - geometry.viewportWidth) / 2),
    y: Math.max(0, (geometry.height * scale - geometry.viewportHeight) / 2),
  };
}

/** 把变换收回合法区间：倍率先生效，再按它算平移边界，因此必须先夹倍率。 */
export function clampImageZoomTransform(
  transform: ImageZoomTransform,
  geometry: ImageZoomGeometry,
): ImageZoomTransform {
  const scale = clampImageZoomScale(transform.scale);
  const bounds = imageZoomPanBounds(scale, geometry);
  return {
    scale,
    x: Math.min(bounds.x, Math.max(-bounds.x, transform.x)),
    y: Math.min(bounds.y, Math.max(-bounds.y, transform.y)),
  };
}

/**
 * 锚点变换：让内容点 `from` 下的那块像素在新倍率下落到 `to`。
 *
 * 双指缩放与双击共用这一条式子 —— 前者 `from` 是双指起始中点、`to` 是当前中点，
 * 后者两点都是落点。由 `screen(q) = c + scale × (q − c) + t` 解出
 * `t = (to − c) − (scale ÷ scale₀) × (from − c − t₀)`。
 */
export function imageZoomAnchorTransform(
  geometry: ImageZoomGeometry,
  current: ImageZoomTransform,
  scale: number,
  from: ImageZoomPoint,
  to: ImageZoomPoint,
): ImageZoomTransform {
  const ratio = scale / (current.scale > 0 ? current.scale : 1);
  return {
    scale,
    x: to.x - geometry.centerX - ratio * (from.x - geometry.centerX - current.x),
    y: to.y - geometry.centerY - ratio * (from.y - geometry.centerY - current.y),
  };
}

/**
 * 释放后的落点：几乎回到适配尺寸的直接归位，否则只做范围收口。
 *
 * 双指缩到接近 1 倍就松手时，留下 `1.01` 倍不仅看不出来，还会永久关掉翻页手势
 * —— 用户会以为「滑不动了」。收口与「是否还处于放大态」因此共用这一条判据。
 */
export function imageZoomReleasedTransform(
  transform: ImageZoomTransform,
  geometry: ImageZoomGeometry,
): ImageZoomTransform {
  const clamped = clampImageZoomTransform(transform, geometry);
  return clamped.scale - IMAGE_ZOOM_MIN_SCALE <= IMAGE_ZOOM_SNAP_BACK_EPSILON
    ? IMAGE_ZOOM_IDENTITY
    : clamped;
}

/**
 * 把三种 `deltaMode` 归一化成像素：按行上报乘 `16`，按页上报乘 `100`。
 *
 * Firefox 等会按行上报（`deltaMode === 1`），不归一化的话同样一格滚轮在手感上会差
 * 一个数量级。归一化后灵敏度只按像素标定一次。
 */
export function imageZoomWheelDelta(deltaY: number, deltaMode: number): number {
  if (deltaMode === 1) return deltaY * 16;
  if (deltaMode === 2) return deltaY * 100;
  return deltaY;
}

/**
 * 一次滚轮事件后的新倍率，仍钳在 `[1, 4]`。
 *
 * 用指数而不是加法：倍率是乘性量，同向连滚的总效果才是「滚了多少就是多少倍」，
 * 而加法会让 1→2 与 3→4 需要同样的滚动量、读起来前快后慢。
 * `deltaY < 0`（向上滚 / 捏合张开）放大。
 */
export function imageZoomWheelScale(
  scale: number,
  deltaY: number,
  deltaMode = 0,
  pinch = false,
): number {
  const sensitivity = pinch ? IMAGE_ZOOM_WHEEL_PINCH_SENSITIVITY : IMAGE_ZOOM_WHEEL_SENSITIVITY;
  return clampImageZoomScale(scale * Math.exp(-imageZoomWheelDelta(deltaY, deltaMode) * sensitivity));
}

/** 键盘一次缩放的落点倍率；`direction` 为正放大。 */
export function imageZoomStepScale(scale: number, direction: 1 | -1): number {
  return clampImageZoomScale(
    direction > 0 ? scale * IMAGE_ZOOM_KEY_STEP : scale / IMAGE_ZOOM_KEY_STEP,
  );
}

/** 该点是否覆盖矩形；弹层的「点空白关闭」与手势命中都用它。 */
export function imageZoomRectContains(
  rect: { left: number; top: number; right: number; bottom: number },
  x: number,
  y: number,
): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/** 是否等价于适配尺寸的原样（决定写不写内联 transform、以及是否停用翻页手势）。 */
export function imageZoomIsIdentity(transform: ImageZoomTransform): boolean {
  return (
    transform.scale <= IMAGE_ZOOM_MIN_SCALE &&
    Math.abs(transform.x) < 0.5 &&
    Math.abs(transform.y) < 0.5
  );
}

/** 内联变换文本。保留固定小数位，使同一变换每次写出同一个字符串。 */
export function formatImageZoomTransform(transform: ImageZoomTransform): string {
  const round = (value: number, digits: number) => Number(value.toFixed(digits));
  return `translate3d(${round(transform.x, 2)}px, ${round(transform.y, 2)}px, 0) scale(${round(transform.scale, 5)})`;
}
