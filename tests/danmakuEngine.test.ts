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
  test("spreads the first comments across the video instead of filling from the top", () => {
    const engine = createEngine({ fontSize: 18, speed: 8, opacity: 1 });
    engine.tick(0, 1280, 720);

    for (let index = 0; index < 4; index += 1) {
      engine.push(chat(`第 ${index + 1} 条弹幕`, index));
    }

    const items = engine.visibleItems();
    const positions = items.map((item) => item.y);

    expect(items).toHaveLength(4);
    expect(new Set(positions).size).toBe(4);
    expect(Math.max(...positions) - Math.min(...positions)).toBeGreaterThan(360);
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
});
