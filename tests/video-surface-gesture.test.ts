import { describe, expect, test } from "bun:test";
import {
  VIDEO_SEEK_GESTURE_FULL_WIDTH_SECONDS,
  VIDEO_SURFACE_GESTURE_LOCK_DISTANCE_PX,
  videoSeekGestureSpanSeconds,
  videoSeekGestureIntent,
  videoSeekGestureTarget,
} from "../src/features/video/videoSurfaceGesture";
import {
  isTouchLikePointer,
  playerEdgeGestureIntent,
} from "../src/shared/gestures/playerEdgeGesture";

const LOCK = VIDEO_SURFACE_GESTURE_LOCK_DISTANCE_PX;

describe("画面手势归属", () => {
  test("未越过阈值保持待定，短促接触仍归原始目标（弹幕层要靠它命中测试）", () => {
    expect(videoSeekGestureIntent(0, 0, true)).toBe("pending");
    expect(videoSeekGestureIntent(LOCK - 1, LOCK - 1, true)).toBe("pending");
  });

  test("横向占优交给 seek，纵向一律让给左右半屏亮度/音量", () => {
    expect(videoSeekGestureIntent(LOCK, 0, true)).toBe("seek");
    expect(videoSeekGestureIntent(-40, 6, true)).toBe("seek");
    expect(videoSeekGestureIntent(0, -LOCK, true)).toBe("reject");
    expect(videoSeekGestureIntent(6, 40, true)).toBe("reject");
  });

  test("斜向拖动谁都不认领，只作废点按与长按", () => {
    expect(videoSeekGestureIntent(30, 30, true)).toBe("reject");
    expect(videoSeekGestureIntent(-30, 28, true)).toBe("reject");
  });

  test("没有候选资格时方向再明确也不提交动作", () => {
    // 直播这类没有可 seek 时长的场景横向也不认领。
    expect(videoSeekGestureIntent(40, 0, false)).toBe("reject");
    expect(videoSeekGestureIntent(0, 40, false)).toBe("reject");
  });

  test("与边缘手势的判定尺度一致：纵向 adjust 对应 reject，横向 reject 对应 seek", () => {
    // 两者共用同一块画面。若尺度分叉就会出现「亮度已拒绝、seek 还没接手」的空档，
    // 那正是横向滑动既不调节也不快进的成因。
    for (const [dx, dy] of [
      [40, 0],
      [-40, 6],
      [30, 30],
    ] as const) {
      expect(playerEdgeGestureIntent(dx, dy)).toBe("reject");
      expect(videoSeekGestureIntent(dx, dy, true)).not.toBe("pending");
    }
    for (const [dx, dy] of [
      [0, 40],
      [6, -40],
    ] as const) {
      expect(playerEdgeGestureIntent(dx, dy)).toBe("adjust");
      expect(videoSeekGestureIntent(dx, dy, true)).toBe("reject");
    }
    for (const [dx, dy] of [
      [0, 0],
      [LOCK - 1, LOCK - 1],
    ] as const) {
      expect(playerEdgeGestureIntent(dx, dy)).toBe("pending");
      expect(videoSeekGestureIntent(dx, dy, true)).toBe("pending");
    }
  });
});

describe("横向 seek 映射", () => {
  test("跨度以固定秒数为上限，长视频不会整屏跨完全片", () => {
    expect(videoSeekGestureSpanSeconds(30)).toBe(30);
    expect(videoSeekGestureSpanSeconds(7200)).toBe(VIDEO_SEEK_GESTURE_FULL_WIDTH_SECONDS);
    expect(videoSeekGestureSpanSeconds(0)).toBe(0);
    expect(videoSeekGestureSpanSeconds(Number.POSITIVE_INFINITY)).toBe(0);
    expect(videoSeekGestureSpanSeconds(Number.NaN)).toBe(0);
  });

  test("右滑快进、左滑快退，整屏对应完整跨度", () => {
    const width = 360;
    const duration = 3600;
    expect(videoSeekGestureTarget(600, width, width, duration)).toBeCloseTo(
      600 + VIDEO_SEEK_GESTURE_FULL_WIDTH_SECONDS,
      6,
    );
    expect(videoSeekGestureTarget(600, -width, width, duration)).toBeCloseTo(
      600 - VIDEO_SEEK_GESTURE_FULL_WIDTH_SECONDS,
      6,
    );
    // 每像素的时间在同一宽度上恒定，半屏就是半个跨度。
    expect(videoSeekGestureTarget(600, width / 2, width, duration)).toBeCloseTo(
      600 + VIDEO_SEEK_GESTURE_FULL_WIDTH_SECONDS / 2,
      6,
    );
  });

  test("目标钳在 [0, duration]，首尾拖过头不会跑到负数或超长", () => {
    expect(videoSeekGestureTarget(5, -4000, 360, 3600)).toBe(0);
    expect(videoSeekGestureTarget(3590, 4000, 360, 3600)).toBe(3600);
  });

  test("窄画面按下限换算，小窗不会把每像素时间放大到无法控制", () => {
    const narrow = videoSeekGestureTarget(0, 120, 120, 3600);
    const atFloor = videoSeekGestureTarget(0, 120, 240, 3600);
    expect(narrow).toBeCloseTo(atFloor, 6);
  });

  test("时长无效时原地不动：DASH 的 duration 可能是 Infinity", () => {
    expect(videoSeekGestureTarget(42, 200, 360, 0)).toBe(42);
    expect(videoSeekGestureTarget(42, 200, 360, Number.POSITIVE_INFINITY)).toBe(42);
    expect(videoSeekGestureTarget(42, Number.NaN, 360, 3600)).toBe(42);
  });

  test("短片以自身长度为跨度上限，整屏最多走完这一条", () => {
    expect(videoSeekGestureTarget(0, 360, 360, 45)).toBe(45);
    expect(videoSeekGestureTarget(45, -360, 360, 45)).toBe(0);
  });
});

describe("触摸类指针判定", () => {
  test("空 pointerType 也算触摸：部分 Android WebView 对手指输入如此上报", () => {
    expect(isTouchLikePointer("touch")).toBe(true);
    expect(isTouchLikePointer("pen")).toBe(true);
    expect(isTouchLikePointer("")).toBe(true);
    expect(isTouchLikePointer("mouse")).toBe(false);
  });
});
