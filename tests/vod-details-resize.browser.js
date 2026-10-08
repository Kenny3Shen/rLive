// 真实 Shell/播放页的隔离浏览器夹具回归（mock IPC，不可在真实 Tauri 窗口运行）。
// playwright-cli -s=vod-fixture open http://localhost:1420/
// playwright-cli -s=vod-fixture run-code --filename=tests/vod-details-resize.browser.js
async (page) => {
  const originalUrl = page.url();
  const originalOrigin = await page.evaluate(() => location.origin);
  const originalUa = await page.evaluate(() => navigator.userAgent);
  const client = await page.context().newCDPSession(page);
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const passed = [];
  const errors = [];
  const recordError = (error) => errors.push(error.message);
  page.on("pageerror", recordError);
  const frames = () => page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  const setRatio = async (width, height) => {
    await page.evaluate(({ width, height }) => {
      const video = document.querySelector("video");
      Object.defineProperty(video, "videoWidth", { value: width, configurable: true });
      Object.defineProperty(video, "videoHeight", { value: height, configurable: true });
      video.dispatchEvent(new Event("resize"));
    }, { width, height });
    await frames();
  };
  const read = () => page.evaluate(() => {
    const frame = document.querySelector("[data-video-details-frame]");
    const stage = document.querySelector("[data-video-player-frame]");
    const aside = document.querySelector('aside[aria-label="视频详情"]');
    return {
      share: frame?.style.getPropertyValue("--vod-details-share") || null,
      frame: frame?.getBoundingClientRect().height,
      stage: stage?.getBoundingClientRect().height,
      aside: aside?.getBoundingClientRect().height,
      tab: document.querySelector("[data-video-side-tab-panel]:not([aria-hidden])")?.dataset.videoSideTabPanel,
    };
  });
  const geometry = async () => {
    const snap = await read();
    assert(Math.abs(snap.stage + snap.aside - snap.frame) < 0.5, `高度不守恒：${JSON.stringify(snap)}`);
    assert(snap.stage >= 401 / (16 / 9) - 0.5, `舞台小于满宽16:9：${snap.stage}`);
    return snap;
  };
  const gesture = async (delta, tabs = false) => {
    await page.evaluate(async ({ delta, tabs }) => {
      const target = tabs
        ? document.querySelector('[data-slot="tabs-list"]')
        : document.querySelector('[data-video-side-tab-panel]:not([aria-hidden])');
      const rect = target.getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + Math.min(60, rect.height / 2);
      const send = (type, offset) => {
        const touch = new Touch({ identifier: 41, target, clientX: x, clientY: y + offset });
        const touches = type === "touchend" ? [] : [touch];
        target.dispatchEvent(new TouchEvent(type, {
          touches, targetTouches: touches, changedTouches: [touch], bubbles: true, cancelable: true,
        }));
      };
      send("touchstart", 0);
      for (const offset of [Math.sign(delta) * 12, delta]) {
        send("touchmove", offset);
        await new Promise(requestAnimationFrame);
      }
      send("touchend", delta);
    }, { delta, tabs });
    await frames();
  };
  try {
    await client.send("Network.setUserAgentOverride", {
      userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36",
      userAgentMetadata: { brands: [], fullVersionList: [], platform: "Android", platformVersion: "14", architecture: "", model: "Pixel 8", mobile: true },
    });
    await client.send("Emulation.setDeviceMetricsOverride", { width: 401, height: 757, deviceScaleFactor: 1, mobile: false });
    await page.goto(`${originalOrigin}/tests/browser/video-shell.html`);
    await page.evaluate(async () => { await import("/src/styles.css"); });
    await page.waitForFunction(() => Boolean(window.shellFixture));
    await page.evaluate(() => window.shellFixture.router.navigate("/video/play?bvid=BV1shell&cid=1001"));
    await page.waitForSelector('[data-video-side-tab-panel="related"]', { timeout: 20000 });
    await page.waitForSelector('dt:text-is("当前在线人数")', { state: "attached" });
    await frames();

    // 接口约数原样显示，发布时间与在线人数同排，且人数在右。
    const stats = await page.evaluate(() => {
      const cells = Array.from(document.querySelectorAll("aside dl > div"));
      const date = cells.find((el) => el.querySelector("dt")?.textContent === "发布时间");
      const online = cells.find((el) => el.querySelector("dt")?.textContent === "当前在线人数");
      const a = date.getBoundingClientRect(), b = online.getBoundingClientRect();
      return { dateRight: a.right, dateY: a.y, onlineX: b.x, onlineY: b.y, text: online.querySelector("dd").textContent };
    });
    assert(stats.text === "1.2万+", `在线数据未保留纯数量格式：${stats.text}`);
    assert(stats.onlineX >= stats.dateRight && Math.abs(stats.onlineY - stats.dateY) < 1, "在线人数不在发布时间右侧同排");
    passed.push("在线人数与发布时间同排，约数格式保留");

    await setRatio(0, 0);
    await gesture(-120); await gesture(120);
    assert((await read()).share === null, "未知画幅仍调整占比");
    await setRatio(1920, 1080);
    await gesture(-120); await gesture(120);
    const wide = await geometry();
    assert(wide.share === null && Math.abs(wide.stage - 401 / (16 / 9)) < 0.5, "16:9内容滑动改变布局");
    passed.push("未知及16:9画幅上下滑均保持默认比例");

    await setRatio(1080, 1920);
    const portrait = await read();
    await gesture(-150);
    const expanded = await geometry();
    assert(expanded.aside > portrait.aside + 100, "竖屏内容上滑未扩大侧栏");
    await gesture(80, true); await gesture(-80, true);
    assert((await read()).share === expanded.share, "纵向拖Tab栏仍改变占比");
    await gesture(-2000);
    const max = await geometry();
    assert(Math.abs(max.stage - 401 / (16 / 9)) < 0.5, "上限未保留满宽16:9舞台");
    await page.evaluate(() => { document.querySelector('[data-video-side-tab-panel]:not([aria-hidden])').scrollTop = 0; });
    await gesture(2000);
    const restored = await geometry();
    assert(Math.abs(restored.stage - portrait.stage) < 0.5, "下滑未恢复原始竖屏舞台");
    await gesture(2000);
    assert(Math.abs((await read()).stage - portrait.stage) < 0.5, "继续下滑越过原始竖屏布局");
    passed.push("非16:9上滑保留16:9舞台，下滑硬停原始布局，Tab不调整且总高度守恒");

    const beforeSwipe = await read();
    await page.evaluate(async () => {
      const target = document.querySelector('[data-video-side-tab-panel]:not([aria-hidden])');
      const surface = target.closest('[data-horizontal-swipe-surface]');
      // 合成指针不在浏览器active pointer表内，捕获由夹具替身完成。
      surface.setPointerCapture = () => {};
      surface.hasPointerCapture = () => false;
      const send = (type, x) => target.dispatchEvent(new PointerEvent(type, {
        pointerId: 81, pointerType: "touch", isPrimary: true,
        clientX: x, clientY: 600, bubbles: true, cancelable: true,
      }));
      try {
        send("pointerdown", 320);
        send("pointermove", 280);
        await new Promise(requestAnimationFrame);
        send("pointermove", 50);
        send("pointerup", 50);
      } finally { delete surface.setPointerCapture; delete surface.hasPointerCapture; }
    });
    await page.waitForFunction(() => document.querySelector('[data-video-side-tab-panel="comments"]')?.getAttribute("aria-hidden") === null);
    assert((await read()).share === beforeSwipe.share, "内容横滑改了占比");
    passed.push("内容横滑仍切页签，不改变占比");

    await setRatio(1920, 1080);
    const reset = await geometry();
    assert(reset.share === null && Math.abs(reset.stage - 401 / (16 / 9)) < 0.5, "切回16:9未恢复默认布局");

    for (const [width, height] of [[4, 3], [21, 9], [6, 1]]) {
      await setRatio(1920, 1080);
      await setRatio(width, height);
      const original = await read();
      await gesture(-2000);
      await page.evaluate(() => { document.querySelector('[data-video-side-tab-panel]:not([aria-hidden])').scrollTop = 0; });
      await gesture(2000);
      await gesture(2000);
      const current = await read();
      assert(Math.abs(current.stage - original.stage) < 0.5, `${width}:${height}恢复后继续下滑越过原始布局`);
      assert(Math.abs(current.stage + current.aside - current.frame) < 0.5, `${width}:${height}恢复后高度不守恒`);
    }
    passed.push("4:3、21:9及极宽画幅多次手势始终以原始布局硬停");

    // 不切集，只改变源画幅：自定义占比要跟随新下限，而不是保留原先的百分比。
    await setRatio(4, 3);
    await gesture(-80);
    await setRatio(6, 1);
    const extraWide = await read();
    assert(parseFloat(extraWide.share) > 85, "动态画幅的原始占比被85%兜底截断");
    assert(Math.abs(extraWide.stage - 401 / 6) < 0.5, "画幅变化未重算恢复下限");
    await gesture(2000);
    assert(Math.abs((await read()).stage - 401 / 6) < 0.5, "极宽画幅下滑越过动态原始布局");
    passed.push("动态画幅变化重算下限，超过85%的原始占比不会被预览或提交截断");

    await setRatio(1920, 1080);
    await setRatio(1080, 1920);
    await gesture(-80);
    assert((await read()).share !== null, "切集前未建立自定义占比");
    await page.evaluate(() => window.shellFixture.router.navigate("/video/play?bvid=BV1shell&cid=1002"));
    await frames();
    await setRatio(1080, 1920);
    assert((await read()).share === null, "换分P仍沿用旧占比");
    passed.push("切回16:9及换分P恢复默认比例");
    return { passed };
  } catch (error) {
    const state = await read().catch(() => null);
    throw new Error(`${error.message}; 已通过：${passed.join("；")}; 当前：${JSON.stringify(state)}; 页面错误：${errors.join("；")}`);
  } finally {
    page.off("pageerror", recordError);
    await client.send("Network.setUserAgentOverride", { userAgent: originalUa });
    await client.send("Emulation.clearDeviceMetricsOverride");
    await client.detach();
    await page.goto(originalUrl);
  }
}
