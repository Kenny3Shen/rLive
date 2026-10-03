// 实际应用路由：先选平台、选择后才请求推荐、返回选择页与旧 seed 深链兼容。
// playwright-cli -s=rwin --raw run-code --filename=tests/shorts-platform-entry.browser.js
// oxlint-disable-next-line no-unused-expressions -- run-code 要求顶层函数表达式。
async (page) => {
  const origin = page.url().match(/^https?:\/\/[^/]+/)[0];
  const pattern = "**/src/shared/api/tauri.ts*";
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const oldViewport = page.viewportSize();
  await page.unroute(pattern);
  await page.goto(`${origin}/settings`);
  const source = await page.evaluate(async () => (await fetch("/src/shared/api/tauri.ts")).text());
  const signature = "async function invokeCmd(cmd, args) {";
  assert(source.includes(signature), "IPC 测试注入点已改变");
  await page.route(pattern, route => route.fulfill({ status: 200, contentType: "application/javascript", body: source.replace(signature, `${signature}
    const calls = window.__shortsEntryCalls ??= { bilibili: [], douyin: 0 };
    if (cmd === "video_get_story") { calls.bilibili.push(args?.seedBvid); return { items: [], has_more: false }; }
    if (cmd === "douyin_video_feed") { calls.douyin++; return { items: [], has_more: false }; }
    if (cmd === "video_get_play_info" || cmd === "douyin_video_resolve") throw new Error("平台入口夹具不取流");
  `) }));
  const calls = () => page.evaluate(() => window.__shortsEntryCalls ?? { bilibili: [], douyin: 0 });
  const hub = async () => {
    await page.waitForSelector('[data-slot="shorts-home"]');
    // 返回时 PageZoom 会短暂保留离场舞台，等过渡卸载后检查资源与外壳。
    await page.waitForFunction(() => !document.querySelector('[data-immersive="true"]'));
    assert(await page.locator('[data-slot="shorts-home"] a').count() === 2, "平台入口数量不是两个");
    assert(await page.locator('[data-immersive="true"]').count() === 0, "平台选择页不应进入沉浸模式");
    assert(await page.locator("video").count() === 0, "平台选择页不应挂载媒体");
    assert(await page.locator('[data-slot="app-header"]').count() === 0, "平台选择页不应显示空白通用头栏");
  };
  try {
    await page.goto(`${origin}/settings`);
    await page.getByRole("link", { name: "短视频", exact: true }).first().click();
    await hub();
    let count = await calls();
    assert(count.bilibili.length === 0 && count.douyin === 0, "选平台之前请求了推荐");
    for (const size of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "选择页横向溢出");
      assert(await page.getByRole("link", { name: "B 站短视频", exact: true }).isVisible(), "B 站入口不可见");
      assert(await page.getByRole("link", { name: "抖音短视频", exact: true }).isVisible(), "抖音入口不可见");
    }
    if (oldViewport) await page.setViewportSize(oldViewport);
    await page.getByRole("link", { name: "B 站短视频", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => location.pathname === "/shorts/bilibili" && window.__shortsEntryCalls?.bilibili.length > 0);
    assert(await page.locator('[data-immersive="true"]').count() === 1, "B 站流未进入沉浸模式");
    count = await calls();
    assert(count.douyin === 0, "B 站入口触发抖音请求");
    const bCount = count.bilibili.length;
    await page.getByRole("button", { name: "返回上一页", exact: true }).click();
    await hub();
    await page.getByRole("link", { name: "抖音短视频", exact: true }).click();
    await page.waitForFunction(() => location.pathname === "/shorts/douyin" && window.__shortsEntryCalls?.douyin > 0);
    assert(await page.locator('[data-immersive="true"]').count() === 1, "抖音流未进入沉浸模式");
    count = await calls();
    assert(count.bilibili.length === bCount, "抖音入口触发 B 站请求");
    await page.getByRole("button", { name: "返回上一页", exact: true }).click();
    await hub();
    // 再次进入依旧先选择，不记忆上一次平台或自动请求推荐。
    const beforeReload = count;
    count = await calls();
    assert(count.bilibili.length === beforeReload.bilibili.length && count.douyin === beforeReload.douyin, "返回选择页自动拉取了推荐");
    await page.reload();
    await hub();
    count = await calls();
    assert(count.bilibili.length === 0 && count.douyin === 0, "刷新选择页自动拉取了推荐");
    await page.goto(`${origin}/shorts?seed=BVfixture&from=legacy`);
    await page.waitForFunction(() => location.pathname === "/shorts/bilibili" && window.__shortsEntryCalls?.bilibili.length > 0);
    count = await calls();
    assert(count.bilibili.every(seed => seed === "BVfixture") && count.douyin === 0, "旧深链丢失种子或请求了错误平台");
    assert(page.url().includes("from=legacy"), "旧深链丢失其他查询参数");
    // 作品链接已移除：旧深链只能落到推荐流，不再有单作品输入。
    await page.goto(`${origin}/shorts/douyin?tab=link`);
    await page.waitForFunction(() => window.__shortsEntryCalls?.douyin > 0);
    assert(await page.locator("#douyin-video-input").count() === 0, "作品链接输入仍存在");
    assert(await page.locator('[data-slot="shorts-viewport"]').count() === 1, "旧链接深链未进入推荐流");
    await page.getByRole("button", { name: "返回上一页", exact: true }).click();
    await hub();
    return { passed: true, selectionMakesNoFeedCalls: true, platformsIsolated: true, backToSelection: true, legacySeedPreserved: true, linkDeepLinkFallsBackToFeed: true };
  } finally {
    if (oldViewport) await page.setViewportSize(oldViewport);
    await page.goto(`${origin}/settings`);
    await page.unroute(pattern);
    await page.reload();
  }
}
