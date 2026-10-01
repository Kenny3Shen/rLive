// 离场子树的**路由上下文**冻结回归（`PagePan` / `PageZoom`）。
//
// 失效方式（真机可见）：从 VOD 播放页点返回，退出动画里播放页塌成「缺少有效参数」
// 的错误卡 —— 上一页在过渡期间继续挂载，但路由上下文不是元素的一部分，路由一变
// 它就用新 URL 重渲染，播放页据此把自己判成无效链接。房间页同理（退回发现页时
// 离场层里的直播间整个消失）。
//
// 夹具（`tests/browser/frozen-router.html`）把 location / search / params 三种取值
// 都画进 DOM，并记录每页实例的挂载次数。因此这里同时断言两件事：
//   1. 离场层里的文本仍是**旧**页面的取值；
//   2. 离场页面**没有被重新挂载**（实例号不变）—— 重新挂载会销毁媒体元素与播放器。
//
// 两组路由分别覆盖两个宿主：`/play` ⇄ `/list` 走 `PageZoom`，`/a` ⇄ `/b` 走 `PagePan`。
//
// 用法：
//   playwright-cli -s=frozen-router open http://127.0.0.1:1420/
//   playwright-cli -s=frozen-router run-code --filename=tests/frozen-router.browser.js
async (page) => {
  const FIXTURE = "http://127.0.0.1:1420/tests/browser/frozen-router.html";
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };

  await page.goto(FIXTURE);
  await page.waitForSelector('[data-page="list"]');
  const results = [];

  const layers = () =>
    page.evaluate(() => {
      const scope = document.querySelector('[data-slot="page-zoom"], [data-slot="page-pan"]');
      return {
        transitioning: scope?.dataset.transitioning ?? null,
        text: [...(scope?.children ?? [])].map((child) => child.textContent.trim()),
      };
    });

  /** 等过渡把离场层卸载干净，下一段断言才不会被上一段的两层结构干扰。 */
  const settle = () =>
    page.waitForFunction(
      () =>
        document.querySelectorAll('[data-slot="page-zoom"] > div, [data-slot="page-pan"] > div')
          .length === 1,
      undefined,
      { timeout: 5000 },
    );

  const navigate = (path) =>
    page.evaluate((target) => window.frozenRouterFixture.router.navigate(target), path);

  // ---- PageZoom：进入播放页，按自己的查询参数与路由参数渲染 ----
  await navigate("/play/42?bvid=BV1frozen&cid=1001");
  await page.waitForFunction(() => document.querySelector('[data-page="play"]') !== null);
  await page.waitForTimeout(400);
  const entered = await layers();
  assert(
    entered.text.length === 1 &&
      entered.text[0].includes("bvid=BV1frozen") &&
      entered.text[0].includes("cid=1001"),
    `进入后播放页取值不对：${JSON.stringify(entered.text)}`,
  );
  const playInstance = entered.text[0].match(/play#(\d+)/)?.[1];
  assert(playInstance !== undefined, `播放页没有渲染实例号：${entered.text[0]}`);
  results.push("PageZoom 进入播放页：查询参数与路由参数就位");

  // ---- 返回：离场层必须仍是播放页自己的取值 ----
  await navigate("/list/1");
  await page.waitForFunction(
    () => document.querySelector('[data-slot="page-zoom"]')?.dataset.transitioning === "exit",
  );
  const during = await layers();
  assert(during.text.length === 2, `退出期间离场层没有保留：${JSON.stringify(during.text)}`);
  const [outgoing, incoming] = during.text;
  assert(
    outgoing.includes("bvid=BV1frozen") &&
      outgoing.includes("cid=1001") &&
      outgoing.includes("id=42"),
    `离场层读到了新路由的取值（这正是要回归的失效）：${outgoing}`,
  );
  assert(!outgoing.includes("缺少") && !outgoing.includes("无效"), `离场层塌成了错误态：${outgoing}`);
  assert(
    outgoing.includes(`play#${playInstance}`),
    `离场播放页被重新挂载（${playInstance} → ${outgoing}），媒体元素与播放器实例会一起丢失`,
  );
  assert(incoming.includes("path=/list/1"), `进入层不是列表页：${incoming}`);
  results.push("PageZoom 返回：离场层保留旧页面的 location / search / params，且未重新挂载");

  await settle();
  const after = await layers();
  assert(
    after.text.length === 1 && after.text[0].includes("list#"),
    `离场层没有卸载干净：${JSON.stringify(after.text)}`,
  );
  assert(after.transitioning === null, `过渡标记没有清掉：${after.transitioning}`);
  results.push("PageZoom 过渡结束后离场层卸载、data-transitioning 清空");

  // ---- 连续往返：每次都必须回到「当次页面自己的取值」 ----
  for (let round = 1; round <= 3; round += 1) {
    await navigate(`/play/${round}?bvid=BV${round}&cid=${1000 + round}`);
    await page.waitForFunction(() => document.querySelector('[data-page="play"]') !== null);
    await page.waitForTimeout(200);
    await navigate("/list/1");
    await page.waitForFunction(
      () => document.querySelector('[data-slot="page-zoom"]')?.dataset.transitioning === "exit",
    );
    const roundLayers = await layers();
    const text = roundLayers.text[0] ?? "";
    assert(
      text.includes(`bvid=BV${round}`) && text.includes(`cid=${1000 + round}`),
      `第 ${round} 次往返的离场层取值不对：${text}`,
    );
    await settle();
  }
  results.push("PageZoom 连续三次往返：每次离场层都读到当次页面的取值");

  // ---- PagePan：普通路由之间的平移同样冻结上下文 ----
  await navigate("/a/7?view=live");
  await page.waitForFunction(() => document.querySelector('[data-page="a"]') !== null);
  await page.waitForTimeout(400);
  const panBefore = await layers();
  const aInstance = panBefore.text[0]?.match(/a#(\d+)/)?.[1];
  assert(aInstance !== undefined, `A 页没有渲染实例号：${panBefore.text[0]}`);

  await navigate("/b/9?view=iptv");
  await page.waitForFunction(() => document.querySelectorAll('[data-slot="page-pan"] > div').length === 2);
  const panDuring = await layers();
  assert(panDuring.text.length === 2, `平移期间没有保留离场页：${JSON.stringify(panDuring.text)}`);
  assert(
    panDuring.text[0].includes("view=live") && panDuring.text[0].includes("id=7"),
    `PagePan 离场层读到了新路由的取值：${panDuring.text[0]}`,
  );
  assert(
    panDuring.text[0].includes(`a#${aInstance}`),
    `PagePan 离场页被重新挂载：${aInstance} → ${panDuring.text[0]}`,
  );
  assert(panDuring.text[1].includes("view=iptv"), `平移进入层取值不对：${panDuring.text[1]}`);
  results.push("PagePan 平移：离场层保留旧页面的查询参数与路由参数");

  await settle();
  return { passed: results };
};
