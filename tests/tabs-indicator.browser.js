// Tabs（`variant="line"`）的指示条必须画在页签自己那一行里，不能越过页签条落到外面。
//
// 回归的是真机截图里看到的现象：401px 宽的 Android 上，视频侧栏选中的「相关视频」
// 下面那条白线画在页签栏**下方**、悬在内容区上。根因是两段高度不一致 ——
// `TabsList` 带 3px 纵向内边距，页签按 `h-[calc(100%-1px)]` 比它矮 4px，而窄屏
// `max-md:min-h-11` 又把页签撑满 44px；指示条用相对页签的 `bottom:-5px` 定位，
// 同一份偏移在两种页签高度下不可能都对齐：桌面 37px 页签恰好压在底边框上，
// 窄屏 44px 页签就整条越界到页签条外（实测越界 3.5px）。
//
// 断言盯「绘制出来的像素」：页签条的边界由布局给出（那是判定的基准，不是被测对象），
// 指示条则必须在截图里找出来。类名怎么改都不会让断言失真，只要白线真的画进页签条里。
//
// 先启动 vite（`bun run dev`）并打开任意页面，再执行：
//   playwright-cli -s=tabs-indicator open http://127.0.0.1:1420/
//   playwright-cli -s=tabs-indicator run-code --filename=tests/tabs-indicator.browser.js
async (page) => {
  // 401 与用户截图同宽；1280 是桌面侧栏（320/340 宽）那一档的既有画法，一起守住。
  const WIDTHS = [401, 1280];
  // 深色主题下 `--foreground` 是近白色（约 240），页签条的边框只有约 40 —— 亮度阈值
  // 因此能把指示条与边框分开，不需要为浅色主题再调一套。
  const BRIGHT = 150;

  /**
   * 解码截图并统计每一行的亮像素数。
   *
   * 交给浏览器解码，避免在 Node 侧引入图像库依赖；`page.screenshot` 返回 Buffer，
   * 经 base64 传进页面即可。
   */
  const brightRows = async (clip) => {
    const buffer = await page.screenshot({ clip });
    return await page.evaluate(
      async ({ base64, threshold }) => {
        const bitmap = await createImageBitmap(
          await (await fetch(`data:image/png;base64,${base64}`)).blob(),
        );
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d");
        context.drawImage(bitmap, 0, 0);
        const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
        const rows = [];
        for (let y = 0; y < bitmap.height; y += 1) {
          let bright = 0;
          for (let x = 0; x < bitmap.width; x += 1) {
            const offset = (y * bitmap.width + x) * 4;
            if (data[offset] > threshold && data[offset + 1] > threshold) bright += 1;
          }
          rows.push(bright);
        }
        return { width: bitmap.width, height: bitmap.height, rows };
      },
      { base64: buffer.toString("base64"), threshold: BRIGHT },
    );
  };

  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };

  const results = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 700 });
    await page.goto("http://127.0.0.1:1420/");
    await page.waitForFunction(() =>
      performance
        .getEntriesByType("resource")
        .some((item) => new URL(item.name).pathname.endsWith("/deps/react-dom_client.js")),
    );

    // 视频侧栏是三个 h-11 调用点里几何最完整的（页签条自带 border-b），且用户截图
    // 正是它；录制回放侧栏、直播间侧栏与快捷弹幕共用同一套 TabsList / TabsTrigger，
    // 几何由本夹具覆盖。
    const geometry = await page.evaluate(async () => {
      const { setupHarness, frames, dependencyUrl } = await import("/tests/browser/harness.js");
      const { QueryClient, QueryClientProvider } = await import(
        dependencyUrl("@tanstack_react-query")
      );
      const { MemoryRouter } = await import(dependencyUrl("react-router-dom"));
      // 带查询参数绕过模块缓存，每次运行都取当前源码。
      const { VideoSidebar } = await import(
        `/src/features/video/VideoSidebar.tsx?tabs-indicator=${Date.now()}`
      );
      // 深色主题下指示条与页签条边框的亮度差足够做像素判定。
      const wasDark = document.documentElement.classList.contains("dark");
      document.documentElement.classList.add("dark");
      const ui = await setupHarness({
        strict: false,
        style:
          "position:fixed;left:0;top:0;width:100%;height:420px;z-index:1000;background:var(--sidebar)",
      });
      const { React, h } = ui;
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      ui.render(
        h(
          QueryClientProvider,
          { client },
          h(
            MemoryRouter,
            null,
            h(VideoSidebar, {
              bvid: "BVindicator",
              epId: null,
              aid: "1",
              cid: 1,
              tab: "related",
              onTabChange: () => {},
              danmaku: { entries: [], positionMs: 0, loading: false, onSeek: () => {} },
            }),
          ),
        ),
      );
      await frames();
      await frames();
      window.__ui = ui;

      const list = ui.query('[data-slot="tabs-list"]');
      const trigger = ui.query('[data-slot="tabs-trigger"]');
      const bar = list.parentElement;
      const triggerRect = trigger.getBoundingClientRect();
      const barRect = bar.getBoundingClientRect();
      return {
        viewportWidth: window.innerWidth,
        wasDark,
        bar: {
          top: barRect.top,
          bottom: barRect.bottom,
          borderBottom: parseFloat(getComputedStyle(bar).borderBottomWidth),
        },
        trigger: {
          top: triggerRect.top,
          bottom: triggerRect.bottom,
          height: triggerRect.height,
        },
        // 采样列取第一个页签左右各留 8px 的内侧区间：避开圆角、相邻页签与容器边距。
        sampleX: { left: triggerRect.left + 8, right: triggerRect.right - 8 },
      };
    });

    const clipHeight = Math.ceil(geometry.bar.bottom - geometry.bar.top) + 6;
    const shot = await brightRows({
      x: Math.floor(geometry.sampleX.left),
      y: Math.floor(geometry.bar.top),
      width: Math.max(1, Math.ceil(geometry.sampleX.right - geometry.sampleX.left)),
      height: clipHeight,
    });
    // 截图坐标 → 视口坐标。
    const clipTop = Math.floor(geometry.bar.top);
    const barBottomInClip = Math.ceil(geometry.bar.bottom) - clipTop;

    // 指示条横贯采样列（h-0.5 = 2px、inset-x-0），文字只占中间一小段：
    // 用 80% 覆盖率把两者分开。
    const indicatorRows = [];
    for (let y = 0; y < shot.height; y += 1) {
      if (shot.rows[y] >= shot.width * 0.8) indicatorRows.push(y);
    }
    assert(
      indicatorRows.length >= 1,
      `${width}px：采样列里没有找到指示条，选中态没有绘制`,
    );
    const indicatorTop = indicatorRows[0];
    const indicatorBottom = indicatorRows[indicatorRows.length - 1];

    // 页签文字仍要在指示条上方：文字行是「有亮像素但不满宽」的那些。
    const textRows = [];
    for (let y = 0; y < indicatorTop; y += 1) {
      if (shot.rows[y] > 0 && shot.rows[y] < shot.width * 0.8) textRows.push(y);
    }
    assert(textRows.length > 0, `${width}px：指示条上方没有找到页签文字，采样列取错了`);

    // 核心断言：指示条整体落在页签条内部，底边不越过页签条的底边。
    // 页签条带 1px 底边框，指示条压在边框上是既有画法（与头部页签条一致），
    // 因此允许覆盖边框，但不允许越出页签条。
    assert(
      indicatorBottom < barBottomInClip,
      `${width}px：指示条越出页签条 —— 指示条行 ${indicatorTop}-${indicatorBottom}，` +
        `页签条底边在行 ${barBottomInClip}（含 ${geometry.bar.borderBottom}px 边框）`,
    );
    // 反向失效：偏移改过头会让白线浮到页签中部，离底边太远。
    const distanceToBarBottom = barBottomInClip - indicatorBottom;
    assert(
      distanceToBarBottom <= 3,
      `${width}px：指示条离页签条底边 ${distanceToBarBottom}px，没有贴住页签底边`,
    );
    // 白线要贴页签自己的底边，而不是贴页签条：页签撑满页签条时两者重合。
    assert(
      Math.abs(geometry.trigger.bottom - geometry.bar.bottom) <= 1,
      `${width}px：页签没有撑满页签条（页签底 ${geometry.trigger.bottom}，` +
        `页签条底 ${geometry.bar.bottom}），指示条无法贴住页签底边`,
    );

    results.push(
      `${width}px：页签高 ${geometry.trigger.height}px、指示条行 ${indicatorTop}-${indicatorBottom}，` +
        `距页签条底边 ${distanceToBarBottom}px（文字行 ${textRows.length} 行在其上方）`,
    );

    await page.evaluate((restoreLight) => {
      if (restoreLight) document.documentElement.classList.remove("dark");
      window.__ui?.dispose();
    }, !geometry.wasDark);
  }

  return { passed: results };
}
