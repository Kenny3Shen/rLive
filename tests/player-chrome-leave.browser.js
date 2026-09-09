// 真实鼠标与触摸事件驱动 usePlayerChromeIdle 的「鼠标移出播放器区域立即收起」契约。
// 先启动 vite（bun run dev），再执行（iPhone 仿真提供真实 touchscreen）：
//   playwright-cli -s=chrome-leave open --device "iPhone 15" http://localhost:5173/tests/browser/player-chrome-leave.html
//   playwright-cli -s=chrome-leave run-code --filename=tests/player-chrome-leave.browser.js
async (page) => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  /** 空闲隐藏延迟为 2000ms，立即路径的判定窗口必须明显小于它。 */
  const IDLE_MS = 2000;
  const state = () =>
    page.evaluate(() => {
      const hud = document.querySelector("[data-player-hud]");
      const controls = document.querySelector("[data-player-controls]");
      return {
        hud: hud.dataset.visible,
        controls: controls.dataset.visible,
        hudInert: hud.hasAttribute("inert"),
        hudAriaHidden: hud.getAttribute("aria-hidden"),
      };
    });
  const chromeVisible = async () => {
    const s = await state();
    return s.hud === "true" && s.controls === "true";
  };
  const waitForLayers = async (expected, timeout, label) => {
    await page.waitForFunction(
      (value) => {
        const hud = document.querySelector("[data-player-hud]");
        const controls = document.querySelector("[data-player-controls]");
        return hud.dataset.visible === value && controls.dataset.visible === value;
      },
      expected,
      { timeout, polling: 50 },
    ).catch(() => {
      throw new Error(`等待超时：${label}`);
    });
  };

  const stage = page.locator("[data-player-stage]");
  await stage.waitFor();
  const box = await stage.boundingBox();
  const inside = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const viewport = page.viewportSize();
  const below = box.y + box.height + 60;
  const outside =
    below < viewport.height - 10
      ? { x: box.x + box.width / 2, y: below }
      : { x: Math.max(10, box.x - 60), y: box.y + box.height / 2 };
  const passed = [];

  // 1) 鼠标进入舞台唤醒两层 chrome。
  await page.mouse.move(inside.x, inside.y);
  await waitForLayers("true", 1000, "鼠标进入后 chrome 可见");
  passed.push("鼠标进入舞台唤醒 HUD 与控制条");

  // 2) 鼠标移出播放器区域立即收起：空闲路径需要 2000ms，这里 1200ms 内必须完成。
  const leaveAt = Date.now();
  await page.mouse.move(outside.x, outside.y);
  await waitForLayers("false", 1200, "鼠标离开后立即收起");
  assert(Date.now() - leaveAt < IDLE_MS, "鼠标离开未立即收起（疑似仍走空闲倒计时）");
  const hiddenState = await state();
  assert(hiddenState.hudInert && hiddenState.hudAriaHidden === "true", "收起未同步 inert / aria-hidden");
  passed.push(`鼠标移出播放器区域立即收起（耗时 ${Date.now() - leaveAt}ms < ${IDLE_MS}ms 空闲）`);

  // 3) 再次进入舞台可以重新唤醒。
  await page.mouse.move(inside.x, inside.y);
  await waitForLayers("true", 1000, "再次进入唤醒 chrome");
  passed.push("再次进入舞台重新唤醒 chrome");

  // 4) keepVisible（暂停/缓冲/失败/弹层打开的等价开关）：离场不收起。
  await page.evaluate(() => window.__chromeLeave.setKeepVisible(true));
  await page.mouse.move(outside.x, outside.y);
  await page.waitForTimeout(800);
  assert(await chromeVisible(), "keepVisible 时鼠标离场不应收起");
  await page.evaluate(() => window.__chromeLeave.setKeepVisible(false));
  passed.push("keepVisible 守卫生效：离场保持可见");

  // 5) 键盘焦点落在 chrome 内（弹幕输入/控制按钮）：离场不收起。
  await page.mouse.move(inside.x, inside.y);
  await waitForLayers("true", 1000, "焦点用例前置唤醒");
  await page.keyboard.press("Tab");
  assert(
    await page.evaluate(() => {
      const el = document.activeElement;
      return el instanceof HTMLElement && el.matches(":focus-visible");
    }),
    "Tab 未把焦点送进 chrome 按钮",
  );
  await page.mouse.move(outside.x, outside.y);
  await page.waitForTimeout(800);
  assert(await chromeVisible(), "键盘焦点在 chrome 内时鼠标离场不应收起");
  await page.evaluate(() => document.activeElement?.blur());
  passed.push("键盘焦点守卫生效：离场保持可见");

  // 6) 触摸指针抬手触发的 pointerleave 回落空闲倒计时：不得立即收起，
  //    否则移动端单击唤醒的 chrome 会在松手瞬间被吞掉。
  await page.mouse.move(inside.x, inside.y);
  await waitForLayers("true", 1000, "触摸用例前置唤醒");
  await page.touchscreen.tap(inside.x, inside.y);
  await page.waitForTimeout(1000);
  assert(await chromeVisible(), "触摸离场不应立即收起（pointerType 守卫失效）");
  await waitForLayers("false", 2600, "触摸离场后的空闲收起");
  passed.push("触摸指针离场回落空闲倒计时，1s 内保持可见、2s 后收起");

  // 7) 真实视频播放页（浏览器预览无后端，处于加载/错误态即 keepVisible）：
  //    鼠标离场不收起 HUD，且页面无异常，证明接线与守卫在真实页面上成立。
  const origin = await page.evaluate(() => location.origin);
  await page.goto(
    `${origin}/video/play?bvid=BV1xx411c7mD&cid=123&aid=456&title=${encodeURIComponent("HUD 离场守卫")}`,
  );
  await page.waitForSelector("[data-player-stage] [data-player-hud]", { timeout: 20000 });
  const videoBox = await page.locator("[data-player-stage]").boundingBox();
  const videoInside = { x: videoBox.x + videoBox.width / 2, y: videoBox.y + videoBox.height / 2 };
  const videoBelow = videoBox.y + videoBox.height + 60;
  const videoOutside =
    videoBelow < viewport.height - 10
      ? { x: videoBox.x + videoBox.width / 2, y: videoBelow }
      : { x: Math.max(10, videoBox.x - 60), y: videoBox.y + videoBox.height / 2 };
  await page.mouse.move(videoInside.x, videoInside.y);
  await page.mouse.move(videoOutside.x, videoOutside.y);
  await page.waitForTimeout(900);
  const hudVisible = await page.evaluate(
    () => document.querySelector("[data-player-hud]").dataset.visible,
  );
  assert(hudVisible === "true", "加载/错误态（keepVisible）下鼠标离场不应收起 HUD");
  passed.push("真实视频页离场接线无异常，错误态守卫保持 HUD 可见");

  return { viewport, passed };
}
