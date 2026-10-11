/**
 * 平滑媒体时钟：把有抖动的 `HTMLMediaElement.currentTime` 换算成按 vsync 匀速推进的时间。
 *
 * MSE / 音频时钟驱动的 currentTime 每帧读数有 5–30 ms 抖动（模拟器实测 p95），
 * 直接用来逐帧定位弹幕，60 Hz 下表现为每帧 1–3 px 的来回跳，120 Hz 时单帧位移只有约 1 px，
 * 抖动比位移还大。这里以「锚点媒体时间 + 墙钟增量 × 倍率」外推，每帧只向真实 currentTime
 * 软性靠拢；偏差过大（seek、卡顿后恢复）才硬对齐。
 */
export type SmoothMediaClock = {
  /** 以 rAF 时间戳（ms）读取平滑后的媒体时间（ms）。 */
  read: (nowMs: number, media: MediaClockSource) => number;
  /** 暂停、seek、倍速或缓冲状态变化后调用，下一次读取重新对齐。 */
  reset: () => void;
};

export type MediaClockSource = {
  currentTime: number;
  playbackRate: number;
  paused: boolean;
  ended?: boolean;
  /** HAVE_FUTURE_DATA(3) 以下视为缓冲等待，时间不外推。 */
  readyState?: number;
};

/** 偏差超过此值直接对齐（ms）。 */
const SNAP_MS = 120;
/** 每帧向真实时间靠拢的比例；足够慢，抖动不会传到画面。 */
const STEER = 0.05;

export function createSmoothMediaClock(): SmoothMediaClock {
  let anchorMedia = 0;
  let anchorWall = 0;
  let anchored = false;
  return {
    reset: () => {
      anchored = false;
    },
    read: (nowMs, media) => {
      const actual = Math.max(0, media.currentTime * 1_000);
      const stalled = media.paused || media.ended === true || (media.readyState ?? 4) < 3;
      if (stalled) {
        anchored = false;
        return actual;
      }
      const rate = media.playbackRate > 0 ? media.playbackRate : 1;
      if (!anchored) {
        anchored = true;
        anchorMedia = actual;
        anchorWall = nowMs;
        return actual;
      }
      const predicted = anchorMedia + (nowMs - anchorWall) * rate;
      const error = actual - predicted;
      if (Math.abs(error) > SNAP_MS) {
        anchorMedia = actual;
        anchorWall = nowMs;
        return actual;
      }
      // 把修正记进锚点：外推保持匀速，同时逐渐吸收长期漂移。
      const next = predicted + error * STEER;
      anchorMedia = next;
      anchorWall = nowMs;
      return next;
    },
  };
}
