// 只访问独立 mock 夹具，不连接或改变真实 Tauri 播放会话。
// playwright-cli -s=vod-session-review open http://127.0.0.1:1425/
// playwright-cli -s=vod-session-review run-code --filename=tests/video-session-lifecycle.browser.js
async (page) => {
  const origin = await page.evaluate(() => location.origin);
  const enginePattern = /\/@videojs_dash-video\.js/;
  const engine = `
    export class DashAdapter extends EventTarget {
      handlers = new Map(); destroyed = false;
      engine = {
        on: (name, fn) => { const list = this.handlers.get(name) || new Set(); list.add(fn); this.handlers.set(name, list); },
        off: (name, fn) => this.handlers.get(name)?.delete(fn),
      };
      attach(media) {
        this.media = media;
        let time = 0, paused = true, ready = 0;
        this.setReady = () => { ready = 4; };
        this.setTime = value => { time = value; };
        Object.defineProperties(media, {
          currentTime: { configurable: true, get: () => time, set: value => {
            time = value; media.dispatchEvent(new Event('seeking')); media.dispatchEvent(new Event('seeked'));
          } },
          duration: { configurable: true, get: () => 600 },
          paused: { configurable: true, get: () => paused },
          ended: { configurable: true, get: () => false },
          readyState: { configurable: true, get: () => ready },
        });
        media.play = async () => {
          paused = false; media.dispatchEvent(new Event('play'));
          await Promise.resolve();
          if (!this.destroyed && ready >= 2) media.dispatchEvent(new Event('playing'));
        };
        media.pause = () => { if (!paused) { paused = true; media.dispatchEvent(new Event('pause')); } };
        media.load = () => {};
        (window.vodSessionEngines ||= []).push(this);
      }
      set source(value) {
        if (!value) return;
        this.sourceUrl = value.src;
        queueMicrotask(() => {
          if (this.destroyed) return;
          const anchor = new URL(value.src, location.href).hash.slice(1);
          this.setTime(Number(new URLSearchParams(anchor).get('t') || 0)); this.setReady();
          this.media.dispatchEvent(new Event('loadedmetadata'));
          this.media.dispatchEvent(new Event('loadeddata'));
          this.media.dispatchEvent(new Event('canplay'));
        });
      }
      destroy() { this.destroyed = true; this.handlers.clear(); }
    }
  `;
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const errors = [];
  const onError = (error) => errors.push(error.message);
  page.on("pageerror", onError);
  await page.route(enginePattern, (route) =>
    route.fulfill({ body: engine, contentType: "application/javascript" }),
  );
  try {
    await page.goto(`${origin}/tests/browser/video-session-lifecycle.html`);
    await page.waitForFunction(() => window.vodSessionEngines?.at(-1)?.media.readyState === 4);
    await page.evaluate(() => {
      const f = window.vodSessionFixture;
      f.manual = true;
      const media = window.vodSessionEngines.at(-1).media;
      media.currentTime = 120;
      media.dispatchEvent(new Event("timeupdate"));
    });
    const beforeRefresh = await page.evaluate(() => window.vodSessionFixture.requests.length);
    await page.getByRole("button", { name: "刷新播放", exact: true }).click();
    await page.waitForFunction(
      (count) => window.vodSessionFixture.requests.length > count,
      beforeRefresh,
    );
    await page.evaluate(() => {
      const media = window.vodSessionEngines.at(-1).media;
      media.currentTime = 300;
      media.pause();
      window.vodSessionFixture.requests.at(-1).resolve();
    });
    await page.waitForFunction(() => window.vodSessionEngines.at(-1).sourceUrl?.endsWith("#t=300"));
    assert(
      await page.evaluate(() => window.vodSessionEngines.at(-1).media.paused),
      "交接必须保留请求期间的暂停",
    );

    const beforeSwitch = await page.evaluate(() => window.vodSessionFixture.requests.length);
    await page.evaluate(() => {
      window.vodSessionEngines.at(-1).media.currentTime = 333;
      void window.vodSessionFixture.router.navigate("/video/play?bvid=BVsession&cid=2&aid=1");
    });
    await page.waitForFunction(
      (count) => window.vodSessionFixture.requests.length > count,
      beforeSwitch,
    );
    await page.waitForFunction(() =>
      window.vodSessionFixture.reports.some((r) => r.cid === 1 && r.progress === 333),
    );
    await page.evaluate(() => window.vodSessionFixture.requests.at(-1).reject());
    await page.getByRole("button", { name: "重试", exact: true }).waitFor();
    const beforeRetry = await page.evaluate(() => ({
      requests: window.vodSessionFixture.requests.length,
      engines: window.vodSessionEngines.length,
    }));
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await page.waitForFunction(
      (count) => window.vodSessionFixture.requests.length > count,
      beforeRetry.requests,
    );
    await page.waitForTimeout(100);
    assert(
      await page.evaluate(
        (count) => window.vodSessionEngines.length === count,
        beforeRetry.engines,
      ),
      "B 重试期间不能拿 A 的 placeholder 建播放器",
    );
    await page.evaluate(() => window.vodSessionFixture.requests.at(-1).resolve());
    await page.waitForFunction(
      (count) =>
        window.vodSessionEngines.length > count &&
        window.vodSessionEngines.at(-1).media.readyState === 4,
      beforeRetry.engines,
    );
    assert(
      await page.evaluate(() => window.vodSessionEngines.at(-1).media.currentTime === 0),
      "B 不能续播 A 的断点",
    );

    const beforeLeave = await page.evaluate(() => window.vodSessionFixture.requests.length);
    await page.getByRole("button", { name: "刷新播放", exact: true }).click();
    await page.waitForFunction(
      (count) => window.vodSessionFixture.requests.length > count,
      beforeLeave,
    );
    const lateId = await page.evaluate(() => {
      const f = window.vodSessionFixture;
      void f.router.navigate("/away");
      return f.requests.at(-1).id;
    });
    await page.getByText("已离开", { exact: true }).waitFor();
    await page.evaluate(() => window.vodSessionFixture.requests.at(-1).resolve());
    await page.waitForFunction((id) => window.vodSessionFixture.stopped.includes(id), lateId);
    assert(errors.length === 0, `页面错误：${errors.join("; ")}`);
    return {
      passed: [
        "请求期间 seek/暂停以清理现场续播",
        "换集 flush 旧集最终进度",
        "切集失败重试不复用别集 placeholder",
        "卸载后迟到结果释放代理",
        "StrictMode 无页面异常",
      ],
    };
  } finally {
    page.off("pageerror", onError);
    await page.goto(origin);
    await page.unroute(enginePattern);
  }
}
