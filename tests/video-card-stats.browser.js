// 在 Windows 主窗口 / Vite 页面验证真实 VideoCard 的封面角标排布，不请求媒体。
// playwright-cli -s=rwin run-code --filename=tests/video-card-stats.browser.js
//
// 契约：网格卡的播放/弹幕与时长同在封面底排（统计靠左、时长靠右），三者都是
// **无底色**的白字投影（不是 `bg-black/65` 药丸），播放与弹幕之间只用间距分隔、
// 不插竖线；文本块不再有统计行。行式卡的缩略图只有 2/5 列宽放不下这一排，
// 统计仍留在文本块第三行，时长同样无底色。
// 断言的是渲染后的计算样式与几何关系，而不是类名字符串：把底色加回来、
// 换掉 justify-between、或把统计放回文本块，这里都会失败。
async (page) => {
  // 夹具可能在别的路由上被调用（主窗口会被用户切走）。Vite 依赖一旦加载过就一直在
  // `performance` 里，因此这里只补一次导航，避免测试因“不在 /video”而假失败。
  const ready = () =>
    performance.getEntriesByType("resource").some((r) => r.name.includes("/deps/react-router-dom"));
  if (!(await page.evaluate(ready))) {
    await page.goto("http://localhost:1420/video", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(ready, null, { timeout: 30000 });
  }
  return page.evaluate(async () => {
    const { setupHarness, dependencyUrl, frames, assert } = await import("/tests/browser/harness.js");
    const { MemoryRouter } = await import(dependencyUrl("react-router-dom"));
    const { QueryClient, QueryClientProvider } = await import(dependencyUrl("@tanstack_react-query"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { VideoCard } = await import("/src/features/video/VideoCard.tsx");
    const harness = await setupHarness({
      style: "position:fixed;inset:0;z-index:99999;background:var(--background);overflow:auto;pointer-events:none",
    });
    const { h, host } = harness;
    const base = {
      bvid: "", aid: "1", cid: 1, title: "统计角标", cover: "", author: "作者", author_face: null,
      duration: 3723, view: 123456, danmaku: 4567, pubdate: 1735689600, rcmd_reason: null,
    };
    // 封面上承载事实数字的元素：时长、以及含播放/弹幕的那一个统计容器。
    // 用文本形状匹配而不是类名，避免把「怎么画」写成断言。
    const metrics = (cover) =>
      [...cover.querySelectorAll("span")]
        .filter((el) => {
          const text = el.textContent?.trim() ?? "";
          return text === "1:02:03" || (text.includes("12.3万") && text.includes("4.6k"));
        })
        .map((el) => ({ el, text: el.textContent?.trim() ?? "", box: el.getBoundingClientRect() }));
    // 透明底的判据：背景色 alpha 为 0（`rgba(0,0,0,0)` / `transparent`）。
    const backgroundAlpha = (el) => {
      const color = getComputedStyle(el).backgroundColor;
      if (color === "transparent") return 0;
      const match = color.match(/rgba?\(([^)]+)\)/);
      if (!match) return 0;
      const parts = match[1].split(",").map((part) => Number(part.trim()));
      return parts.length === 4 ? parts[3] : 1;
    };
    try {
      const reports = [];
      // 覆盖最窄（xl 六列 ≈ 184px）到较宽的卡片，几何关系不应随宽度改变。
      for (const width of [150, 184, 300]) {
        harness.render(
          h(QueryClientProvider, { client }, h(MemoryRouter, null,
            h("div", { style: { width, display: "grid" } },
              h(VideoCard, { key: "grid", item: { ...base, title: "网格卡" } }),
              h(VideoCard, { key: "row", item: { ...base, title: "行式卡" }, orientation: "row" })))),
        );
        await frames();
        const covers = [...host.querySelectorAll('[data-slot="video-card-cover"]')];
        assert(covers.length === 2, "卡片数量错误");
        const [gridCover, rowCover] = covers;
        const coverBox = gridCover.getBoundingClientRect();
        const gridMetrics = metrics(gridCover);
        const stats = gridMetrics.find((metric) => metric.text.includes("12.3万"));
        const duration = gridMetrics.find((metric) => metric.text === "1:02:03");
        assert(stats, `${width}px 网格卡封面缺少播放/弹幕统计`);
        assert(duration, `${width}px 网格卡封面缺少时长角标`);

        // 1. 无底色：两个角标都不能带实心背景；无底色就必须有投影，
        //    否则浅色封面上白字读不出来。
        for (const [label, metric] of [["统计", stats], ["时长", duration]]) {
          assert(
            backgroundAlpha(metric.el) === 0,
            `${width}px ${label}角标仍有底色：${getComputedStyle(metric.el).backgroundColor}`,
          );
          const shadow = getComputedStyle(metric.el).textShadow;
          assert(shadow && shadow !== "none", `${width}px ${label}角标缺少投影`);
        }

        // 2. 播放与弹幕之间不插竖线，靠间距分开。
        assert(!stats.text.includes("|"), `${width}px 统计里仍有竖线分隔符：${stats.text}`);
        // 只取叶子节点：数字外层还套着图标行与截断行，都带同一个文本。
        const numbers = [...stats.el.querySelectorAll("span")]
          .filter((el) => el.children.length === 0)
          .filter((el) => ["12.3万", "4.6k"].includes(el.textContent?.trim() ?? ""))
          .map((el) => el.getBoundingClientRect());
        assert(numbers.length === 2, `${width}px 未找到两个统计数字`);
        assert(
          numbers[1].left - numbers[0].right >= 2,
          `${width}px 播放与弹幕之间没有间距（${(numbers[1].left - numbers[0].right).toFixed(1)}px）`,
        );

        // 3. 统计靠左、时长靠右，且同一排（垂直中心相差不超过 2px）。
        assert(stats.box.left - coverBox.left < coverBox.width / 2, `${width}px 统计未靠封面左侧`);
        assert(coverBox.right - duration.box.right < coverBox.width / 2, `${width}px 时长未靠封面右侧`);
        assert(duration.box.left >= stats.box.right, `${width}px 统计与时长重叠`);
        const statsMid = stats.box.top + stats.box.height / 2;
        const durationMid = duration.box.top + duration.box.height / 2;
        assert(
          Math.abs(statsMid - durationMid) < 2,
          `${width}px 统计与时长不在同一排（中心差 ${Math.abs(statsMid - durationMid).toFixed(1)}px）`,
        );

        // 4. 统计与时长都必须完整落在封面内（不溢出、不被裁切）。
        for (const [label, metric] of [["统计", stats], ["时长", duration]]) {
          assert(
            metric.box.left >= coverBox.left - 0.5 && metric.box.right <= coverBox.right + 0.5,
            `${width}px ${label}角标水平溢出封面`,
          );
          assert(
            metric.box.top >= coverBox.top - 0.5 && metric.box.bottom <= coverBox.bottom + 0.5,
            `${width}px ${label}角标垂直溢出封面`,
          );
          assert(
            metric.el.scrollWidth <= metric.el.clientWidth + 1,
            `${width}px ${label}角标被截断`,
          );
        }

        // 5. 文本块不再有统计行：只剩标题与日期/UP 主两行。
        const gridText = gridCover.closest("button").querySelector("div[class*=flex-col]");
        const gridLines = [...gridText.children].map((el) => el.textContent?.trim() ?? "");
        assert(gridLines.length === 2, `${width}px 网格卡文本块应为两行，实际 ${gridLines.length} 行`);
        assert(
          !gridLines.some((line) => line.includes("12.3万")),
          `${width}px 网格卡文本块仍渲染统计`,
        );

        // 6. 行式卡：封面只有无底色时长，统计仍在文本块第三行。
        const rowMetrics = metrics(rowCover);
        assert(
          !rowMetrics.some((metric) => metric.text.includes("12.3万")),
          `${width}px 行式卡封面不应有统计`,
        );
        const rowDuration = rowMetrics.find((metric) => metric.text === "1:02:03");
        assert(rowDuration, `${width}px 行式卡封面缺少时长`);
        assert(backgroundAlpha(rowDuration.el) === 0, `${width}px 行式卡时长仍有底色`);
        const rowText = rowCover.closest("button").querySelector("div[class*=flex-col]");
        const rowLines = [...rowText.children].map((el) => el.textContent?.trim() ?? "");
        assert(rowLines.length === 3, `${width}px 行式卡文本块应为三行，实际 ${rowLines.length} 行`);
        assert(
          rowLines[2].includes("12.3万") && rowLines[2].includes("4.6k"),
          `${width}px 行式卡统计未留在文本块第三行`,
        );

        reports.push({ width, gridLines: gridLines.length, rowLines: rowLines.length, passed: true });
      }
      return reports;
    } finally {
      harness.dispose();
      client.clear();
    }
  });
}
