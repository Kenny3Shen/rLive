// 移动端二级回复抽屉：打开期间点抽屉之外（播放页里就是播放器）不应再把它收掉，
// 只有返回按钮与系统返回手势（合成 Escape）才退回一级。
//
// 跑法（先启动 vite 并打开预览页）：
//   playwright-cli -s=shorts-drawers run-code --filename=tests/shorts-replies-outside-press.browser.js
async (page) => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const settle = async () => {
    await page.waitForTimeout(700);
  };

  await page.addInitScript(() => {
    // 二级回复抽屉只在触摸客户端存在（`isMobileClient()`）：`userAgentData.platform`
    // 优先于 `userAgent`，而 Chromium 的它是真实平台，因此两个都要桩。
    Object.defineProperty(navigator, "userAgent", {
      get: () =>
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36",
      configurable: true,
    });
    Object.defineProperty(navigator, "userAgentData", {
      get: () => ({ platform: "Android", mobile: true }),
      configurable: true,
    });
    window.isTauri = true;
    let nextCallback = 1;
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => nextCallback++,
      unregisterCallback: () => {},
      invoke: async (command) => {
        if (command === "video_get_comments") {
          return {
            items: [
              {
                rpid: 1,
                mid: "100",
                uname: "测试 UP",
                avatar: null,
                level: 0,
                message: "一级评论",
                emotes: [],
                pictures: [],
                like: 12,
                ctime: 1_789_292_152,
                rcount: 2,
                is_upper: false,
                replies: [
                  {
                    rpid: 2,
                    mid: "101",
                    uname: "路人",
                    avatar: null,
                    level: 0,
                    message: "回复一条",
                    emotes: [],
                    pictures: [],
                    like: 1,
                    ctime: 1_789_292_200,
                    rcount: 0,
                    replies: [],
                    is_upper: false,
                  },
                ],
              },
            ],
            has_more: false,
            next: 0,
            all_count: 1,
          };
        }
        if (command === "video_get_comment_replies") {
          return {
            items: [
              {
                rpid: 2,
                mid: "101",
                uname: "路人",
                avatar: null,
                level: 0,
                message: "回复一条",
                emotes: [],
                pictures: [],
                like: 1,
                ctime: 1_789_292_200,
                rcount: 0,
                replies: [],
                is_upper: false,
              },
            ],
            has_more: false,
            next: 2,
            all_count: 2,
          };
        }
        return null;
      },
    };
  });

  // 端口不写死，取页面自己的 origin（驱动环境没有全局 `URL`）。
  const origin = await page.evaluate(() => window.location.origin);
  await page.goto(`${origin}/tests/browser/shorts-panel-drawers.html`);
  // `addInitScript` 只对之后的导航生效，注入后必须再导航一次。
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__drawerGeometry));
  await settle();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.__drawerGeometry.render(true));
  await settle();
  await page.evaluate(() => window.__drawerGeometry.openReplies());
  await settle();

  const layers = () => page.evaluate(() => document.querySelectorAll('[role="dialog"]').length);
  assert((await layers()) === 2, "二级回复抽屉没打开");

  /* ---------- 点抽屉之外：不该关 ---------- */
  // 在最外层合成一次触摸点按：播放页里那块区域正是播放器（抽屉挂在侧栏的
  // `DrawerViewport`，与舞台是两条 DOM 分支）。
  await page.evaluate(() => {
    const init = {
      pointerId: 991,
      pointerType: "touch",
      isPrimary: true,
      clientX: 10,
      clientY: 10,
      bubbles: true,
      cancelable: true,
      button: 0,
    };
    document.body.dispatchEvent(new PointerEvent("pointerdown", init));
    document.body.dispatchEvent(new PointerEvent("pointerup", init));
    document.body.dispatchEvent(new MouseEvent("click", { ...init }));
  });
  await settle();
  const afterOutside = await layers();
  assert(afterOutside === 2, `点播放器不应收起二级回复，实测 ${afterOutside} 层`);

  /* ---------- 系统返回（合成 Escape）：必须能收 ---------- */
  // Android 返回键经 `dismissTopmostPopup` 派发的就是它；不冒泡，与页面侧一致。
  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: false })),
  );
  await settle();
  const afterEscape = await layers();
  assert(afterEscape === 1, `系统返回应收起二级回复，实测 ${afterEscape} 层`);

  return { afterOutside, afterEscape };
}
