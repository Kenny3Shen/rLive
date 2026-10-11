// bun run dev 后：playwright-cli run-code --filename=tests/video-next-preload.browser.js
//
// 「预加载下一分集只在当前集最后一个分片进缓冲之后」的回归。
//
// 桩只替换 DASH 引擎与 IPC：`buffered` 末端由 `engine.bufferUpTo()` 手动推进，
// 并派发 `progress`（MSE 每次 appendBuffer 之后的真实信号），因此闸门的开合时刻
// 是可断言的，而不是靠真实网络碰运气。
async (page) => {
  const origin = await page.evaluate(() => location.origin);
  const engine = `
    export class DashAdapter extends EventTarget {
      handlers = new Map();
      engine = {
        on: (name, fn) => {
          const list = this.handlers.get(name) || new Set();
          list.add(fn); this.handlers.set(name, list);
        },
        off: (name, fn) => this.handlers.get(name)?.delete(fn),
      };
      attach(media) {
        this.media = media;
        let time = 0, paused = true;
        // 缓冲末端：夹具手动推进，模拟 MSE 逐片 append 的过程。
        let bufferEnd = 0;
        Object.defineProperties(media, {
          currentTime: { configurable: true, get: () => time, set: value => {
            time = value; media.dispatchEvent(new Event('seeking'));
            media.dispatchEvent(new Event('seeked'));
          } },
          duration: { configurable: true, get: () => 10 },
          paused: { configurable: true, get: () => paused },
          ended: { configurable: true, get: () => false },
          readyState: { configurable: true, get: () => 4 },
          buffered: { configurable: true, get: () => bufferEnd > 0
            ? { length: 1, start: () => 0, end: () => bufferEnd }
            : { length: 0, start: () => { throw new RangeError('IndexSizeError'); }, end: () => { throw new RangeError('IndexSizeError'); } } },
        });
        media.play = async () => {
          paused = false; media.dispatchEvent(new Event('play'));
          media.dispatchEvent(new Event('playing'));
        };
        media.pause = () => { paused = true; media.dispatchEvent(new Event('pause')); };
        media.load = () => {};
        // 推进缓冲末端并按真实 MSE 语义派发 progress（每个 appendBuffer 之后）。
        this.bufferUpTo = (seconds) => {
          bufferEnd = seconds;
          media.dispatchEvent(new Event('progress'));
        };
        window.nextPreloadEngine = this;
      }
      set source(value) {
        if (!value) return;
        queueMicrotask(() => {
          this.media.dispatchEvent(new Event('loadedmetadata'));
          this.media.dispatchEvent(new Event('canplay'));
        });
      }
      destroy() { this.handlers.clear(); }
    }
  `;
  // 引擎按 Vite 预打包 URL 加载（带版本查询串），因此按模块名匹配而不是精确路径。
  const enginePattern = /@videojs_dash-video\.js/;
  const fixtureUrl = `${origin}/tests/browser/video-next-preload.html`;
  await page.route(enginePattern, (route) =>
    route.fulfill({ body: engine, contentType: "application/javascript" }),
  );
  const passed = [];
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const calls = () => page.evaluate(() => window.nextPreloadCalls.length);
  const open = async () => {
    await page.goto(fixtureUrl);
    await page.waitForFunction(
      () => window.nextPreloadEngine && !window.nextPreloadEngine.media.paused,
    );
    // 选集（稿件详情）晚于播放器就位：等它落定，闸门打开时才存在可预热的目标。
    // 标题行右侧报的是当前 P 的位置（`1/2`）而不是总数，见 `videoSelectionCount`。
    await page.waitForFunction(() => {
      const card = document.querySelector('[data-slot="video-selection-card"]');
      return card?.querySelector("h3 button")?.textContent.includes("1/2") ?? false;
    });
  };
  try {
    await open();

    // 起播只缓冲了开头：末片没到，不该动下一集。
    await page.evaluate(() => window.nextPreloadEngine.bufferUpTo(4));
    await page.waitForTimeout(300);
    assert((await calls()) === 0, "末片未进缓冲时就发起了下一分集预加载");

    // 倒数第二片仍不是末片。
    await page.evaluate(() => window.nextPreloadEngine.bufferUpTo(9.5));
    await page.waitForTimeout(300);
    assert((await calls()) === 0, "倒数第二片就被当成了末片");
    passed.push("末片进缓冲之前不预加载下一集");

    // 末片就位：闸门打开，且只开一次。
    await page.evaluate(() => window.nextPreloadEngine.bufferUpTo(10));
    await page.waitForFunction(() => window.nextPreloadCalls.length === 1);
    const payload = await page.evaluate(() => window.nextPreloadCalls[0].request);
    assert(payload.cid === 124, `预加载的不是下一集：${JSON.stringify(payload)}`);
    assert(payload.bvid === "BV1preload2", `预加载缺 bvid：${JSON.stringify(payload)}`);
    passed.push("末片进缓冲后按下一集身份发起预加载");

    // 继续播放（更多 progress）不该重复预热同一集。
    await page.evaluate(() => {
      window.nextPreloadEngine.media.currentTime = 9;
      window.nextPreloadEngine.bufferUpTo(10);
    });
    await page.waitForTimeout(500);
    assert((await calls()) === 1, "同一集被重复预热");
    passed.push("同一集只预热一次");

    // 换集后闸门必须重新关闭。cid=124 已是最后一集（没有下一集目标），因此换成
    // 先切到 P2、再推进缓冲：若闸门没跟着身份重置，旧会话的末片判定会放行。
    await page.evaluate(() => {
      window.nextPreloadFixture.router.navigate("/video/play?bvid=BV1preload2&cid=124&aid=456");
    });
    // createMemoryRouter 不改真实 `location`，路由状态只能从 router 上读。
    await page.waitForFunction(
      () =>
        new URLSearchParams(window.nextPreloadFixture.router.state.location.search).get("cid") ===
          "124" &&
        window.nextPreloadEngine &&
        !window.nextPreloadEngine.media.paused,
    );
    await page.evaluate(() => window.nextPreloadEngine.bufferUpTo(10));
    await page.waitForTimeout(400);
    assert((await calls()) === 1, "换集后沿用了上一集的末片判定");
    passed.push("换集后闸门重新关闭");

    // 同集重建（换画质/重试）：分集身份不变，但取流地址换了、缓冲从零开始。
    // 若闸门只按分集身份记账，这里会沿用上一轮的末片判定、立刻放行一次预热。
    // 走真实重试入口（HUD 刷新按钮）触发同一条重建链：新的 play-info → 新地址。
    await page.evaluate(() => {
      window.nextPreloadFixture.router.navigate("/video/play?bvid=BV1preload2&cid=123&aid=456");
    });
    await page.waitForFunction(
      () =>
        new URLSearchParams(window.nextPreloadFixture.router.state.location.search).get("cid") ===
          "123" &&
        window.nextPreloadEngine &&
        !window.nextPreloadEngine.media.paused,
    );
    // 回到 P1（上一轮已预热过它），用刷新重建一个空缓冲的新会话。
    const beforeRebuild = await calls();
    const refresh = page.getByRole("button", { name: "刷新播放" });
    assert((await refresh.count()) === 1, "找不到刷新播放按钮");
    await refresh.click();
    await page.waitForFunction(() => window.nextPreloadEngine && !window.nextPreloadEngine.media.paused);
    await page.evaluate(() => window.nextPreloadEngine.bufferUpTo(2));
    await page.waitForTimeout(400);
    assert((await calls()) === beforeRebuild, "同集重建后沿用了上一轮的末片判定");
    passed.push("同集重建后闸门重新关闭");

    return { passed };
  } finally {
    await page.goto(origin);
    await page.unroute(enginePattern);
  }
}
