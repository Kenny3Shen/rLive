// 在 Windows 主窗口 / Vite 页面验证真实 VideoCard DOM 的横竖画幅，不请求媒体。
// playwright-cli -s=rwin run-code --filename=tests/video-card-aspect.browser.js
async (page) => {
  return page.evaluate(async () => {
    const { setupHarness, dependencyUrl, frames, assert } = await import("/tests/browser/harness.js");
    const { MemoryRouter } = await import(dependencyUrl("react-router-dom"));
    const { QueryClient, QueryClientProvider } = await import(dependencyUrl("@tanstack_react-query"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { VideoCard, PgcCard } = await import("/src/features/video/VideoCard.tsx");
    const { VideoSidebar } = await import("/src/features/video/VideoSidebar.tsx");
    const harness = await setupHarness({ style: "position:fixed;inset:0;z-index:99999;background:var(--background);overflow:auto;pointer-events:none" });
    const { h, host } = harness;
    const base = { bvid: "BVtest", aid: "1", cid: 1, title: "画幅回归", cover: "", author: "作者", author_face: null,
      duration: 30, view: 0, danmaku: 0, pubdate: 0, rcmd_reason: null };
    const cases = [
      ["横屏", { width: 1920, height: 1080, rotate: 0 }, 16 / 9],
      ["竖屏", { width: 1080, height: 1920, rotate: 0 }, 9 / 16],
      ["旋转", { width: 1920, height: 1080, rotate: 1 }, 9 / 16],
      ["方形", { width: 1080, height: 1080, rotate: 0 }, 1],
      ["未知", null, 16 / 9],
    ];
    const groups = [
      { orientation: "grid", coverAspect: "source" },
      { orientation: "row", coverAspect: "source" },
      { orientation: "grid", coverAspect: "landscape" },
      { orientation: "row", coverAspect: "landscape" },
    ];
    // 空 bvid 禁止真实 IPC，缓存仍可供真实 RelatedPanel 渲染，验证调用点确实传了横屏策略。
    client.setQueryData(["video_related", ""], { items: cases.map(([label, dimension], index) => ({ ...base, bvid: `BVrelated${index}`, title: label, dimension })), has_more: false });
    try {
      const reports = [];
      for (const width of [360, 1200]) {
        harness.render(h(QueryClientProvider, { client }, h(MemoryRouter, null, h("div", { style: { width, display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 8 } },
          ...groups.flatMap(({ orientation, coverAspect }) => cases.map(([label, dimension]) => h(VideoCard, {
            key: `${orientation}:${coverAspect}:${label}`, item: { ...base, title: `${orientation}:${label}`, dimension }, orientation, coverAspect,
          }))), h(PgcCard, { key: "pgc", item: { season_id: "1", title: "PGC", cover: "", badge: null, index_show: null } })))));
        await frames();
        const covers = [...host.querySelectorAll('[data-slot="video-card-cover"]')];
        const expected = [...groups.flatMap(({ coverAspect }) => cases.map(([label, dimension, ratio]) => [label, dimension, coverAspect === "landscape" ? 16 / 9 : ratio])), ["PGC", null, 16 / 9]];
        assert(covers.length === expected.length, "卡片数量错误");
        covers.forEach((cover, index) => {
          const box = cover.getBoundingClientRect();
          const ratio = box.width / box.height;
          assert(Math.abs(ratio - expected[index][2]) < 0.03, `${width}px ${expected[index][0]} 比例错误：${ratio}`);
          const card = cover.closest("button").getBoundingClientRect();
          assert(box.bottom <= card.bottom + 1, "封面溢出卡片");
        });
        reports.push({ width, cards: covers.length, passed: true });
      }
      for (const width of [300, 360, 600]) {
        harness.render(h(QueryClientProvider, { client }, h(MemoryRouter, null, h("div", { style: { width, height: 800 } },
          h(VideoSidebar, { bvid: "", epId: null, aid: null, cid: 0, tab: "related", onTabChange: () => {} })))));
        await frames();
        const related = [...host.querySelectorAll('[data-slot="video-card-cover"]')];
        assert(related.length === cases.length, "真实相关视频区未渲染所有画幅");
        const heights = related.map((cover) => {
          const box = cover.getBoundingClientRect();
          assert(Math.abs(box.width / box.height - 16 / 9) < 0.03, "相关视频未固定为 16:9");
          return cover.closest("button").getBoundingClientRect().height;
        });
        assert(Math.max(...heights) - Math.min(...heights) < 1, "相关视频卡片行高不一致");
        reports.push({ relatedWidth: width, cards: related.length, uniformLandscape: true });
      }
      return reports;
    } finally {
      harness.dispose();
      client.clear();
    }
  });
}
