// 移动端 VOD 详情侧栏的占比拖动：按住页签条上下拖，把侧栏拖大来看评论。
//
// 回归的是三件事，夹具一并守住：
//   1. 纵向拖动真的改占比，且舞台与侧栏之和恒等于容器高度（不会露出缝隙或重叠）；
//   2. 同一根页签条上的横向拖动仍归翻页，绝不改占比 —— 两套手势共用一串指针事件，
//      锁轴判定写错就会出现「想翻页却把侧栏拖大」或「想拖大却翻了页」；
//   3. 上下限生效、鼠标（细指针）不参与。
//
// 用真实 `Shell` + 真实播放页（`tests/browser/video-shell.html`）：只有经过外壳的
// 沉浸式分支才会走移动端布局，单独挂播放页看不到这条路径。
//
// 用法：
//   playwright-cli -s=vod-resize open http://127.0.0.1:1420/
//   playwright-cli -s=vod-resize run-code --filename=tests/vod-details-resize.browser.js
async (page) => {
  const FIXTURE = "http://127.0.0.1:1420/tests/browser/video-shell.html";
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };

  // Android UA 必须在页面脚本之前生效：`isMobileClient()` 决定 compact 与
  // 调占比的启停，夹具页面自己也会读它。
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", {
      get: () =>
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36",
      configurable: true,
    });
    Object.defineProperty(navigator, "userAgentData", {
      get: () => ({ platform: "Android", mobile: true }),
      configurable: true,
    });
  });

  await page.setViewportSize({ width: 401, height: 757 });
  await page.goto(FIXTURE);
  // 夹具 HTML 不带应用样式表，必须补引才有 Tailwind。
  await page.evaluate(async () => {
    await import("/src/styles.css");
  });
  await page.waitForSelector('[data-slot="app-swipe-track"]', { state: "attached", timeout: 20000 });
  await page.waitForFunction(
    () => document.querySelector('[data-slot="app-swipe-track"]')?.getBoundingClientRect().height > 100,
    undefined,
    { timeout: 20000 },
  );
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    document.querySelector('[data-slot="app-swipe-track"] button')?.click();
  });
  await page.waitForSelector("[data-player-hud]", { timeout: 20000 });
  await page.waitForTimeout(900);

  /** 当前布局快照。 */
  const read = () =>
    page.evaluate(() => {
      const frame = document.querySelector("[data-video-details-frame]");
      const stage = document.querySelector("[data-video-player-frame]");
      const aside = document.querySelector('aside[aria-label="视频详情"]');
      const track = document.querySelector('[data-slot="horizontal-swipe-track"]');
      return {
        handle: Boolean(document.querySelector("[data-vod-details-handle]")),
        share: frame?.style.getPropertyValue("--vod-details-share")?.trim() || null,
        resizing: frame?.dataset.vodDetailsResizing ?? null,
        frameHeight: frame ? +frame.getBoundingClientRect().height.toFixed(1) : null,
        stageHeight: stage ? +stage.getBoundingClientRect().height.toFixed(1) : null,
        asideHeight: aside ? +aside.getBoundingClientRect().height.toFixed(1) : null,
        tab: document.querySelector("[data-video-side-tab-panel]:not([aria-hidden])")?.dataset
          .videoSideTabPanel,
        trackOffset: track ? +new DOMMatrixReadOnly(getComputedStyle(track).transform).m41.toFixed(1) : null,
      };
    });

  /**
   * 一次指针手势。`points` 是相对起点的位移序列，逐帧派发（合成器与 React 的
   * 提交都要真实发生过，锁轴判定才与真机一致）。
   */
  const gesture = async (points, { pointerType = "touch", hold = false } = {}) =>
    page.evaluate(
      async ({ points, pointerType, hold }) => {
        const handle = document.querySelector("[data-vod-details-handle]");
        const rect = handle.getBoundingClientRect();
        const originX = rect.x + rect.width / 2;
        const originY = rect.y + rect.height / 2;
        const init = {
          pointerId: 41,
          pointerType,
          isPrimary: true,
          bubbles: true,
          cancelable: true,
        };
        handle.dispatchEvent(new PointerEvent("pointerdown", { ...init, clientX: originX, clientY: originY }));
        for (const point of points) {
          handle.dispatchEvent(
            new PointerEvent("pointermove", {
              ...init,
              clientX: originX + point.dx,
              clientY: originY + point.dy,
            }),
          );
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        const last = points.at(-1);
        if (!hold) {
          handle.dispatchEvent(
            new PointerEvent("pointerup", {
              ...init,
              clientX: originX + last.dx,
              clientY: originY + last.dy,
            }),
          );
        }
        return { originX, originY, init };
      },
      { points, pointerType, hold },
    );

  const results = [];

  // ---- 抓手在场，未拖动时不写内联占比（默认布局逐像素不变） ----
  const initial = await read();
  assert(initial.handle, "页签条没有成为调占比的抓手（缺少 data-vod-details-handle）");
  assert(initial.share === null, `未拖动就写了占比：${initial.share}`);
  assert(
    Math.abs(initial.stageHeight + initial.asideHeight - initial.frameHeight) < 0.5,
    `默认布局的舞台与侧栏高度之和不是容器高度：${initial.stageHeight} + ${initial.asideHeight} ≠ ${initial.frameHeight}`,
  );
  results.push(`默认布局：舞台 ${initial.stageHeight}px + 侧栏 ${initial.asideHeight}px 恰好铺满`);

  // ---- 向上拖：侧栏变高，跟手（拖动中就有中间帧） ----
  const dragUp = await gesture([{ dx: 0, dy: -12 }, { dx: 0, dy: -80 }, { dx: 0, dy: -160 }], {
    hold: true,
  });
  const midway = await read();
  assert(midway.resizing === "true", "拖动中没有打上 data-vod-details-resizing");
  assert(
    midway.asideHeight > initial.asideHeight + 40,
    `向上拖没有把侧栏拖大：${initial.asideHeight} → ${midway.asideHeight}`,
  );
  assert(
    Math.abs(midway.stageHeight + midway.asideHeight - midway.frameHeight) < 0.5,
    `拖动中舞台与侧栏不再铺满容器：${midway.stageHeight} + ${midway.asideHeight} ≠ ${midway.frameHeight}`,
  );
  // 松手
  await page.evaluate(
    ({ originX, originY, init }) => {
      const handle = document.querySelector("[data-vod-details-handle]");
      handle.dispatchEvent(
        new PointerEvent("pointerup", { ...init, clientX: originX, clientY: originY - 160 }),
      );
    },
    dragUp,
  );
  await page.waitForTimeout(250);
  const afterUp = await read();
  assert(afterUp.resizing === null, "松手后 data-vod-details-resizing 没有清掉");
  assert(
    afterUp.share !== null && parseFloat(afterUp.share) > 30,
    `松手后占比没有提交：${afterUp.share}`,
  );
  assert(
    Math.abs(afterUp.stageHeight + afterUp.asideHeight - afterUp.frameHeight) < 0.5,
    `提交后舞台与侧栏不再铺满容器：${afterUp.stageHeight} + ${afterUp.asideHeight} ≠ ${afterUp.frameHeight}`,
  );
  results.push(`向上拖 160px：侧栏 ${initial.asideHeight} → ${afterUp.asideHeight}px（占比 ${afterUp.share}）`);

  // ---- 上下限：拖到极限不越界，且总和仍然守恒 ----
  await gesture([{ dx: 0, dy: -12 }, { dx: 0, dy: -2000 }]);
  await page.waitForTimeout(200);
  const atMax = await read();
  assert(parseFloat(atMax.share) <= 85.001, `超出上限：${atMax.share}`);
  assert(atMax.stageHeight > 60, `拖到上限后舞台只剩 ${atMax.stageHeight}px`);
  await gesture([{ dx: 0, dy: 12 }, { dx: 0, dy: 2000 }]);
  await page.waitForTimeout(200);
  const atMin = await read();
  assert(parseFloat(atMin.share) >= 19.999, `超出下限：${atMin.share}`);
  assert(
    Math.abs(atMin.stageHeight + atMin.asideHeight - atMin.frameHeight) < 0.5,
    `下限处舞台与侧栏不再铺满容器：${atMin.stageHeight} + ${atMin.asideHeight} ≠ ${atMin.frameHeight}`,
  );
  results.push(`上下限生效：最大 ${atMax.share}、最小 ${atMin.share}`);

  // ---- 横向拖动仍然翻页，且绝不改占比 ----
  const beforeSwipe = await read();
  await gesture([{ dx: -12, dy: 0 }, { dx: -120, dy: 0 }, { dx: -260, dy: 0 }]);
  await page.waitForTimeout(500);
  const afterSwipe = await read();
  assert(
    afterSwipe.share === beforeSwipe.share,
    `横向拖动改了占比：${beforeSwipe.share} → ${afterSwipe.share}`,
  );
  assert(afterSwipe.tab !== beforeSwipe.tab, `横向拖动没有翻页（仍停在 ${afterSwipe.tab}）`);
  assert(
    Math.abs((afterSwipe.trackOffset ?? 0) + 401) < 1.5,
    `翻页后条带没有停到第二页：${afterSwipe.trackOffset}`,
  );
  results.push(`横向拖动仍翻页（${beforeSwipe.tab} → ${afterSwipe.tab}），占比保持 ${afterSwipe.share}`);

  // ---- 纵向拖动不改页签 ----
  const beforeVertical = await read();
  await gesture([{ dx: 0, dy: -12 }, { dx: 0, dy: -100 }]);
  await page.waitForTimeout(250);
  const afterVertical = await read();
  assert(
    afterVertical.tab === beforeVertical.tab,
    `纵向拖动换了页签：${beforeVertical.tab} → ${afterVertical.tab}`,
  );
  assert(
    parseFloat(afterVertical.share) !== parseFloat(beforeVertical.share ?? "0"),
    `纵向拖动没有改占比：${beforeVertical.share} → ${afterVertical.share}`,
  );
  results.push("纵向拖动只改占比、不换页签");

  // ---- 拖动中播放进度推进（真实 React 重渲染）不能打断拖动 ----
  //
  // 播放中的 `timeupdate` 每秒触发多次 `setCurrentTime`，每次都是一次真实提交。
  // 手势写在元素上的状态若参与 React 渲染，提交时会被当成垃圾清掉 ——
  // 属性一消失舞台就跳回画幅比高度，表现为拖动中画面一跳一跳。
  const beforeProgress = await read();
  await gesture([{ dx: 0, dy: -12 }, { dx: 0, dy: -160 }], { hold: true });
  const midDrag = await read();
  const progress = await page.evaluate(() => {
    const readTime = () =>
      document.querySelector("[data-player-controls]")?.textContent?.match(/\d+:\d\d/)?.[0] ?? null;
    const video = document.querySelector("video");
    const before = readTime();
    for (let second = 1; second <= 3; second += 1) {
      Object.defineProperty(video, "currentTime", { value: second, configurable: true });
      video.dispatchEvent(new Event("timeupdate"));
    }
    return { before, video };
  });
  await page.waitForTimeout(150);
  const afterCommit = await read();
  assert(
    afterCommit.resizing === "true",
    `重渲染后拖动标记丢失（React 清掉了手势写的属性）：${afterCommit.resizing}`,
  );
  assert(
    afterCommit.share === midDrag.share,
    `重渲染改动了拖动中的占比：${midDrag.share} → ${afterCommit.share}`,
  );
  assert(
    Math.abs(afterCommit.asideHeight - midDrag.asideHeight) < 1,
    `重渲染把侧栏高度跳回去了：${midDrag.asideHeight} → ${afterCommit.asideHeight}`,
  );
  await page.evaluate(() => {
    const handle = document.querySelector("[data-vod-details-handle]");
    const rect = handle.getBoundingClientRect();
    handle.dispatchEvent(
      new PointerEvent("pointerup", {
        pointerId: 41,
        pointerType: "touch",
        isPrimary: true,
        bubbles: true,
        cancelable: true,
        clientX: rect.x + rect.width / 2,
        clientY: rect.y + rect.height / 2 - 160,
      }),
    );
  });
  await page.waitForTimeout(250);
  results.push("拖动中播放进度推进（真实 React 重渲染）不打断拖动");

  // ---- 鼠标（细指针）不参与调占比 ----
  const beforeMouse = await read();
  await gesture([{ dx: 0, dy: -12 }, { dx: 0, dy: -200 }], { pointerType: "mouse" });
  await page.waitForTimeout(250);
  const afterMouse = await read();
  assert(
    afterMouse.share === beforeMouse.share,
    `鼠标拖动改了占比：${beforeMouse.share} → ${afterMouse.share}`,
  );
  results.push("鼠标拖动不参与（仅触摸/触控笔）");

  return { passed: results };
};
