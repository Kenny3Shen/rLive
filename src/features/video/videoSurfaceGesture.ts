/**
 * 视频画面表面手势的几何判定：横向进度拖动（快退/快进）与短视频纵向切片的轴锁。
 *
 * 只有纯函数。命令式部分（指针捕获、预览层、长按撤销、提交 seek）留在
 * `VideoPlayerPage` 的同一条 pointer 管线里：横向 seek 必须与长按倍速、
 * 左右半屏亮度/音量（`usePlayerEdgeGesture`）、短视频上下换片共享同一次按压，
 * 不能各自再挂一套识别器去抢指针。
 *
 * 阈值与 `playerEdgeGesture` 刻意取同一组值（12px、1.25）：三个手势在同一块
 * 画面上竞争，判定尺度分叉会出现「亮度已拒绝、seek 还没接手」的空档，
 * 那正是横向滑动此前既不调节也不快进的成因。
 */

/** 轴向锁定前必须走过的距离（px），与边缘手势、长按容忍半径同一量级。 */
export const VIDEO_SURFACE_GESTURE_LOCK_DISTANCE_PX = 12;
/** 主轴必须超过副轴的倍数，斜向拖动一律不认领。 */
const VIDEO_SURFACE_GESTURE_DIRECTION_RATIO = 1.25;
/**
 * 横向拖过整个画面宽度对应的最大 seek 跨度（秒）。
 *
 * 刻意不按 duration 比例映射：一部两小时的视频若整屏对应全长，
 * 一次手指抖动就是几分钟，细调完全失效。固定跨度让「每像素多少秒」在所有
 * 长度上保持一致，长视频的大跨度跳转仍然交给进度条。
 */
export const VIDEO_SEEK_GESTURE_FULL_WIDTH_SECONDS = 120;
/** 画面宽度的下限（px）：竖屏小窗不至于把每像素的时间放大到无法控制。 */
const VIDEO_SEEK_GESTURE_MIN_WIDTH_PX = 240;

/**
 * 一次按压的归属。
 *
 * `pending` 是仍未越过阈值、必须保留原始目标的状态：弹幕层要靠对应的
 * pointerup 完成命中测试，点按/长按也还有效。`reject` 表示方向已明确但没有
 * 手势可以接手（例如普通 VOD 的纵向已被亮度/音量拿走、斜向拖动），
 * 此时只作废点按与长按，不提交任何动作。
 */
export type VideoSurfaceGestureIntent = "pending" | "seek" | "playlist" | "reject";

/**
 * 按位移判定这次按压属于谁。
 *
 * `seek`/`playlist` 是调用方在 pointerdown 时算出的候选资格（可 seek 的媒体、
 * 短视频且有相邻项），这里只做几何判定，不重复业务条件。
 */
export function videoSurfaceGestureIntent(
  deltaX: number,
  deltaY: number,
  candidates: { seek: boolean; playlist: boolean },
): VideoSurfaceGestureIntent {
  const horizontalDistance = Math.abs(deltaX);
  const verticalDistance = Math.abs(deltaY);
  if (
    horizontalDistance < VIDEO_SURFACE_GESTURE_LOCK_DISTANCE_PX &&
    verticalDistance < VIDEO_SURFACE_GESTURE_LOCK_DISTANCE_PX
  ) {
    return "pending";
  }
  if (
    horizontalDistance >= VIDEO_SURFACE_GESTURE_LOCK_DISTANCE_PX &&
    horizontalDistance > verticalDistance * VIDEO_SURFACE_GESTURE_DIRECTION_RATIO
  ) {
    return candidates.seek ? "seek" : "reject";
  }
  if (
    verticalDistance >= VIDEO_SURFACE_GESTURE_LOCK_DISTANCE_PX &&
    verticalDistance > horizontalDistance * VIDEO_SURFACE_GESTURE_DIRECTION_RATIO
  ) {
    return candidates.playlist ? "playlist" : "reject";
  }
  return "reject";
}

/** 本次拖动能覆盖的 seek 跨度（秒）：短视频以自身长度为上限，避免整屏就跨完全片。 */
export function videoSeekGestureSpanSeconds(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.min(duration, VIDEO_SEEK_GESTURE_FULL_WIDTH_SECONDS);
}

/**
 * 横向拖动对应的目标播放位置（秒）。右滑快进、左滑快退，结果钳在 `[0, duration]`。
 *
 * 只在这里做钳制，提交仍交给播放页原有的 `seekTo`（它另外为 duration 末尾留了
 * 余量，好让最后一帧自然触发 ended 而不是被当作跳到结尾）。
 */
export function videoSeekGestureTarget(
  startTime: number,
  deltaX: number,
  stageWidth: number,
  duration: number,
): number {
  const span = videoSeekGestureSpanSeconds(duration);
  const start = Number.isFinite(startTime) ? Math.max(0, startTime) : 0;
  if (span <= 0 || !Number.isFinite(deltaX)) return start;
  const width = Math.max(VIDEO_SEEK_GESTURE_MIN_WIDTH_PX, stageWidth);
  return Math.max(0, Math.min(duration, start + (deltaX / width) * span));
}
