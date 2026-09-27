// 首次加载只显示返回和加载提示，不闪现跨平台入口；错误/空态与正常菜单仍可进入抖音。
// playwright-cli -s=rwin --raw run-code --filename=tests/shorts-loading-entry.browser.js
// oxlint-disable-next-line no-unused-expressions -- run-code 要求顶层函数表达式。
async (page) => {
  const origin = page.url().match(/^https?:\/\/[^/]+/)[0];
  const pattern = "**/src/shared/api/tauri.ts*";
  await page.unroute(pattern);
  await page.goto(`${origin}/settings`);
  const source = await page.evaluate(async () => (await fetch("/src/shared/api/tauri.ts")).text());
  const signature = "async function invokeCmd(cmd, args) {";
  if (!source.includes(signature)) throw new Error("IPC 测试注入点已改变");
  await page.route(pattern, route => route.fulfill({ status: 200, contentType: "application/javascript", body: source.replace(signature, `${signature}\nif(window.__shortsLoadingInvoke) return window.__shortsLoadingInvoke(cmd,args);`) }));
  try {
    await page.goto(`${origin}/settings`);
    return await page.evaluate(async () => {
      const { setupHarness, dependencyUrl, until, frames, assert } = await import("/tests/browser/harness.js");
      const { QueryClient, QueryClientProvider } = await import(dependencyUrl("@tanstack_react-query"));
      const { MemoryRouter } = await import(dependencyUrl("react-router-dom"));
      const { ShortsPage } = await import("/src/features/shorts/ShortsPage.tsx");
      const harness = await setupHarness({ strict: false, style: "position:fixed;inset:0;z-index:9999;" });
      const original = window.__TAURI_INTERNALS__.invoke;
      const previous = window.__shortsLoadingInvoke;
      let mode = "pending";
      let finishFeed;
      let client;
      const items = Array.from({ length: 6 }, (_, i) => ({
        aid: String(i + 1), bvid: `BVfixture${i + 1}`, cid: i + 1, title: "加载入口夹具",
        author: "测试作者", cover: "", duration: 10, view: 0, danmaku: 0, pubdate: 0,
      }));
      window.__shortsLoadingInvoke = async (cmd, args) => {
        if (cmd === "video_get_story") {
          if (mode === "pending") return new Promise(resolve => { finishFeed = resolve; });
          if (mode === "error") throw new Error("夹具推荐不可用");
          return { items: mode === "ready" ? items : [], has_more: false };
        }
        if (cmd === "video_get_play_info") throw new Error("夹具不访问媒体");
        if (cmd === "video_get_danmaku") return { segment_index: 0, entries: [] };
        if (cmd.startsWith("douyin_video_")) throw new Error("夹具禁止请求真实抖音");
        return original(cmd, args);
      };
      const mount = async (next) => {
        harness.render(null);
        client?.clear();
        finishFeed?.({ items: [], has_more: false });
        finishFeed = undefined;
        mode = next;
        client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        harness.render(harness.h(QueryClientProvider, { client }, harness.h(MemoryRouter, { initialEntries: ["/shorts/bilibili"] }, harness.h(ShortsPage))));
        await frames();
      };
      const platformEntry = () => harness.host.querySelector('a[href="/shorts/douyin"]');
      try {
        await mount("pending");
        await until(() => !!finishFeed, "首屏没有开始加载");
        assert(harness.host.textContent.includes("正在加载短视频"), "加载提示缺失");
        assert(harness.host.querySelector('button[aria-label="返回上一页"]'), "加载时返回按钮缺失");
        assert(!platformEntry() && !harness.host.textContent.includes("抖音推荐"), "首次加载闪现抖音推荐按钮");
        await mount("empty");
        await until(() => harness.host.textContent.includes("暂时没有短视频"), "空态未出现");
        assert(platformEntry(), "空态丢失抖音备用入口");
        await mount("error");
        await until(() => harness.host.textContent.includes("夹具推荐不可用"), "错误态未出现");
        assert(platformEntry(), "错误态丢失抖音备用入口");
        await mount("ready");
        await until(() => !!harness.host.querySelector('[data-slot="shorts-top-bar"]'), "正常舞台未出现");
        assert(!platformEntry(), "正常舞台多出悬浮抖音入口");
        harness.host.querySelector('button[aria-label="更多操作"]').click();
        await until(() => [...document.querySelectorAll("button")].some(el => el.textContent.trim() === "抖音推荐"), "更多操作中丢失抖音推荐入口");
        return { passed: true, loadingHasOnlyBack: true, fallbackEntriesKept: true, menuEntryKept: true };
      } finally {
        harness.dispose();
        finishFeed?.({ items: [], has_more: false });
        client?.clear();
        await frames();
        if (previous === undefined) delete window.__shortsLoadingInvoke;
        else window.__shortsLoadingInvoke = previous;
      }
    });
  } finally {
    await page.unroute(pattern);
    await page.reload();
  }
}
