import { expect, test } from "bun:test";
import { laneEntryWaitMs, type LaneMotion } from "../src/features/room/danmaku/danmakuRenderer";

const moving = (patch: Partial<LaneMotion>): LaneMotion => ({
  paused: false,
  moving: true,
  left: 500,
  width: 200,
  speed: 0.1,
  ...patch,
});

test("空车道或普通弹幕尾部已进屏时大表情可立即进入", () => {
  expect(laneEntryWaitMs([], 0.1, 1_000)).toBe(0);
  // 两条轨的尾部右缘分别为 700px、1000px；同速后车不追尾，均可立即进入。
  expect(laneEntryWaitMs([moving(), moving({ left: 800 })], 0.1, 1_000)).toBe(0);
  // 左缘 900px、宽 200px 时尾部右缘仍在舞台外，不能立即进入。
  expect(laneEntryWaitMs([moving({ left: 900 })], 0.1, 1_000)).toBe(1_000);
});

test("普通弹幕尾部已进屏时立即进入，越过门限时等待", () => {
  // 尾部右缘 900px、1000px 都已到达同速门限 1000px。
  expect(laneEntryWaitMs([moving({ left: 700 })], 0.1, 1_000)).toBe(0);
  expect(laneEntryWaitMs([moving({ left: 800 })], 0.1, 1_000)).toBe(0);
  // 左缘 900px、宽 200px 时右缘 1100px，超出同速门限 100px。
  expect(laneEntryWaitMs([moving({ left: 900 })], 0.1, 1_000)).toBe(1_000);
  // 合并两轨时取较晚的一条；右缘 1100px，超出 gap 后的门限 980px 共 120px。
  expect(
    laneEntryWaitMs([moving({ left: 800 }), moving({ left: 900 })], 0.1, 1_000, 20),
  ).toBe(1_200);
});

test("快后车按相对速度等到不会追上后才进入", () => {
  // 前车尾部右缘 700px、0.1px/ms；后车 0.2px/ms 时安全门限降到 500px。
  expect(laneEntryWaitMs([moving()], 0.2, 1_000)).toBe(2_000);
  // 尾部右缘 500px 恰在追尾门限，后车可进入。
  expect(laneEntryWaitMs([moving({ left: 300 })], 0.2, 1_000)).toBe(0);
  // 左缘 500px 时右缘 700px，越过追尾门限 200px。
  expect(laneEntryWaitMs([moving({ left: 500 })], 0.2, 1_000)).toBe(2_000);
  // 后车不更快时相对速度不会额外收紧门限。
  expect(laneEntryWaitMs([moving({ left: 900 })], 0.05, 1_000)).toBe(1_000);
});

test("gap 同时收紧尾部与相对速度门限", () => {
  // edge=980px，追尾门限=min(980, 980×0.1/0.2)=490px；尾部右缘 700px 还差 210px。
  expect(laneEntryWaitMs([moving()], 0.2, 1_000, 20)).toBe(2_100);
});

test("多条前车同时约束时取最晚满足的一条", () => {
  const slowAhead = moving({ left: 600, speed: 0.1 });
  const fastAhead = moving({ left: 450, speed: 0.25 });
  // 慢车尾部右缘 800px，后车 0.2px/ms 时追尾门限为 500px，还差 300px，需 3s。
  // 快车尾部右缘 650px 已越过 500px 的追尾门限，不再增加等待。
  expect(laneEntryWaitMs([slowAhead, fastAhead], 0.2, 1_000)).toBe(3_000);
});

test("两条前车都未过门限时取较晚的一条", () => {
  const slowAhead = moving({ left: 750, speed: 0.1 });
  const fastAhead = moving({ left: 250, speed: 0.25 });
  // 慢车尾部右缘 950px，超出追尾门限 450px，按 0.1px/ms 需 4.5s。
  // 快车尾部右缘 450px，尚差 50px 到追尾门限，按 0.25px/ms 需 200ms。
  expect(laneEntryWaitMs([slowAhead, fastAhead], 0.2, 1_000)).toBe(4_500);
});

test("图片弹幕被钉住或运动快照不可用时保守重查", () => {
  // 普通弹幕的 paused 由 snapshot 调用层过滤；图片自身 paused 必须阻挡后车。
  expect(laneEntryWaitMs([moving({ paused: true })], 0.1, 1_000)).toBe(100);
  expect(laneEntryWaitMs([moving({ moving: false })], 0.1, 1_000)).toBe(100);
  expect(laneEntryWaitMs([moving({ width: 0 })], 0.1, 1_000)).toBe(100);
  expect(laneEntryWaitMs([moving({ left: Number.NaN })], 0.1, 1_000)).toBe(100);
  expect(laneEntryWaitMs([moving({ speed: 0 })], 0.1, 1_000)).toBe(100);
  expect(laneEntryWaitMs([moving({ speed: Number.NaN })], 0.1, 1_000)).toBe(100);
  expect(laneEntryWaitMs([moving()], 0, 1_000)).toBe(100);
  expect(laneEntryWaitMs([moving()], Number.NaN, 1_000)).toBe(100);
  expect(laneEntryWaitMs([moving()], 0.1, 0)).toBe(100);
});
