import { describe, expect, test } from "bun:test";
import { createEngine } from "../src/features/room/canvas/danmakuEngine";
import { danmakuCanvasPixelRatio } from "../src/features/room/canvas/framePacing";

function chat(content: string, ts: number, user = "观众") {
  return {
    kind: "chat" as const,
    user,
    content,
    color: null,
    ts,
  };
}

function richChat(content: string, ts: number, user = "观众") {
  return {
    ...chat(content, ts, user),
    spans: [
      { type: "text" as const, text: "收到 " },
      {
        type: "image" as const,
        image_url: "https://i0.hdslb.com/bfs/emote/test-question.png",
      },
      { type: "text" as const, text: "！" },
    ],
  };
}

describe("canvas backing store scale", () => {
  test("caps the device scale identically on every client", () => {
    expect(danmakuCanvasPixelRatio(1)).toBe(1);
    expect(danmakuCanvasPixelRatio(1.25)).toBe(1.25);
    expect(danmakuCanvasPixelRatio(2)).toBe(1.5);
    expect(danmakuCanvasPixelRatio(3)).toBe(1.5);
    expect(danmakuCanvasPixelRatio(Number.NaN)).toBe(1);
    expect(danmakuCanvasPixelRatio(0)).toBe(1);
  });
});

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

  test("keeps Bilibili image-emote spans with a textual canvas fallback", () => {
    const engine = createEngine({ fontSize: 18, speed: 8, opacity: 1 });
    engine.tick(0, 1280, 720);
    engine.push(richChat("[鸣潮·共鸣与群星_问号]", 1));

    const item = engine.visibleItems()[0];
    expect(item?.text).toBe("[鸣潮·共鸣与群星_问号]");
    expect(item?.richSpans).toEqual([
      { type: "text", text: "收到 " },
      {
        type: "image",
        image_url: "https://i0.hdslb.com/bfs/emote/test-question.png",
      },
      { type: "text", text: "！" },
    ]);
    // A fixed image box is included in the track's collision width before
    // the browser has loaded the CDN image.
    expect(item?.width).toBeGreaterThan(18 * 1.35);
  });

  test("adds repeat counts after a Bilibili image-emote instead of discarding it", () => {
    const engine = createEngine({
      fontSize: 18,
      speed: 8,
      opacity: 1,
      aggregateRepeats: true,
    });
    engine.tick(0, 1280, 720);
    engine.push(richChat("[Ave Mujica_怎么突然]", 1_000, "观众甲"));
    engine.push(richChat("[Ave Mujica_怎么突然]", 2_000, "观众乙"));

    const item = engine.visibleItems()[0];
    expect(item?.text).toBe("[Ave Mujica_怎么突然] ×2");
    expect(item?.richSpans).toEqual([
      { type: "text", text: "收到 " },
      {
        type: "image",
        image_url: "https://i0.hdslb.com/bfs/emote/test-question.png",
      },
      { type: "text", text: "！ ×2" },
    ]);
  });

  test("aggregates matching floating chat inside the configured window", () => {
    const engine = createEngine({
      fontSize: 18,
      speed: 8,
      opacity: 1,
      aggregateRepeats: true,
      aggregateWindowMs: 5_000,
    });
    engine.tick(0, 1280, 720);

    engine.push(chat("加油", 1_000, "观众甲"));
    engine.push(chat("加油", 2_000, "观众乙"));

    expect(engine.visibleItems()).toHaveLength(1);
    expect(engine.visibleItems()[0]?.text).toBe("加油 ×2");

    engine.push(chat("加油", 8_100, "观众丙"));
    expect(engine.visibleItems()).toHaveLength(2);
    expect(engine.visibleItems()[1]?.text).toBe("加油");
  });

  test("applies a changed aggregation window without recreating the engine", () => {
    const engine = createEngine({
      fontSize: 18,
      speed: 8,
      opacity: 1,
      aggregateRepeats: true,
      aggregateWindowMs: 5_000,
    });
    engine.tick(0, 1280, 720);

    engine.setOpts({
      fontSize: 18,
      speed: 8,
      opacity: 1,
      aggregateRepeats: true,
      aggregateWindowMs: 10_000,
    });
    engine.push(chat("窗口已更新", 10_000, "观众甲"));
    engine.push(chat("窗口已更新", 19_500, "观众乙"));

    expect(engine.visibleItems().find((item) => item.text === "窗口已更新 ×2")).toBeDefined();
  });

  test("keeps a local account comment separate without changing its color", () => {
    const engine = createEngine({
      fontSize: 18,
      speed: 8,
      opacity: 1,
      aggregateRepeats: true,
    });
    engine.tick(0, 1280, 720);

    engine.push({ ...chat("同一句弹幕", 1_000, "我"), is_self: true });
    engine.push({ ...chat("同一句弹幕", 1_100, "其他观众"), color: "#abcdef" });

    const items = engine.visibleItems();
    expect(items).toHaveLength(2);
    expect(items.find((item) => item.isSelf)?.color).toBe("#ffffff");
    expect(items.find((item) => item.isSelf)?.isSelf).toBe(true);
    expect(items.find((item) => !item.isSelf)?.color).toBe("#abcdef");
    expect(items.find((item) => item.isSelf)?.width).toBeGreaterThan(
      items.find((item) => !item.isSelf)?.width ?? 0,
    );
  });

  test("keeps a growing aggregate clear of its leading lane item", () => {
    const engine = createEngine({
      fontSize: 18,
      speed: 8,
      opacity: 1,
      lineCount: 1,
      aggregateRepeats: true,
    });
    engine.tick(0, 400, 40);
    engine.push(chat("一条足够长的前导弹幕", 1));
    engine.tick(0.2, 400, 40);
    engine.push(chat("B", 1_000));

    let leading = engine.visibleItems().find((item) => item.text.includes("前导弹幕"));
    let aggregate = engine.visibleItems().find((item) => item.text === "B");
    for (let index = 0; index < 20 && (!leading || !aggregate); index += 1) {
      engine.tick(0.2, 400, 40);
      leading = engine.visibleItems().find((item) => item.text.includes("前导弹幕"));
      aggregate = engine.visibleItems().find((item) => item.text === "B");
    }

    if (!leading || !aggregate) throw new Error("expected both same-lane items to be visible");

    for (let count = 2; count <= 31; count += 1) {
      engine.push(chat("B", 1_000 + count, `观众 ${count}`));
    }

    const updated = engine.visibleItems().find((item) => item.text === "B ×31");
    if (!updated) throw new Error("expected the aggregate count to update in place");
    expect(updated.x - (leading.x + leading.width)).toBeGreaterThanOrEqual(24);
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

  test("keeps an on-screen comment visible when the viewport width narrows", () => {
    const engine = createEngine({ fontSize: 18, speed: 8, opacity: 1 });
    engine.tick(0, 1280, 720);
    engine.push(chat("调整窗口后继续从原位置飘过", 1));
    engine.tick(0.2, 1280, 720);

    const beforeResize = engine.visibleItems()[0];
    const xBeforeResize = beforeResize?.x;
    engine.tick(0, 720, 360);
    const resized = engine.visibleItems()[0];

    expect(resized?.x).not.toBe(xBeforeResize);
    expect(resized?.x).toBeLessThan(720);
    expect(resized?.x ?? -Infinity).toBeGreaterThan(-(resized?.width ?? 0));

    const beforeProgress =
      (1280 + 12 - (xBeforeResize ?? 0)) / (1280 + 12 + (beforeResize?.width ?? 0) + 20);
    const afterProgress = (720 + 12 - (resized?.x ?? 0)) / (720 + 12 + (resized?.width ?? 0) + 20);
    expect(afterProgress).toBeCloseTo(beforeProgress, 2);
  });

  test("continues a visible comment through repeated window-size changes", () => {
    const engine = createEngine({ fontSize: 18, speed: 8, opacity: 1 });
    engine.tick(0, 1280, 720);
    engine.push(chat("连续调整窗口时也不能提前消失", 1));
    engine.tick(0.2, 1280, 720);

    engine.tick(0, 480, 360);
    const afterFirstResize = engine.visibleItems()[0];
    expect(afterFirstResize).toBeDefined();
    expect(afterFirstResize?.x).toBeLessThan(480);
    expect((afterFirstResize?.x ?? -Infinity) + (afterFirstResize?.width ?? 0)).toBeGreaterThan(0);

    engine.tick(0, 240, 180);
    const afterSecondResize = engine.visibleItems()[0];
    expect(afterSecondResize).toBeDefined();
    expect(afterSecondResize?.x).toBeLessThan(240);
    expect((afterSecondResize?.x ?? -Infinity) + (afterSecondResize?.width ?? 0)).toBeGreaterThan(
      0,
    );

    const xBeforeMove = afterSecondResize?.x ?? Infinity;
    engine.tick(0.2, 240, 180);
    expect(engine.visibleItems()[0]?.x).toBeLessThan(xBeforeMove);
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

  test("keeps a faster queued comment from catching a slower leading comment", () => {
    const engine = createEngine({
      fontSize: 18,
      speed: 2,
      opacity: 1,
      lineCount: 1,
    });
    engine.tick(0, 600, 40);
    engine.push(chat("慢速前导弹幕需要保留安全间距", 1));

    engine.setOpts({
      fontSize: 18,
      speed: 10,
      opacity: 1,
      lineCount: 1,
      area: 0.9,
      fontWeight: 600,
    });
    engine.push(chat("快速后续弹幕", 2));

    let followedWhileLeadingWasVisible = false;
    for (let index = 0; index < 100; index += 1) {
      engine.tick(0.1, 600, 40);
      const leading = engine.visibleItems().find((item) => item.text.includes("慢速前导"));
      const following = engine.visibleItems().find((item) => item.text.includes("快速后续"));
      if (!leading || !following) continue;
      // The collision invariant applies until the leading message leaves the
      // visible viewport; the engine retains it for a short offscreen tail so
      // the next compaction does not churn the active array.
      if (leading.x + leading.width <= 0) continue;

      followedWhileLeadingWasVisible = true;
      expect(following.x - (leading.x + leading.width)).toBeGreaterThanOrEqual(24);
    }

    expect(followedWhileLeadingWasVisible).toBe(true);
  });

  test("coalesces a high-volume native batch without repeated full-lane scans", () => {
    const engine = createEngine({
      fontSize: 18,
      speed: 8,
      opacity: 1,
      lineCount: 20,
      debug: true,
    });
    engine.tick(0, 1920, 1080);

    const burst = Array.from({ length: 1_200 }, (_, index) => chat(`压力弹幕 ${index}`, index));
    engine.pushBatch(burst, true);

    const afterBatch = engine.debugStats();
    expect(afterBatch.activeItems).toBe(20);
    expect(afterBatch.pendingItems).toBe(60);
    // One transport batch gets one scheduler pass. The collision work is
    // lane-local: filling 20 lanes plus checking the blocked head touches 40
    // lanes / 20 existing items, rather than rechecking 1,200 arrivals.
    expect(afterBatch.schedulePasses).toBe(1);
    expect(afterBatch.laneChecks).toBeLessThanOrEqual(40);
    expect(afterBatch.laneItemChecks).toBeLessThanOrEqual(20);

    for (let index = 0; index < 10; index += 1) {
      engine.tick(1 / 120, 1920, 1080);
    }
    const afterFrames = engine.debugStats();
    // The retry deadline prevents a collision scan on every 120fps frame
    // while the queue head is known to be blocked.
    expect(afterFrames.schedulePasses - afterBatch.schedulePasses).toBeLessThanOrEqual(1);
    expect(afterFrames.laneItemChecks - afterBatch.laneItemChecks).toBeLessThanOrEqual(20);
  });

  test("keeps 5k and 10k transport bursts memory-bounded without scheduler churn", () => {
    for (const total of [5_000, 10_000]) {
      const engine = createEngine({
        fontSize: 18,
        speed: 8,
        opacity: 1,
        lineCount: 20,
        debug: true,
      });
      engine.tick(0, 1920, 1080);

      engine.pushBatch(
        Array.from({ length: total }, (_, index) => chat(`极限压力 ${index}`, index)),
        true,
      );

      const afterBurst = engine.debugStats();
      // The renderer has an explicit active-item cap and the scheduler has a
      // separate bounded waiting queue, so burst size cannot grow either
      // retained collection or trigger one lane pass per message.
      expect(afterBurst.activeItems).toBeLessThanOrEqual(80);
      expect(afterBurst.pendingItems).toBeLessThanOrEqual(80);
      expect(afterBurst.schedulePasses).toBe(1);
      expect(afterBurst.laneChecks).toBeLessThanOrEqual(40);
      expect(afterBurst.laneItemChecks).toBeLessThanOrEqual(20);

      for (let frame = 0; frame < 30; frame += 1) {
        engine.tick(1 / 120, 1920, 1080);
      }
      const afterFrames = engine.debugStats();
      // A blocked head carries its predicted retry deadline, so a 120fps
      // render loop does not repeatedly rescan lanes while nothing can fit.
      expect(afterFrames.schedulePasses - afterBurst.schedulePasses).toBeLessThanOrEqual(1);
      expect(afterFrames.activeItems).toBeLessThanOrEqual(80);
      expect(afterFrames.pendingItems).toBeLessThanOrEqual(80);
    }
  });
});

describe("danmaku pointer hover", () => {
  /**
   * Advance a fresh comment into the viewport. Items spawn just past the right
   * edge (`viewportWidth + SPAWN_PADDING`), and the hit test deliberately skips
   * anything not yet on screen, so a pointer can only reach a comment that has
   * scrolled in.
   */
  function scrollIntoView(engine: ReturnType<typeof createEngine>, frames = 60) {
    for (let frame = 0; frame < frames; frame += 1) engine.tick(1 / 60, 1280, 720);
  }

  test("hits the comment under the pointer and misses the gap around it", () => {
    const engine = createEngine({ fontSize: 18, speed: 8, opacity: 1 });
    engine.tick(0, 1280, 720);
    engine.push(chat("点我试试", 1));
    scrollIntoView(engine);

    const item = engine.visibleItems()[0]!;
    expect(item.x).toBeLessThan(1280);
    // The border box is what the user aims at, so the padding is inside the
    // hit area on both axes.
    const hit = engine.hitTest(item.x + item.width / 2, item.y + item.fontSize / 2);
    expect(hit?.item.hoverKey).toBe(item.hoverKey);
    expect(hit?.box.height).toBe(item.fontSize);

    // Well below the em square, inside the leading the lane reserves for
    // spacing but outside the box the renderer draws.
    expect(engine.hitTest(item.x + item.width / 2, item.y + item.fontSize * 1.3)).toBeNull();
    expect(engine.hitTest(item.x - 40, item.y + item.fontSize / 2)).toBeNull();
  });

  test("prefers the comment drawn on top where two overlap", () => {
    const engine = createEngine({ fontSize: 18, speed: 8, opacity: 1, lineCount: 1 });
    engine.tick(0, 1280, 720);
    engine.push(chat("先来的", 1));
    // A single lane forces the second comment to share the first one's row.
    engine.push(chat("后来的", 2));
    scrollIntoView(engine, 240);

    const [first, second] = engine.visibleItems();
    // Anti-tailgating keeps neighbours apart on screen, so overlap has to be
    // staged through the drawn-box lookup — which is exactly the hook the
    // renderer uses to report what it actually painted.
    const shared = { x: first!.x, y: first!.y, width: first!.width, height: first!.fontSize };
    const hit = engine.hitTest(
      first!.x + first!.width / 2,
      first!.y + first!.fontSize / 2,
      () => shared,
    );
    // Later items paint over earlier ones, so the hit test scans back to front.
    expect(hit?.item.hoverKey).toBe(second!.hoverKey);
  });

  test("uses the renderer's box instead of the wider scheduling reservation", () => {
    const engine = createEngine({ fontSize: 18, speed: 8, opacity: 1 });
    engine.tick(0, 1280, 720);
    engine.push(chat("预留比实绘更宽", 1));
    scrollIntoView(engine);

    const item = engine.visibleItems()[0]!;
    const narrow = { x: item.x, y: item.y, width: item.width / 2, height: item.fontSize };
    const pointerX = item.x + item.width * 0.8;

    // Inside the reservation but past the glyphs the frame actually drew.
    expect(engine.hitTest(pointerX, item.y + 4)).not.toBeNull();
    expect(engine.hitTest(pointerX, item.y + 4, () => narrow)).toBeNull();
  });

  test("freezes only the hovered comment and releases it again", () => {
    const engine = createEngine({ fontSize: 18, speed: 8, opacity: 1 });
    engine.tick(0, 1280, 720);
    engine.push(chat("停住的", 1));
    engine.push(chat("继续飘的", 2));
    scrollIntoView(engine);

    const [held, moving] = engine.visibleItems();
    const heldStartX = held!.x;
    const movingStartX = moving!.x;
    engine.setPaused(held!.hoverKey);
    expect(engine.pausedItem()?.hoverKey).toBe(held!.hoverKey);

    for (let frame = 0; frame < 30; frame += 1) engine.tick(1 / 60, 1280, 720);

    expect(engine.visibleItems().find((it) => it.hoverKey === held!.hoverKey)?.x).toBe(heldStartX);
    const movedX = engine.visibleItems().find((it) => it.hoverKey === moving!.hoverKey)?.x;
    expect(movedX).toBeLessThan(movingStartX);

    // Releasing resumes the comment from where it was held, at its original
    // speed: the freeze never touched it.
    engine.setPaused(null);
    expect(engine.pausedItem()).toBeNull();
    engine.tick(1 / 60, 1280, 720);
    expect(engine.visibleItems().find((it) => it.hoverKey === held!.hoverKey)?.x).toBeLessThan(
      heldStartX,
    );
  });

  test("routes a new comment around the lane a frozen comment blocks", () => {
    const engine = createEngine({ fontSize: 18, speed: 8, opacity: 1 });
    engine.tick(0, 1280, 720);
    engine.push(chat("占住第一条轨道", 1));

    const held = engine.visibleItems()[0]!;
    engine.setPaused(held.hoverKey);
    // Hold it near the right edge so its lane can never clear.
    for (let frame = 0; frame < 10; frame += 1) engine.tick(1 / 60, 1280, 720);
    const frozenX = held.x;

    engine.push(chat("换一条轨道", 2_000));
    for (let frame = 0; frame < 10; frame += 1) engine.tick(1 / 60, 1280, 720);

    const next = engine.visibleItems().find((it) => it.hoverKey !== held.hoverKey);
    expect(next).toBeDefined();
    expect(next!.y).not.toBe(held.y);
    // The block is what forced the reroute, so the frozen comment must still be
    // sitting where it was: a freeze that quietly resumed would prove nothing.
    expect(held.x).toBe(frozenX);
  });

  test("drops the freeze when the frozen comment leaves the render list", () => {
    const engine = createEngine({ fontSize: 18, speed: 8, opacity: 1, lineCount: 20 });
    engine.tick(0, 1920, 1080);
    engine.push(chat("很快就会被淘汰", 1));

    const held = engine.visibleItems()[0]!;
    engine.setPaused(held.hoverKey);
    expect(engine.pausedItem()?.hoverKey).toBe(held.hoverKey);

    // Overrun the bounded active-item list. The frozen comment holds its
    // position, so only eviction can remove it. The waiting queue is bounded
    // too, so the flood has to arrive in batches with frames in between —
    // a single huge push is mostly dropped before it can fill the screen.
    for (let round = 0; round < 12; round += 1) {
      engine.pushBatch(
        Array.from({ length: 80 }, (_, index) =>
          chat(`洪水 ${round}-${index}`, 1_000 + round * 80 + index),
        ),
        true,
      );
      for (let frame = 0; frame < 90; frame += 1) engine.tick(1 / 60, 1920, 1080);
    }

    const stillPresent = engine.visibleItems().some((it) => it.hoverKey === held.hoverKey);
    expect(stillPresent).toBe(false);
    // A later comment must not inherit the freeze through a reused lane.
    expect(engine.pausedItem()).toBeNull();
  });

  test("drops the freeze when a frozen fixed-top card expires", () => {
    const engine = createEngine({ fontSize: 18, speed: 8, opacity: 1 });
    engine.tick(0, 1280, 720);
    engine.push({ kind: "super_chat", user: "船长", content: "置顶也能悬停", color: null, ts: 1 });

    const held = engine.visibleItems()[0]!;
    expect(held.kind).toBe("top");
    engine.setPaused(held.hoverKey);
    expect(engine.pausedItem()?.hoverKey).toBe(held.hoverKey);

    // A fixed-top card leaves on its own timer rather than by scrolling off, so
    // it reaches `noteRemovedItem` through a different branch than eviction.
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 10_000;
      engine.tick(1 / 60, 1280, 720);
    } finally {
      Date.now = realNow;
    }

    expect(engine.visibleItems()).toHaveLength(0);
    expect(engine.pausedItem()).toBeNull();
  });
});
