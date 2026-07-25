import { describe, expect, test } from "bun:test";
import { createEngine } from "../src/features/room/canvas/danmakuEngine";

function chat(content: string, ts: number) {
  return {
    kind: "chat" as const,
    user: "观众",
    content,
    color: null,
    ts,
  };
}

describe("danmaku engine", () => {
  test("reports when the canvas can safely stop requesting animation frames", () => {
    const engine = createEngine({ fontSize: 18, speed: 8, opacity: 1 });
    engine.tick(0, 120, 40);

    expect(engine.hasWork()).toBe(false);
    engine.push(chat("会离开画面的弹幕", 1));
    expect(engine.hasWork()).toBe(true);

    for (let index = 0; index < 20; index += 1) {
      engine.tick(0.2, 120, 40);
    }

    expect(engine.hasWork()).toBe(false);
  });

  test("assigns the first comments to tracks from the top down", () => {
    const engine = createEngine({ fontSize: 18, speed: 8, opacity: 1 });
    engine.tick(0, 1280, 720);

    for (let index = 0; index < 4; index += 1) {
      engine.push(chat(`第 ${index + 1} 条弹幕`, index));
    }

    const items = engine.visibleItems();
    const positions = items.map((item) => item.y);

    expect(items).toHaveLength(4);
    expect(positions).toEqual([12, 39, 66, 93]);
    for (const item of items) {
      expect(item.y).toBeGreaterThanOrEqual(0);
      expect(item.y + item.fontSize).toBeLessThanOrEqual(720);
    }
  });

  test("delays a same-lane comment until it can keep a safe tail gap", () => {
    const engine = createEngine({ fontSize: 18, speed: 8, opacity: 1 });
    engine.tick(0, 400, 40);
    engine.push(chat("一条足够长的前导弹幕", 1));
    engine.tick(0.2, 400, 40);
    engine.push(chat("后续弹幕", 2));

    expect(engine.visibleItems()).toHaveLength(1);

    let scheduledSafely = false;
    for (let index = 0; index < 12; index += 1) {
      engine.tick(0.2, 400, 40);
      const items = engine.visibleItems();
      const following = items.find((item) => item.text.includes("后续弹幕"));
      const leading = items.find((item) => item.text.includes("前导弹幕"));

      if (following && leading) {
        expect(following.x - (leading.x + leading.width)).toBeGreaterThanOrEqual(24);
        scheduledSafely = true;
        break;
      }
    }

    expect(scheduledSafely).toBe(true);
  });

  test("keeps scrolling after a tick and reflows all tracks inside a smaller viewport", () => {
    const engine = createEngine({ fontSize: 18, speed: 8, opacity: 1 });
    engine.tick(0, 1280, 720);
    engine.push(chat("会移动的弹幕", 1));
    const initialX = engine.visibleItems()[0].x;

    engine.tick(0.2, 1280, 720);
    expect(engine.visibleItems()[0].x).toBeLessThan(initialX);

    for (let index = 0; index < 10; index += 1) {
      engine.push(chat(`缩放测试 ${index}`, index + 2));
    }
    engine.tick(0, 640, 180);

    for (const item of engine.visibleItems()) {
      expect(item.y).toBeGreaterThanOrEqual(0);
      expect(item.y + item.fontSize).toBeLessThanOrEqual(180);
    }
  });

  test("limits scrolling lanes when the user selects a visible-line cap", () => {
    const engine = createEngine({
      fontSize: 18,
      speed: 8,
      opacity: 1,
      area: 1,
      lineCount: 1,
    });
    engine.tick(0, 1280, 720);
    engine.push(chat("第一条", 1));
    engine.push(chat("第二条", 2));

    expect(engine.visibleItems()).toHaveLength(1);
    expect(engine.hasWork()).toBe(true);
  });

  test("applies a live font-weight setting without restarting the engine", () => {
    const engine = createEngine({ fontSize: 18, speed: 8, opacity: 1, fontWeight: 400 });
    expect(engine.fontWeight()).toBe(400);

    engine.setOpts({
      fontSize: 18,
      speed: 8,
      opacity: 1,
      area: 0.5,
      lineCount: 6,
      fontWeight: 700,
    });

    expect(engine.fontWeight()).toBe(700);
  });

  test("invalidates the cached lane layout after a live font-size change", () => {
    const engine = createEngine({ fontSize: 18, speed: 8, opacity: 1 });
    engine.tick(0, 400, 120);
    engine.push(chat("旧字号弹幕", 1));

    engine.setOpts({
      fontSize: 30,
      speed: 8,
      opacity: 1,
      area: 0.9,
      lineCount: 0,
      fontWeight: 600,
    });
    engine.tick(0, 400, 120);
    engine.push(chat("新字号弹幕", 2));

    const newer = engine.visibleItems().find((item) => item.text === "新字号弹幕");
    expect(newer?.fontSize).toBe(30);
    // 30px text uses a 39px lane (font + 9), not the stale 27px lane from
    // the 18px setting. This guards the cache invalidation path.
    expect(newer?.y).toBe(51);
  });

  test("shrinks cached lanes after the last larger message leaves", () => {
    const engine = createEngine({ fontSize: 36, speed: 8, opacity: 1 });
    engine.tick(0, 120, 120);
    engine.push(chat("大字号", 1));

    engine.setOpts({
      fontSize: 18,
      speed: 8,
      opacity: 1,
      area: 0.9,
      lineCount: 0,
      fontWeight: 600,
    });
    for (let index = 0; index < 24; index += 1) {
      engine.tick(0.2, 120, 120);
    }
    expect(engine.visibleItems()).toHaveLength(0);

    engine.push(chat("恢复小字号一", 2));
    engine.push(chat("恢复小字号二", 3));
    const yPositions = engine.visibleItems().map((item) => item.y);
    expect(yPositions).toHaveLength(2);
    // Lane selection continues round-robin, but its spacing must return to
    // the 18px setting's 27px lane rather than retaining the old 45px lane.
    expect(yPositions[1] - yPositions[0]).toBe(27);
  });
});
