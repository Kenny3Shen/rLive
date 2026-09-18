// bun run dev 后：playwright-cli run-code --filename=tests/video-autoplay.browser.js
// 完整播放页回归，模拟 dash.js 只暂停并通知 playbackEnded 的终点兜底。
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
        Object.defineProperties(media, {
          currentTime: { configurable: true, get: () => time, set: value => {
            time = value; media.dispatchEvent(new Event('seeking'));
            media.dispatchEvent(new Event('seeked'));
          } },
          duration: { configurable: true, get: () => 10 },
          paused: { configurable: true, get: () => paused },
          ended: { configurable: true, get: () => false },
          readyState: { configurable: true, get: () => 4 },
        });
        media.play = async () => {
          paused = false; media.dispatchEvent(new Event('play'));
          media.dispatchEvent(new Event('playing'));
        };
        media.pause = () => { paused = true; media.dispatchEvent(new Event('pause')); };
        media.load = () => {};
        window.autoplayEngine = this;
      }
      set source(value) {
        queueMicrotask(() => {
          this.media.dispatchEvent(new Event('loadedmetadata'));
          this.media.dispatchEvent(new Event('canplay'));
        });
      }
      end(native = false, isLast = true) {
        this.media.currentTime = 10;
        if (native) this.media.dispatchEvent(new Event('ended'));
        this.media.pause();
        for (const fn of this.handlers.get('playbackEnded') || []) fn({ isLast });
      }
      destroy() { this.handlers.clear(); }
    }
  `;
  const enginePattern = /\/@videojs_dash-video\.js/;
  const fixtureUrl = `${origin}/tests/browser/video-autoplay.html`;
  await page.route(enginePattern, (route) =>
    route.fulfill({ body: engine, contentType: "application/javascript" }),
  );
  const passed = [];
  const open = async () => {
    await page.goto(fixtureUrl);
    await page.waitForFunction(() => window.autoplayEngine && !window.autoplayEngine.media.paused);
  };
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const currentCid = () =>
    page.evaluate(() =>
      new URLSearchParams(window.autoplayFixture.router.state.location.search).get("cid"),
    );
  try {
    await open();
    assert(
      (await page.evaluate(
        () => window.autoplayFixture.store.getState().getNextAutoPlayItem()?.cid,
      )) === 124,
      "下一集队列未就绪",
    );
    await page.evaluate(() => window.autoplayEngine.end());
    assert(
      await page.evaluate(() => !window.autoplayEngine.media.ended),
      "必须覆盖原生 ended 为 false 的情况",
    );
    await page.waitForFunction(() =>
      window.autoplayFixture.router.state.location.search.includes("cid=124"),
    );
    passed.push("仅 DASH 引擎结束也自动导航到第二集");

    await open();
    await page.evaluate(() => window.autoplayEngine.end(true));
    await page.waitForFunction(() =>
      window.autoplayFixture.router.state.location.search.includes("cid=124"),
    );
    assert(
      (await page.evaluate(() => window.autoplayFixture.router.state.historyAction)) === "PUSH",
      "换集没有完成",
    );
    passed.push("原生与引擎重复结束正常换集");

    for (const action of ["关闭自动切集", "拖回视频中间", "离开播放页"]) {
      await open();
      await page.evaluate((action) => {
        window.autoplayEngine.end();
        if (action === "关闭自动切集")
          window.autoplayFixture.store.setState({ autoPlayNext: false });
        if (action === "拖回视频中间") window.autoplayEngine.media.currentTime = 2;
        if (action === "离开播放页") void window.autoplayFixture.router.navigate("/away");
      }, action);
      await page.waitForTimeout(1200);
      assert((await currentCid()) !== "124", `${action}后仍被旧计时器切集`);
      passed.push(`${action}取消待执行切集`);
    }

    await open();
    await page.evaluate(() => {
      window.autoplayFixture.store.setState({ loopPlayback: true });
      window.autoplayEngine.end(true);
    });
    await page.waitForFunction(
      () => !window.autoplayEngine.media.paused && window.autoplayEngine.media.currentTime === 0,
    );
    await page.waitForTimeout(1200);
    assert((await currentCid()) === "123", "循环播放被自动切集抢走");
    passed.push("循环播放避开引擎收尾暂停，并优先于切集");
    return { passed };
  } finally {
    await page.goto(origin);
    await page.unroute(enginePattern);
  }
}
