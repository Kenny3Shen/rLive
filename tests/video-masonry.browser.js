// 在 Windows 主窗口验证真实 VideoGrid 的布局、追加稳定性与响应式重排。
// playwright-cli -s=rwin run-code --filename=tests/video-masonry.browser.js
async (page) => {
  if (page.viewportSize() !== null) throw new Error("请使用项目 CDP 配置 viewport: null 重新连接主窗口，不能留下固定视口");
  // 不用 page.setViewportSize：它留下固定设备视口，恢复旧数字仍会锁住主窗口，
  // 导致用户之后拖动原生窗口时卡片不再跟随宽度。测试专用 CDP 会话必须清理模拟。
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await page.waitForFunction(() => performance.getEntriesByType("resource").some((r) => r.name.includes("/deps/react-router-dom.js?v=")));
    await page.evaluate(async () => {
      const { setupHarness, dependencyUrl } = await import("/tests/browser/harness.js");
      const { MemoryRouter } = await import(dependencyUrl("react-router-dom"));
      const { QueryClient, QueryClientProvider } = await import(dependencyUrl("@tanstack_react-query"));
      const { VideoGrid } = await import("/src/features/video/VideoCard.tsx");
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const harness = await setupHarness({ style: "position:fixed;inset:0;z-index:99999;overflow:auto;background:var(--background);pointer-events:none" });
      const dimensions = [[1080,1920], [1920,1080], [2560,1080], [1080,1080], [1440,1080], null];
      const items = Array.from({ length: 30 }, (_, index) => {
        const dim = dimensions[index % dimensions.length];
        return { bvid: `BVmasonry${index}`, aid: String(index + 1), cid: index + 1, title: `瀑布流稿件 ${index + 1}：横竖内容混排`,
          cover: "", author: "布局回归", author_face: null, duration: 30, view: 100, danmaku: 1, pubdate: 0, rcmd_reason: null,
          dimension: dim ? { width: dim[0], height: dim[1], rotate: 0 } : null };
      });
      const render = (count) => harness.render(harness.h(QueryClientProvider, { client }, harness.h(MemoryRouter, null,
        harness.h("div", { style: { padding: 12 } }, harness.h(VideoGrid, { items: items.slice(0, count) }),
          harness.h("div", { "data-slot": "fixture-sentinel", style: { height: 44 } }, "加载更多")))));
      window.__masonryFixture = { harness, client, render };
    });
    const reports = [];
    const deviceScaleFactor = await page.evaluate(() => devicePixelRatio);
    // 先缩小再放大，最后在相同列数下调宽，覆盖旧用例只有逐步放大的盲点。
    for (const width of [1400, 900, 360, 900, 1400, 1320]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor, mobile: false });
      reports.push(await page.evaluate(async ({ width }) => {
        const { frames, until, assert } = await import("/tests/browser/harness.js");
        const { harness, render } = window.__masonryFixture;
        const root = () => harness.host.querySelector('[data-slot="video-masonry"]');
        const cards = () => [...root().querySelectorAll("button[data-page-scroll-anchor]")];
        const rectangles = () => cards().map((card) => card.getBoundingClientRect());
        const checkLayout = () => {
          const rects = rectangles();
          const box = root().getBoundingClientRect();
          for (let i = 0; i < rects.length; i++) {
            const rect = rects[i];
            assert(rect.width > 0 && rect.height > 0, "卡片没有自然尺寸");
            assert(rect.left >= box.left - 1 && rect.right <= box.right + 1, "卡片横向溢出");
            assert(rect.bottom <= box.bottom + 1, "瀑布流容器未包住最高列");
            if (i) assert(rect.top >= rects[i - 1].top - 1, "视觉顺序逆于 DOM 顺序");
            for (let j = 0; j < i; j++) {
              const previous = rects[j];
              if (Math.abs(rect.left - previous.left) < 1) {
                assert(rect.top >= previous.bottom + 15, "同列卡片重叠或间距不足");
              }
            }
          }
          const sentinel = harness.host.querySelector('[data-slot="fixture-sentinel"]').getBoundingClientRect();
          assert(sentinel.top >= Math.max(...rects.map((r) => r.bottom)), "分页哨兵落入列表中间");
          return rects;
        };
        // 后续轮次只改变视口，不先提交新的 children，单独验证宽度观察生效。
        await frames();
        if (root()) checkLayout();
        render(13);
        await until(() => cards().length === 13 && [...root().children].every((el) => el.style.gridRowEnd.startsWith("span ")), "首次测量未完成");
        await frames();
        const before = checkLayout();
        const columns = getComputedStyle(root()).gridTemplateColumns.split(" ").length;
        assert(columns === (width < 640 ? 2 : width < 1024 ? 4 : 6), "响应式列数改变");
        const firstRowBottom = Math.max(...before.slice(0, columns).map((r) => r.bottom));
        assert(before.slice(columns).some((r) => r.top < firstRowBottom - 10), "仍按最高卡片对齐整行，没有瀑布流补位");
        const nodes = cards();
        nodes[3].focus({ preventScroll: true });
        render(30);
        await until(() => cards().length === 30, "分页追加失败");
        await frames();
        const after = checkLayout();
        before.forEach((rect, index) => {
          assert(cards()[index] === nodes[index], "追加重挂载了已有卡片");
          assert(Math.abs(after[index].top - rect.top) < 1 && Math.abs(after[index].left - rect.left) < 1, "追加重新打散了已有卡片");
        });
        assert(document.activeElement === nodes[3], "追加丢失键盘焦点");

        // 字体/文本自然高度变化，不依赖窗口 resize 也应重新分配跨度。
        const firstItem = root().firstElementChild;
        const oldSpan = firstItem.style.gridRowEnd;
        const title = cards()[0].querySelector("p");
        title.style.fontSize = "32px";
        await until(() => firstItem.style.gridRowEnd !== oldSpan, "内容增高未触发重排");
        await frames();
        checkLayout();
        title.style.fontSize = "";
        await until(() => firstItem.style.gridRowEnd === oldSpan, "内容恢复未重排");
        await frames();
        checkLayout();
        return { width, columns, cards: 30, packed: true, appendStable: true, resizeObserved: true };
      }, { width }));
    }
    return reports;
  } finally {
    try {
      await page.evaluate(() => {
        window.__masonryFixture?.harness.dispose();
        window.__masonryFixture?.client.clear();
        delete window.__masonryFixture;
      });
    } finally {
      await cdp.send("Emulation.clearDeviceMetricsOverride");
      await cdp.detach();
      await page.evaluate(async () => {
        if (!window.__TAURI_INTERNALS__) return;
        const { frames, assert } = await import("/tests/browser/harness.js");
        const { getCurrentWindow } = await import("/node_modules/@tauri-apps/api/window.js");
        await frames();
        const win = getCurrentWindow();
        const [size, scale] = await Promise.all([win.innerSize(), win.scaleFactor()]);
        assert(Math.abs(innerWidth - size.width / scale) <= 1 && Math.abs(innerHeight - size.height / scale) <= 1,
          "测试结束后仍锁定模拟视口：网页尺寸必须恢复为原生窗口客户区尺寸");
      });
    }
  }
}
