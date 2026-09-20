// VOD 自动续播后的「播完进下一集」回归。
//
// 复现路径（真实用户路径）：搜索/UP 投稿队列里点开一个多 P 稿件，观看历史
// 让它续播到中间某一 P。队列条目没有 cid（搜索接口不给），列表项以 0 占位；
// 取流键由历史补出。修复前 played-ended 只沿来源队列取下一项，于是播完会切到
// 搜索结果的下一条（另一个视频）；修复后必须沿稿件自身的分 P 列表进 P(n+1)。
//
// 与 video-autoplay.browser.js 同源：真实播放页 + 真实查询 + 真实播放列表，
// 仅 IPC 与 DASH 外部引擎使用桩（本夹具进一步把历史续播返回落在 P2）。
// 先跑 `bun run dev`，再执行：
//   playwright-cli -s=video-resume-next open http://127.0.0.1:1420/
//   playwright-cli -s=video-resume-next run-code --filename=tests/video-resume-next.browser.js
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
        window.resumeNextEngine = this;
      }
      set source(value) {
        queueMicrotask(() => {
          this.media.dispatchEvent(new Event('loadedmetadata'));
          this.media.dispatchEvent(new Event('canplay'));
        });
      }
      end(native = false) {
        this.media.currentTime = 10;
        if (native) this.media.dispatchEvent(new Event('ended'));
        this.media.pause();
        for (const fn of this.handlers.get('playbackEnded') || []) fn({ isLast: true });
      }
      destroy() { this.handlers.clear(); }
    }
  `;
  const enginePattern = /\/@videojs_dash-video\.js/;
  const fixtureUrl = `${origin}/tests/browser/video-resume-next.html`;
  await page.route(enginePattern, (route) =>
    route.fulfill({ body: engine, contentType: "application/javascript" }),
  );
  const passed = [];
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const search = () =>
    page.evaluate(() =>
      Object.fromEntries(
        new URLSearchParams(window.resumeNextFixture.router.state.location.search),
      ),
    );
  const open = async () => {
    await page.goto(fixtureUrl);
    await page.waitForFunction(() => window.resumeNextEngine && !window.resumeNextEngine.media.paused);
  };
  try {
    // 1) 搜索队列 + 历史续播到 P2：链接只带 bvid（搜索条目没有 cid），
    //    取流键必须由历史续播补成 1002，而不是退回 P1。
    await open();
    await page.waitForFunction(
      () => window.resumeNextFixture.store.getState().items.length > 0,
    );
    const playingCid = await page.evaluate(
      () => window.resumeNextFixture.store.getState().currentId,
    );
    assert(playingCid === "BV1parts_0", `搜索队列当前项应是 0 占位项：${playingCid}`);
    const queueNext = await page.evaluate(
      () => window.resumeNextFixture.store.getState().getNextAutoPlayItem()?.bvid ?? null,
    );
    assert(
      queueNext === "BV1other",
      `来源队列的下一项应是别的稿件（修复前它会把人带走）：${queueNext}`,
    );
    passed.push("搜索队列 + 续播到 P2：队列邻项确实是另一个稿件（复现条件成立）");

    // 2) 播完 → 必须进同稿件的 P3，而不是搜索队列的下一条 BV1other。
    await page.evaluate(() => window.resumeNextEngine.end());
    await page.waitForFunction(
      () =>
        new URLSearchParams(window.resumeNextFixture.router.state.location.search).get("cid") ===
        "1003",
    );
    const params = await search();
    assert(params.bvid === "BV1parts", "播完应留在原稿件的分 P 列表里");
    // 换到 P3 后路由身份已不在来源队列（队列里只有 cid 占位的当前项与别的稿件），
    // 稿件详情就位后选集接管队列：与主动点「选集」分 P 是同一条语义。
    await page.waitForFunction(() =>
      window.resumeNextFixture.store
        .getState()
        .items.some((item) => item.id === "BV1parts_1001"),
    );
    const afterJump = await page.evaluate(() => {
      const state = window.resumeNextFixture.store.getState();
      return {
        ids: state.items.map((item) => item.id),
        current: state.currentId,
        next: state.getNextAutoPlayItem()?.id ?? null,
      };
    });
    assert(
      afterJump.ids.join(",") === "BV1parts_1001,BV1parts_1002,BV1parts_1003",
      `进入选集后队列应是稿件分 P：${afterJump.ids.join(",")}`,
    );
    assert(afterJump.current === "BV1parts_1003", `当前项应锚在 P3：${afterJump.current}`);
    assert(afterJump.next === null, "P3 是最后一 P，不应再有自动切集目标");
    passed.push("自动切入选集后当前项锚在该分 P，已在最后一 P 时不再连播");
    passed.push("自动续播到中间分 P 后，播完进同稿件的下一 P（而不是另一个视频）");

    // 3) 对照：关掉「自动切集」后不应再自行跳转。
    await page.goto(fixtureUrl);
    await page.waitForFunction(
      () => window.resumeNextEngine && !window.resumeNextEngine.media.paused,
    );
    const beforeEnd = await page.evaluate(
      () => window.resumeNextFixture.router.state.location.search,
    );
    await page.evaluate(() => {
      window.resumeNextFixture.store.setState({ autoPlayNext: false });
      window.resumeNextEngine.end();
    });
    await page.waitForTimeout(1200);
    assert(
      (await page.evaluate(() => window.resumeNextFixture.router.state.location.search)) ===
        beforeEnd,
      "关闭自动切集后仍被计时器带走（应停在当前视频）",
    );
    passed.push("关闭自动切集后停在当前视频");
    return { passed };
  } finally {
    await page.goto(origin);
    await page.unroute(enginePattern);
  }
}
