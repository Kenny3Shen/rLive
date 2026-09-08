/**
 * 播放器画面左右半边的纵向调节手势（左亮度 / 右音量）的几何判定。
 *
 * 只有纯函数：直播页与视频页共用同一套阈值，两页的手势手感因此不会分叉。
 * 命令式部分（原生桥、反馈层、指针捕获）在 `usePlayerEdgeGesture`。
 */

// Android 经原生桥控制 Activity 亮度。其他移动客户端通过合成器阴影兜底
// 实现同样的画面局部手势。
export const PLAYER_EDGE_GESTURE_MIN_DISTANCE_PX = 12;
const PLAYER_EDGE_GESTURE_DIRECTION_RATIO = 1.25;
const PLAYER_EDGE_GESTURE_MIN_STAGE_HEIGHT_PX = 160;
// Bilibili 风格的调节让手指在整个画面高度上连续跟踪，
// 而不是按粗粒度的固定档位跳变。
const PLAYER_EDGE_GESTURE_DRAG_HEIGHT_RATIO = 1;
export const PLAYER_EDGE_GESTURE_HUD_LINGER_MS = 520;
const PLAYER_EDGE_GESTURE_START_GUTTER_RATIO = 0.08;

export type PlayerEdgeGesture = "brightness" | "volume";

/** 左半边调节画面亮度；右半边调节音量。 */
export function playerEdgeGestureForStart(
  clientX: number,
  stageLeft: number,
  stageWidth: number,
): PlayerEdgeGesture {
  return clientX - stageLeft < Math.max(0, stageWidth) / 2 ? "brightness" : "volume";
}

/** 把 0-100 的兜底亮度转换为仅合成器的黑色叠加层。 */
export function playerBrightnessShadeOpacity(value: number): number {
  const brightness = Math.max(0, Math.min(100, value));
  return (100 - brightness) / 100;
}

/** 刻意的纵向拖拽优先于斜向或横向手势。 */
export function isVerticalPlayerEdgeGesture(deltaX: number, deltaY: number): boolean {
  const verticalDistance = Math.abs(deltaY);
  return (
    verticalDistance >= PLAYER_EDGE_GESTURE_MIN_DISTANCE_PX &&
    verticalDistance > Math.abs(deltaX) * PLAYER_EDGE_GESTURE_DIRECTION_RATIO
  );
}

export type PlayerEdgeGestureIntent = "pending" | "adjust" | "reject";

/**
 * 让短促的接触保持其原始的画面目标，直到它要么变成纵向调节、
 * 要么明确转变为其他手势。这对直播弹幕浮层尤其重要：
 * 它需要对应的 pointerup 来完成触摸命中测试。
 */
export function playerEdgeGestureIntent(deltaX: number, deltaY: number): PlayerEdgeGestureIntent {
  const horizontalDistance = Math.abs(deltaX);
  const verticalDistance = Math.abs(deltaY);
  if (
    horizontalDistance < PLAYER_EDGE_GESTURE_MIN_DISTANCE_PX &&
    verticalDistance < PLAYER_EDGE_GESTURE_MIN_DISTANCE_PX
  ) {
    return "pending";
  }
  return isVerticalPlayerEdgeGesture(deltaX, deltaY) ? "adjust" : "reject";
}

/**
 * 映射到完整 0–100 调节的拖拽距离。使用整个舞台使小幅手指移动连续可控，
 * 而不是忽跳忽停。
 */
export function playerEdgeGestureDragExtent(stageHeight: number): number {
  return (
    Math.max(PLAYER_EDGE_GESTURE_MIN_STAGE_HEIGHT_PX, stageHeight) *
    PLAYER_EDGE_GESTURE_DRAG_HEIGHT_RATIO
  );
}

/** 上下拖拽一个播放器高度对应完整的 0–100 调节。 */
export function playerEdgeGestureValue(
  startValue: number,
  deltaY: number,
  stageHeight: number,
): number {
  const height = playerEdgeGestureDragExtent(stageHeight);
  return Math.max(0, Math.min(100, startValue - (deltaY / height) * 100));
}

/**
 * 为系统边缘手势留下狭窄的上下留白。交互式播放 chrome 由调用方的
 * 忽略目标判定单独排除。
 */
export function canStartPlayerEdgeGesture(
  clientY: number,
  stageTop: number,
  stageHeight: number,
): boolean {
  if (stageHeight <= 0) return false;
  const ratio = (clientY - stageTop) / stageHeight;
  return (
    ratio >= PLAYER_EDGE_GESTURE_START_GUTTER_RATIO &&
    ratio <= 1 - PLAYER_EDGE_GESTURE_START_GUTTER_RATIO
  );
}
