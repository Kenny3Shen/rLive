// 移动端 VOD 详情侧栏的占比拖动：按住页签条上下拖，把侧栏拖大来看评论。
//
// 回归的是四件事，夹具一并守住：
//   1. 纵向拖动真的改占比，且舞台与侧栏之和恒等于容器高度（不会露出缝隙或重叠）；
//   2. 上限是「舞台仍保得住一个满宽 16:9 视频窗口」——竖屏视频默认被 70% 封顶时
//      可以往上拖，但画面不会被压到 16:9 以下；16:9 视频的默认布局已经在这一档上，
//      因此往上拖读作「到头了」；
//   3. 同一根页签条上的横向拖动仍归翻页，绝不改占比 —— 两套手势共用一串指针事件，
//      锁轴判定写错就会出现「想翻页却把侧栏拖大」或「想拖大却翻了页」；
//   4. 上下限生效、容器变矮后已提交的占比跟着收回、鼠标（细指针）不参与。
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

  // 夹具宽度 401px、测试手机竖屏 401×757。
  const VIEWPORT = { width: 401, height: 757 };
  /** 满宽 16:9 在 401px 宽容器里的高度，也是舞台的高度下限。 */
  const stageFloor = VIEWPORT.width / (16 / 9);

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

  /**
   * 从视频列表点进播放页。
   *
   * 每次重进都是全新一次会话：拖动过之后舞台高度由内联 `--vod-details-share`
   * 决定，画幅比不再参与，改 `videoWidth` / `videoHeight` 也不会换布局 —— 要换成
   * 竖屏源来测「还能往上拖」就必须重新进页。
   *
   * `portrait` 给夹具的媒体元素伪造竖屏画幅并派发 `resize`（真实播放页就是靠这个
   * 事件量到源画幅的），于是舞台按 9:16 撑高、被移动端的 70% 上限封顶。
   */
  const enterPlayer = async ({ portrait = false } = {}) => {
    await page.goto(FIXTURE);
    // 夹具 HTML 不带应用样式表，必须补引才有 Tailwind。
    await page.evaluate(async () => {
      await import("/src/styles.css");
    });
    await page.waitForSelector('[data-slot="app-swipe-track"]', {
      state: "attached",
      timeout: 20000,
    });
    await page.waitForFunction(
      () =>
        document.querySelector('[data-slot="app-swipe-track"]')?.getBoundingClientRect().height >
        100,
      undefined,
      { timeout: 20000 },
    );
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      document.querySelector('[data-slot="app-swipe-track"] button')?.click();
    });
    await page.waitForSelector("[data-player-hud]", { timeout: 20000 });
    await page.waitForTimeout(900);
    if (portrait) {
      await page.evaluate(() => {
        const video = document.querySelector("video");
        Object.defineProperty(video, "videoWidth", { value: 1080, configurable: true });
        Object.defineProperty(video, "videoHeight", { value: 1920, configurable: true });
        video.dispatchEvent(new Event("resize"));
      });
      await page.waitForTimeout(400);
    }
  };

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
        trackOffset: track
          ? +new DOMMatrixReadOnly(getComputedStyle(track).transform).m41.toFixed(1)
          : null,
      };
    });

  /** 舞台与侧栏必须精确铺满容器，不露缝隙也不重叠。 */
  const assertSumHolds = async (label) => {
    const snap = await read();
    assert(
      Math.abs(snap.stageHeight + snap.asideHeight - snap.frameHeight) < 0.5,
      `${label}舞台与侧栏不再铺满容器：${snap.stageHeight} + ${snap.asideHeight} ≠ ${snap.frameHeight}`,
    );
    return snap;
  };

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
        handle.dispatchEvent(
          new PointerEvent("pointerdown", { ...init, clientX: originX, clientY: originY }),
        );
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

  await page.setViewportSize(VIEWPORT);

  // ================= 16:9 源：默认布局就已经踩在 16:9 下限上 =================
  await enterPlayer();
  const initial = await read();
  assert(initial.handle, "页签条没有成为调占比的抓手（缺少 data-vod-details-handle）");
  assert(initial.share === null, `未拖动就写了占比：${initial.share}`);
  await assertSumHolds("默认布局：");
  assert(
    Math.abs(initial.stageHeight - stageFloor) < 0.5,
    `夹具默认不是 16:9 布局：舞台 ${initial.stageHeight}px ≠ ${stageFloor.toFixed(1)}px`,
  );
  results.push(`默认布局：舞台 ${initial.stageHeight}px + 侧栏 ${initial.asideHeight}px 恰好铺满`);

  // 往上拖到极限：侧栏不再变高，舞台仍是满宽 16:9 —— 若上限写成固定的 85%，
  // 舞台会被压到 113px（半屏黑边），这条断言失败。
  await gesture([{ dx: 0, dy: -12 }, { dx: 0, dy: -2000 }]);
  await page.waitForTimeout(250);
  const wideAtMax = await assertSumHolds("16:9 源上限处：");
  assert(
    wideAtMax.stageHeight >= stageFloor - 0.5,
    `16:9 源拖到极限后舞台 ${wideAtMax.stageHeight}px 放不下满宽 16:9（需 ${stageFloor.toFixed(1)}px）`,
  );
  results.push(
    `16:9 源拖到极限：舞台保持 ${wideAtMax.stageHeight}px（≥ 16:9 的 ${stageFloor.toFixed(1)}px）`,
  );

  // ================= 竖屏源：默认被 70% 封顶，可以往上拖 =================
  await enterPlayer({ portrait: true });
  const portraitInitial = await read();
  assert(
    Math.abs(portraitInitial.stageHeight - VIEWPORT.height * 0.7) < 1,
    `竖屏源舞台没有被 70% 封顶：${portraitInitial.stageHeight}px`,
  );
  assert(
    portraitInitial.stageHeight > stageFloor + 40,
    `竖屏源没有给侧栏留出可拖大的空间：舞台 ${portraitInitial.stageHeight}px`,
  );

  // ---- 向上拖：侧栏变高，跟手（拖动中就有中间帧） ----
  const dragUp = await gesture([{ dx: 0, dy: -12 }, { dx: 0, dy: -80 }, { dx: 0, dy: -160 }], {
    hold: true,
  });
  const midway = await read();
  assert(midway.resizing === "true", "拖动中没有打上 data-vod-details-resizing");
  assert(
    midway.asideHeight > portraitInitial.asideHeight + 40,
    `向上拖没有把侧栏拖大：${portraitInitial.asideHeight} → ${midway.asideHeight}`,
  );
  await assertSumHolds("拖动中：");
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
  await assertSumHolds("提交后：");
  results.push(
    `竖屏源向上拖 160px：侧栏 ${portraitInitial.asideHeight} → ${afterUp.asideHeight}px（占比 ${afterUp.share}）`,
  );

  // ---- 上限：竖屏源拖到极限时舞台仍保得住一个满宽 16:9 视频窗口 ----
  //
  // 401×757 的手机上 16:9 高 225.6px，因此占比上限约 70.2% —— 与竖屏源默认
  // 占比重合（70% 封顶那一档）。
  await gesture([{ dx: 0, dy: -12 }, { dx: 0, dy: -2000 }]);
  await page.waitForTimeout(250);
  const atMax = await assertSumHolds("上限处：");
  assert(
    atMax.stageHeight >= stageFloor - 0.5,
    `拖到上限后舞台 ${atMax.stageHeight}px 放不下满宽 16:9（需 ${stageFloor.toFixed(1)}px）`,
  );

  // ---- 下限：继续往下拖，侧栏停在 20% ----
  await gesture([{ dx: 0, dy: 12 }, { dx: 0, dy: 2000 }]);
  await page.waitForTimeout(250);
  const atMin = await assertSumHolds("下限处：");
  assert(parseFloat(atMin.share) >= 19.999, `超出下限：${atMin.share}`);
  results.push(
    `上下限生效：最大 ${atMax.share}（舞台 ${atMax.stageHeight}px ≥ 16:9 的 ${stageFloor.toFixed(1)}px）、最小 ${atMin.share}`,
  );

  // ---- 容器变矮后已提交的占比跟着收回（旋转、分屏、浏览器栏伸缩） ----
  //
  // 上限随容器形状变：容器变矮后 16:9 窗口占掉的高度比例更大。拖动锁定的上限只能
  // 管住「拖动结束那一刻」的合法性，尺寸变化得由 ResizeObserver 回调补上，否则
  // 竖屏里拖大的侧栏旋转后会把画面压到 16:9 以下、不再履行承诺。
  await gesture([{ dx: 0, dy: -12 }, { dx: 0, dy: -2000 }]);
  await page.waitForTimeout(250);
  const beforeShrink = await read();
  assert(parseFloat(beforeShrink.share) > 60, `收回测试前的占比不够高：${beforeShrink.share}`);
  await page.setViewportSize({ width: VIEWPORT.width, height: 600 });
  await page.waitForTimeout(500);
  const afterShrink = await assertSumHolds("容器变矮后：");
  assert(
    afterShrink.stageHeight >= stageFloor - 0.5,
    `容器变矮后舞台 ${afterShrink.stageHeight}px 放不下满宽 16:9（需 ${stageFloor.toFixed(1)}px）`,
  );
  assert(
    parseFloat(afterShrink.share) < parseFloat(beforeShrink.share),
    `容器变矮后占比没有收回：${beforeShrink.share} → ${afterShrink.share}`,
  );
  results.push(
    `容器 757 → 600px：占比 ${beforeShrink.share} → ${afterShrink.share}（舞台保持 ${afterShrink.stageHeight}px）`,
  );
  // 回到原尺寸继续后面的手势测试；变高不会放宽已提交的占比（只往下收）。
  await page.setViewportSize(VIEWPORT);
  await page.waitForTimeout(500);

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
    Math.abs((afterSwipe.trackOffset ?? 0) + VIEWPORT.width) < 1.5,
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
  await gesture([{ dx: 0, dy: -12 }, { dx: 0, dy: -160 }], { hold: true });
  const midDrag = await read();
  await page.evaluate(() => {
    const video = document.querySelector("video");
    for (let second = 1; second <= 3; second += 1) {
      Object.defineProperty(video, "currentTime", { value: second, configurable: true });
      video.dispatchEvent(new Event("timeupdate"));
    }
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
