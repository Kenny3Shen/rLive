import { expect, test } from "bun:test";
import { laneEntryWaitMs, type LaneOccupant } from "../src/features/room/danmaku/danmakuRenderer";

const moving = (patch: Partial<LaneOccupant>): LaneOccupant => ({
  paused: false,
  moving: true,
  width: 200,
  distance: 0,
  speed: 0.1,
  ...patch,
});

test("空车道或普通弹幕尾部已进屏时大表情可立即进入", () => {
  expect(laneEntryWaitMs([])).toBe(0);
  expect(laneEntryWaitMs([moving({ distance: 200 }), moving({ distance: 500 })])).toBe(0);
});

test("普通弹幕尾部仍在舞台外时等到它完全进屏", () => {
  // 还差 150px，速度 0.1px/ms。
  expect(laneEntryWaitMs([moving({ distance: 50 })])).toBe(1_500);
  // 多条车道取最晚进屏的一条，并计入 gap。
  expect(laneEntryWaitMs([moving({ distance: 150 }), moving({ distance: 100 })], 20)).toBe(1_200);
});

test("钉住的弹幕不阻挡，尚未起步或速度未知时稍后重查", () => {
  expect(laneEntryWaitMs([moving({ paused: true, distance: 0 })])).toBe(0);
  expect(laneEntryWaitMs([moving({ moving: false })])).toBeGreaterThan(0);
  expect(laneEntryWaitMs([moving({ width: 0 })])).toBeGreaterThan(0);
  expect(laneEntryWaitMs([moving({ speed: 0 })])).toBeGreaterThan(0);
  expect(laneEntryWaitMs([moving({ speed: Number.NaN })])).toBeGreaterThan(0);
});
