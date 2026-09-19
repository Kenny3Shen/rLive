// Windows 主窗口内挂载真实 ShortsPage；只替换列表/媒体 IPC，不触碰真实账号数据。
// playwright-cli -s=rwin run-code --filename=tests/shorts-uploader.browser.js
async (page) => {
  // WebView2 的 __TAURI_INTERNALS__.invoke 是只读属性。仅在测试网络层替换薄包装，
  // 不篡改原生桥，也不向生产源码添加测试开关。未设置测试函数时仍走真实 IPC。
  const pattern = "**/src/shared/api/tauri.ts*";
  await page.unroute(pattern);
  await page.reload();
  // 请求留在 Windows 浏览器进程：WSL 的 ::1 不是 Windows Vite 的 ::1。
  const source = await page.evaluate(async () => (await fetch("/src/shared/api/tauri.ts")).text());
  const signature = "async function invokeCmd(cmd, args) {";
  if (!source.includes(signature)) throw new Error("IPC 测试注入点已改变");
  const patched = source.replace(signature, `${signature}\n  if (window.__rliveTestInvoke) return window.__rliveTestInvoke(cmd, args);`);
  const route = (request) => request.fulfill({ status: 200, contentType: "application/javascript", body: patched });
  await page.route(pattern, route);
  try {
    await page.goto(`${page.url().match(/^https?:\/\/[^/]+/)[0]}/settings`);
    return await page.evaluate(async () => {
  const { setupHarness, dependencyUrl, frames, until, assert } = await import("/tests/browser/harness.js");
  const { MemoryRouter } = await import(dependencyUrl("react-router-dom"));
  const { QueryClient, QueryClientProvider } = await import(dependencyUrl("@tanstack_react-query"));
  const { ShortsPage } = await import("/src/features/shorts/ShortsPage.tsx");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const harness = await setupHarness({ style: "position:fixed;inset:0;z-index:99999;background:black" });
  const originalInvoke = window.__TAURI_INTERNALS__.invoke;
  const calls = [];
  const makeItem = (index, mid = "42") => ({
    bvid: `BVtest${index}`, aid: String(index), cid: index, title: `测试稿件 ${index}`,
    cover: "", author: "测试作者", author_mid: mid, author_face: null, author_fans: 100,
    duration: 60, view: 1, danmaku: 0, pubdate: 0, rcmd_reason: null,
    dimension: { width: 1080, height: 1920, rotate: 0 }, index,
  });
  const recommendations = [makeItem(900, "99"), makeItem(56), makeItem(901, "99")];
  const initial = { items: [makeItem(56), makeItem(57)], total: 100, prev_cursor: "56", next_cursor: "57" };
  let resolvePrevious;
  let resolveInitial;
  let initialMode = "normal";
  let previousMode = "delay";
  window.__rliveTestInvoke = async (command, args) => {
    calls.push({ command, args });
    if (command === "video_get_story") return { items: recommendations, has_more: false };
    if (command === "video_get_uploader_story") {
      assert(args.mid === "42", "不能进入错误作者");
      if (args.direction === "initial") {
        assert(args.cursorAid === "56", "入口必须使用当前稿件 aid");
        if (initialMode === "error") throw { code: "bilibili_video_error", message: "测试：当前视频暂不可用", retryable: true };
        if (initialMode === "delay") return new Promise((resolve) => { resolveInitial = resolve; });
        return initial;
      }
      if (args.direction === "prev") {
        if (previousMode === "delay") return new Promise((resolve) => { resolvePrevious = resolve; });
        return { items: [], total: 100, prev_cursor: null, next_cursor: null };
      }
      return { items: Array.from({ length: 10 }, (_, i) => makeItem(58 + i)), total: 100, prev_cursor: "58", next_cursor: "67" };
    }
    if (command === "video_get_play_info") throw new Error("浏览器夹具不请求媒体");
    if (command === "video_get_danmaku") return { segment_index: 1, entries: [] };
    if (command === "video_get_comments") return { items: [], has_more: false, next: 0, all_count: 0 };
    if (command === "danmaku_favorite_list" || command === "danmaku_send_history_list") return [];
    if (command.startsWith("video_") || command.startsWith("danmaku_")) return null;
    return originalInvoke(command, args);
  };
  const { h, host } = harness;
  const viewport = () => host.querySelector('[data-slot="shorts-viewport"]');
  const position = () => host.querySelector('[data-slot="shorts-uploader-position"]')?.textContent;
  const activePanel = () => host.querySelector('[data-slot="shorts-panel"]:not([aria-hidden="true"])');
  const click = (selector) => {
    const button = host.querySelector(selector);
    assert(button && !button.disabled, `按钮不可用：${selector}`);
    button.click();
  };
  const idle = async () => {
    await until(() => !host.querySelector('[data-slot="shorts-track"]')?.getAnimations().length, "换片动画未结束");
    await frames();
  };
  try {
    harness.render(h(QueryClientProvider, { client }, h(MemoryRouter, { initialEntries: ["/shorts"] }, h(ShortsPage))));
    await until(() => viewport()?.dataset.currentAid === "900", "推荐首条未出现");
    click('button[aria-label="下一条"]');
    await until(() => viewport()?.dataset.currentAid === "56", "未切到入口稿件");
    await idle();
    const seedVideo = activePanel()?.querySelector("video");
    const seedSlot = activePanel()?.dataset.slotId;
    const playsBefore = calls.filter((c) => c.command === "video_get_play_info" && c.args?.request?.cid === 56).length;
    // 同一入口区域既支持触摸头像，也支持鼠标/键盘点用户名。
    const entry = host.querySelector('[data-slot="shorts-uploader-entry"]');
    const press = { pointerId: 77, pointerType: "touch", isPrimary: true, bubbles: true, clientX: 10, clientY: 10 };
    entry.dispatchEvent(new PointerEvent("pointerdown", press));
    entry.dispatchEvent(new PointerEvent("pointerup", press));
    await frames();
    click('[data-slot="shorts-uploader-entry"]');
    await until(() => position() === "56/100" && resolvePrevious, "作者流没有从56/100进入");
    assert(viewport().dataset.currentAid === "56", "进入作者模式跳走了当前视频");
    assert(activePanel()?.querySelector("video") === seedVideo, "切模式重建了当前媒体元素");
    assert(activePanel()?.dataset.slotId === seedSlot, "切模式丢失原槽位所有权");
    const counter = host.querySelector('[data-slot="shorts-uploader-position"]').getBoundingClientRect();
    const bar = host.querySelector('[data-slot="shorts-top-bar"]').getBoundingClientRect();
    assert(Math.abs(counter.x + counter.width / 2 - bar.x - bar.width / 2) < 2, "位置计数未居中");
    resolvePrevious({ items: Array.from({ length: 10 }, (_, i) => makeItem(46 + i)), total: 100, prev_cursor: "46", next_cursor: "55" });
    await until(() => calls.some((c) => c.command === "video_get_uploader_story" && c.args.direction === "next"), "前插后没有按需补后页");
    await frames();
    assert(position() === "56/100" && viewport().dataset.currentAid === "56", "前插改变了当前身份/计数");
    assert(activePanel()?.querySelector("video") === seedVideo, "前插重建了当前媒体元素");
    const panel = activePanel().getBoundingClientRect();
    assert(Math.abs(panel.y - viewport().getBoundingClientRect().y) < 2, "前插后舞台未重新停靠当前稿件");
    assert(calls.filter((c) => c.command === "video_get_play_info" && c.args?.request?.cid === 56).length === playsBefore, "切源/前插对当前视频重复取流");
    click('button[aria-label="下一条"]');
    await until(() => position() === "57/100", "向后浏览未显示57/100");
    await idle();
    click('button[aria-label="上一条"]');
    await until(() => position() === "56/100", "向前浏览位置不正确");
    await idle();
    click('button[aria-label="返回推荐流"]');
    await until(() => viewport()?.dataset.feedMode === "recommendation", "未返回推荐模式");
    assert(viewport().dataset.currentAid === "56", "返回推荐未恢复进入位置");
    assert(calls.filter((c) => c.command === "video_get_story").length === 1, "返回推荐不应重拉原序列");

    // 退出发生在初始请求完成之前：迟到结果不能把推荐流切回作者流。
    initialMode = "delay";
    click('[data-slot="shorts-uploader-entry"]');
    await until(() => !!resolveInitial, "未发起新的入口请求");
    click('button[aria-label="返回推荐流"]');
    await frames();
    resolveInitial(initial);
    await frames();
    assert(viewport().dataset.feedMode === "recommendation" && viewport().dataset.currentAid === "56", "迟到响应污染返回后的推荐流");

    // 失败不默默换第一条，保留原视频，明确重试后才重新调用。
    initialMode = "error";
    click('[data-slot="shorts-uploader-entry"]');
    await until(() => host.querySelector('[data-slot="shorts-uploader-status"] [role="alert"]'), "失败未显示可重试提示");
    assert(viewport().dataset.currentAid === "56", "入口失败不该切走当前视频");
    assert(host.querySelector('[data-slot="shorts-uploader-status"]').textContent.includes("当前视频暂不可用"), "结构化 IPC 错误应显示 message，不是 [object Object]");
    initialMode = "normal";
    previousMode = "empty";
    click('[data-slot="shorts-uploader-status"] button');
    await until(() => position() === "56/100", "重试未恢复作者流");
    const back = new Event("rlive:android-back", { cancelable: true });
    window.dispatchEvent(back);
    assert(back.defaultPrevented, "作者模式未消费系统 Back");
    await until(() => viewport().dataset.feedMode === "recommendation", "系统 Back 未退回推荐");
    // 轴锁前在视口外抬手，不能永久封锁后续切源。
    viewport().dispatchEvent(new PointerEvent("pointerdown", { ...press, pointerId: 78 }));
    window.dispatchEvent(new PointerEvent("pointerup", { ...press, pointerId: 78 }));
    await frames();
    click('[data-slot="shorts-uploader-entry"]');
    await until(() => position() === "56/100", "视口外抬手导致切源锁死");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await until(() => viewport().dataset.feedMode === "recommendation", "Escape 未退回推荐");
    return { entered: "56/100", next: "57/100", keptMedia: true, prependAnchored: true, restoredRecommendation: true, staleResponseIgnored: true, retryPassed: true };
  } finally {
    harness.dispose();
    client.clear();
    delete window.__rliveTestInvoke;
  }
    });
  } finally {
    await page.unroute(pattern, route);
    await page.reload();
  }
}
