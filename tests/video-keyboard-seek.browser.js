// 在正在播放视频的桌面真实主窗口运行，不使用 mock IPC：
//   playwright-cli -s=rwin attach --cdp=http://127.0.0.1:9223
//   playwright-cli -s=rwin run-code --filename=tests/video-keyboard-seek.browser.js
async (page) => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const stage = page.locator("[data-player-stage]");
  await stage.waitFor();
  await page.waitForFunction(() => {
    const video = document.querySelector("video");
    return video && video.readyState >= 3 && !video.seeking;
  });
  const initial = await page.evaluate(() => {
    const video = document.querySelector("video");
    return { paused: video.paused, time: video.currentTime, duration: video.duration };
  });
  assert(
    initial.time > 60 && initial.duration - initial.time > 60,
    "请先播放距片头、片尾均超过 60 秒的视频",
  );
  await stage.focus();
  if (initial.paused) await page.keyboard.press("Space");
  await page.waitForFunction(() => {
    const video = document.querySelector("video");
    return !video.paused && video.readyState >= 3 && !video.seeking;
  });
  // 移出舞台，避免鼠标停在控制条上持有可见状态。
  await page.mouse.move(0, 0);
  const waitForChrome = (visible) =>
    page.waitForFunction((expected) => {
      const layers = [...document.querySelectorAll("[data-player-hud],[data-player-controls]")];
      return (
        layers.length === 2 && layers.every((layer) => layer.dataset.visible === String(expected))
      );
    }, visible);
  await waitForChrome(false);

  await page.evaluate(() => {
    const layers = [...document.querySelectorAll("[data-player-hud],[data-player-controls]")];
    const probe = { changes: [], seeks: 0, waiting: 0, events: [] };
    const video = document.querySelector("video");
    const record = (event) =>
      probe.events.push({
        event,
        seeking: video.seeking,
        ready: video.readyState,
        time: video.currentTime,
      });
    const onSeeking = () => {
      probe.seeks += 1;
      record("seeking");
    };
    const onWaiting = () => {
      probe.waiting += 1;
      record("waiting");
    };
    const observer = new MutationObserver((records) => {
      for (const { target } of records) {
        if (target.dataset.visible === "true") {
          if (probe.changes.length === 0) record("chrome-visible");
          probe.changes.push(target.hasAttribute("data-player-hud") ? "HUD" : "底部控制栏");
        }
      }
    });
    layers.forEach((layer) =>
      observer.observe(layer, { attributes: true, attributeFilter: ["data-visible"] }),
    );
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("waiting", onWaiting);
    const recordEvent = (event) => record(event.type);
    const settledEvents = ["seeked", "canplay", "playing", "pause"];
    settledEvents.forEach((type) => video.addEventListener(type, recordEvent));
    window.__keyboardSeekProbe = probe;
    window.__keyboardSeekCleanup = () => {
      observer.disconnect();
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("waiting", onWaiting);
      settledEvents.forEach((type) => video.removeEventListener(type, recordEvent));
      delete window.__keyboardSeekProbe;
      delete window.__keyboardSeekCleanup;
    };
  });

  const passed = [];
  const seek = async (key, direction, repeat = false, lateCompletion = false) => {
    const before = await page.evaluate(() => {
      Object.assign(window.__keyboardSeekProbe, { changes: [], seeks: 0, waiting: 0, events: [] });
      return document.querySelector("video").currentTime;
    });
    if (lateCompletion) {
      // 同一任务内开始真实 seek，再注入上一跳迟到的完成事件，稳定覆盖竞态。
      const seeking = await page.evaluate((key) => {
        const stage = document.querySelector("[data-player-stage]");
        const video = document.querySelector("video");
        stage.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
        if (!video.seeking) return false;
        video.dispatchEvent(new Event("waiting"));
        video.dispatchEvent(new Event("seeked"));
        video.dispatchEvent(new Event("playing"));
        return true;
      }, key);
      assert(seeking, "迟到完成事件用例没有进入真实 seeking 状态");
    } else if (repeat) {
      await page.keyboard.down(key);
      await page.keyboard.down(key);
      await page.keyboard.down(key);
      await page.keyboard.up(key);
    } else {
      await page.keyboard.press(key);
    }
    await page
      .waitForFunction(() => window.__keyboardSeekProbe.seeks > 0)
      .catch(() => {
        throw new Error(`${key} 没有触发 seeking 事件`);
      });
    await page.waitForFunction(() => {
      const video = document.querySelector("video");
      return !video.seeking && video.readyState >= 3;
    });
    await page.waitForTimeout(350);
    const after = await page.evaluate(() => ({
      ...window.__keyboardSeekProbe,
      time: document.querySelector("video").currentTime,
      paused: document.querySelector("video").paused,
      layers: [...document.querySelectorAll("[data-player-hud],[data-player-controls]")].map(
        (layer) => ({
          visible: layer.dataset.visible,
          hidden: layer.getAttribute("aria-hidden"),
          inert: layer.hasAttribute("inert"),
        }),
      ),
    }));
    assert(direction * (after.time - before) > 1, `${key} 未按预期方向跳转`);
    assert(!after.paused, `${key} 意外暂停`);
    assert(
      after.changes.length === 0,
      `${key} 唤醒了控制栏：${[...new Set(after.changes)].join("、")}；媒体事件：${JSON.stringify(after.events)}`,
    );
    assert(
      after.layers.every(
        (layer) => layer.visible === "false" && layer.hidden === "true" && layer.inert,
      ),
      `${key} 后显隐与无障碍状态不一致`,
    );
    passed.push({ key, repeat, lateCompletion, seeks: after.seeks, waiting: after.waiting });
  };

  try {
    await seek("ArrowLeft", -1);
    await seek("ArrowRight", 1);
    // Shift 路径由页面处理，不能只验证已被原生 Hotkey 消费的普通方向键。
    await seek("Shift+ArrowLeft", -1);
    await seek("Shift+ArrowRight", 1);
    await seek("ArrowLeft", -1, true);
    await seek("ArrowRight", 1, true);
    await seek("ArrowLeft", -1, false, true);
    await seek("ArrowRight", 1);

    // 鼠标仍能同时唤醒两层，方向键不强制收起已显示的控制栏。
    const box = await stage.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await waitForChrome(true);
    await page.keyboard.press("Space");
    await page.waitForFunction(() => document.querySelector("video").paused);
    await page.keyboard.press("ArrowLeft");
    await page.waitForFunction(() => !document.querySelector("video").seeking);
    await page.waitForTimeout(2300);
    await waitForChrome(true);
    assert(
      await page.evaluate(() => document.querySelector("video").paused),
      "暂停态跳转不应恢复播放",
    );
    passed.push("鼠标唤醒正常，暂停态跳转保留已显示的上下控制栏");

    const input = page.locator('[data-player-controls] input[type="text"]');
    if ((await input.count()) && (await input.isEnabled())) {
      await input.focus();
      const before = await page.evaluate(() => {
        window.__keyboardSeekProbe.seeks = 0;
        return document.querySelector("video").currentTime;
      });
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(300);
      const after = await page.evaluate(() => ({
        time: document.querySelector("video").currentTime,
        seeks: window.__keyboardSeekProbe.seeks,
      }));
      assert(after.time === before && after.seeks === 0, "输入框内方向键不应跳转视频");
      await waitForChrome(true);
      passed.push("弹幕输入框内方向键不跳转、不收起控制栏");
    }
    return { passed };
  } catch (error) {
    throw new Error(`${error.message}；已完成：${JSON.stringify(passed)}`);
  } finally {
    await page.evaluate(() => window.__keyboardSeekCleanup());
    await stage.focus();
    const paused = await page.evaluate(() => document.querySelector("video").paused);
    if (paused !== initial.paused) await page.keyboard.press("Space");
  }
}
