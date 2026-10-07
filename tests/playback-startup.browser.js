// 媒体首帧优先：真实视频页 + 可控 DASH 引擎；不访问平台媒体。
// playwright-cli -s=rwin run-code --filename=tests/playback-startup.browser.js
async (page) => {
  const origin = await page.evaluate(() => location.origin);
  const enginePattern = /@videojs_dash-video\.js/;
  const fixturePattern = "**/tests/browser/video-next-preload.tsx*";
  const apiPattern = "**/src/shared/api/tauri.ts*";
  await page.unroute(fixturePattern);
  await page.unroute(apiPattern);
  await page.unroute(enginePattern);
  // 由 Windows 页内取 Vite 模块；WSL 的 route.fetch 无法访问 Windows 的 ::1:1420。
  const sources = await page.evaluate(async () =>
    Promise.all([
      fetch("/tests/browser/video-next-preload.tsx").then((response) => response.text()),
      fetch("/src/shared/api/tauri.ts").then((response) => response.text()),
    ]),
  );
  // 主窗口的 Tauri globals 为只读，不能使用 mockIPC 覆盖；只在测试模块边界接管命令。
  const fixtureSource = sources[0]
    .replace("Object.assign(window, { isTauri: true });", "")
    .replace('mockWindows("main");', "")
    .replace("mockIPC(", "window.__startupRegisterIPC(");
  await page.route(fixturePattern, (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body:
        "window.__startupRegisterIPC = handler => { window.__startupInvoke = handler; };\n" +
        fixtureSource,
    }),
  );
  const signature = "async function invokeCmd(cmd, args) {";
  if (!sources[1].includes(signature)) throw new Error("IPC 注入点已改变");
  await page.route(apiPattern, (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: sources[1].replace(
        signature,
        signature + "\nif (window.__startupInvoke) return window.__startupInvoke(cmd, args);",
      ),
    }),
  );
  const engine = `
    export class DashAdapter extends EventTarget {
      engine = { on() {}, off() {} };
      attach(media) {
        this.media = media;
        let time = 0, paused = true, ready = 0;
        Object.defineProperties(media, {
          currentTime: { configurable: true, get: () => time, set: value => { time = value; } },
          duration: { configurable: true, get: () => 10 },
          paused: { configurable: true, get: () => paused },
          readyState: { configurable: true, get: () => ready },
        });
        // play 不代表已经出画，不能提前放行辅助请求。
        media.play = async () => { paused = false; media.dispatchEvent(new Event('play')); };
        media.pause = () => { paused = true; media.dispatchEvent(new Event('pause')); };
        media.load = () => {};
        this.finish = () => {
          ready = 4;
          media.dispatchEvent(new Event('loadedmetadata'));
          media.dispatchEvent(new Event('loadeddata'));
          media.dispatchEvent(new Event('canplay'));
        };
        window.startupEngine = this;
        window.startupAttachCount = (window.startupAttachCount || 0) + 1;
      }
      set source(value) {}
      destroy() {}
    }
  `;
  const assert = (value, message) => {
    if (!value) throw new Error(message);
  };
  const secondary = [
    "video_get_player_meta",
    "video_get_storyboard",
    "video_get_danmaku",
    "video_get_related",
  ];
  await page.route(enginePattern, (route) =>
    route.fulfill({ body: engine, contentType: "application/javascript" }),
  );
  try {
    await page.goto(`${origin}/tests/browser/video-next-preload.html`);
    await page.waitForFunction(() => window.startupEngine && !window.startupEngine.media.paused);
    const before = await page.evaluate(() => window.nextPreloadIpcCalls);
    assert(before.includes("video_get_play_info"), "没有优先取流");
    assert(!secondary.some((cmd) => before.includes(cmd)), `出画前请求了辅助内容：${before}`);
    assert(await page.locator('[data-player-controls], [data-player-hud]').count() === 0, "首帧前不应显示控制栏");
    assert(await page.getByRole("button", { name: "返回视频列表" }).isVisible(), "取流期间缺少返回入口");
    // 暂停/自动播放拦截也应在 loadeddata 后显示侧栏，无须 playing。
    await page.evaluate(() => {
      window.startupEngine.media.pause();
      window.startupEngine.finish();
    });
    await page.waitForFunction(() =>
      [
        "video_get_player_meta",
        "video_get_storyboard",
        "video_get_danmaku",
        "video_get_related",
      ].every((cmd) => window.nextPreloadIpcCalls.includes(cmd)),
    );
    assert(
      await page.evaluate(() => window.startupAttachCount === 1),
      "辅助内容就位导致播放器重建",
    );
    assert(await page.locator('[data-player-controls]').count() === 1, "可播后控制栏未出现");
    await page.evaluate(() => window.startupEngine.media.dispatchEvent(new Event('waiting')));
    assert(await page.locator('[data-player-controls]').count() === 1, "已起播缓冲不应卸载控制栏");
    await page.getByRole('button', { name: '刷新播放' }).click();
    await page.waitForFunction(() => window.startupAttachCount === 2);
    assert(await page.locator('[data-player-controls], [data-player-hud]').count() === 0, "同一视频重新取流仍显示控制栏");
    await page.evaluate(() => window.startupEngine.finish());
    await page.waitForFunction(() => !!document.querySelector('[data-player-controls]'));

    const oldEngine = await page.evaluate(() => {
      window.nextPreloadIpcCalls.length = 0;
      window.previousStartupEngine = window.startupEngine;
      window.nextPreloadFixture.router.navigate("/video/play?bvid=BV1preload2&cid=124&aid=456");
      return window.startupAttachCount;
    });
    await page.waitForFunction((count) => window.startupAttachCount > count, oldEngine);
    const switched = await page.evaluate(() => window.nextPreloadIpcCalls);
    assert(await page.locator('[data-player-controls], [data-player-hud]').count() === 0, "换片未隐藏控制栏");
    assert(!secondary.some((cmd) => switched.includes(cmd)), `换片沿用了旧首帧状态：${switched}`);
    await page.evaluate(() => window.startupEngine.finish());
    await page.waitForFunction(() => window.nextPreloadIpcCalls.includes("video_get_danmaku"));

    // 直接覆盖共享门控的迟到回调、换回原内容与幂等语义。
    const lifecycle = await page.evaluate(async () => {
      const { setupHarness, assert, frames } = await import("/tests/browser/harness.js");
      const { usePlayerStartupGate } = await import("/src/shared/hooks/usePlayerStartupGate.ts");
      const harness = await setupHarness();
      let gate;
      const Probe = ({ id }) => {
        gate = usePlayerStartupGate(id);
        return null;
      };
      try {
        harness.render(harness.h(Probe, { id: "a" }));
        assert(!gate.ready, "首次挂载应关闭");
        const oldRelease = gate.release;
        harness.flushSync(() => gate.release());
        assert(gate.ready, "首帧没有放行");
        harness.render(harness.h(Probe, { id: "b" }));
        assert(!gate.ready, "换片没有同步关闭");
        harness.flushSync(() => oldRelease());
        assert(!gate.ready, "旧回调误放行新片");
        harness.flushSync(() => gate.release());
        harness.flushSync(() => oldRelease());
        assert(gate.ready, "旧回调误关闭新片");
        harness.render(harness.h(Probe, { id: "a" }));
        assert(!gate.ready, "回访沿用了旧就绪状态");
        harness.flushSync(() => oldRelease());
        assert(!gate.ready, "回访被上一轮的迟到回调放行");
        harness.render(null);
        const { useShortsDanmaku } = await import("/src/features/shorts/useShortsDanmaku.ts");
        const previousInvoke = window.__startupInvoke;
        const requests = [];
        let danmaku;
        const DanmakuProbe = ({ cid, visible }) => {
          danmaku = useShortsDanmaku(cid, visible);
          return null;
        };
        window.__startupInvoke = (cmd, args) => {
          if (cmd !== "video_get_danmaku") return previousInvoke(cmd, args);
          requests.push(args);
          return Promise.resolve({ items: [], has_more: true });
        };
        try {
          harness.render(harness.h(DanmakuProbe, { cid: 201, visible: true }));
          await frames();
          assert(requests.length === 0, "短视频拿到 cid 就抢先请求弹幕");
          danmaku.ensure(400_000);
          await frames();
          assert(requests.length === 2 && requests[0].segmentIndex === 2, "未从实际进度加载弹幕");
          harness.render(harness.h(DanmakuProbe, { cid: 202, visible: false }));
          danmaku.ensure(800_000);
          await frames();
          assert(requests.length === 2, "关闭弹幕仍发请求");
          harness.render(harness.h(DanmakuProbe, { cid: 202, visible: true }));
          await frames();
          assert(
            requests.length === 4 && requests[2].cid === 202 && requests[2].segmentIndex === 3,
            "重新开启未使用当前进度",
          );
        } finally {
          window.__startupInvoke = previousInvoke;
        }
        return true;
      } finally {
        harness.dispose();
      }
    });
    return {
      passed: true,
      streamFirst: true,
      pausedLoadedData: true,
      noRebuild: true,
      switchResets: true,
      controlsWaitForMedia: true,
      reloadHidesControls: true,
      lifecycle,
    };
  } catch (error) {
    const state = await page.evaluate(() => ({
      url: location.href,
      attaches: window.startupAttachCount,
      commands: window.nextPreloadIpcCalls,
      text: document.body.innerText.slice(0, 700),
    }));
    throw new Error(`${error}\n${JSON.stringify(state)}`);
  } finally {
    await page.goto(origin);
    await page.unroute(enginePattern);
    await page.unroute(fixturePattern);
    await page.unroute(apiPattern);
  }
}
