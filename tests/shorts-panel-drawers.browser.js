// 在 Vite 预览页测量「一级评论抽屉」与「二级回复抽屉」是否完全重合（IPC 为本地桩）：
// playwright-cli -s=shorts-drawers run-code --filename=tests/shorts-panel-drawers.browser.js
async (page) => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const settle = async () => {
    await page.waitForTimeout(400);
  };

  // 在页面模块加载前桩掉 IPC：评论区要真发请求才能拿到「共 N 条回复」入口。
  await page.addInitScript(() => {
    // `isTauri()` 读的是 `window.isTauri` 这个全局（不是 `__TAURI_INTERNALS__`），
    // 缺了它 `invokeCmd` 会在发请求之前就抛「未连接客户端」。
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

  // 端口不写死：用已打开页面（Vite 预览页）的 origin，免得 1420 被占时整段跑不起来。
  const origin = page.url().replace(/\/[^/]*$/, "");
  await page.goto(`${origin}/tests/browser/shorts-panel-drawers.html`);
  // `addInitScript` 只对**之后**的导航生效：第一次 goto 时桩还没注入（评论区会显示
  // 「未连接 rLive 客户端」），因此注入后必须再导航一次。
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__drawerGeometry));
  await settle();

  const comments = await page.evaluate(
    () => document.querySelectorAll('[role="dialog"]').length,
  );
  assert(comments >= 1, "评论抽屉没渲染出来");

  const report = {};

  /* ---------- 桌面：右侧滑入，两层同宽同位置 ---------- */
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => window.__drawerGeometry.render(false));
  await settle();
  await page.evaluate(() => window.__drawerGeometry.openReplies());
  await settle();

  let boxes = await page.evaluate(() => window.__drawerGeometry.boxes());
  report.desktop = boxes;
  assert(boxes.length === 2, `桌面上应当有两层抽屉，实测 ${boxes.length}`);
  const [first, second] = boxes;
  assert(
    first.side === "right" && second.side === "right",
    `桌面两层都应从右侧滑入，实测 ${first.side} / ${second.side}`,
  );
  assert(
    Math.abs(first.width - second.width) < 1,
    `桌面两层宽度应一致，实测 ${first.width} vs ${second.width}`,
  );
  assert(
    Math.abs(first.x - second.x) < 1 && Math.abs(first.y - second.y) < 1,
    `桌面两层应完全重合，实测 (${first.x},${first.y}) vs (${second.x},${second.y})`,
  );
  assert(
    Math.abs(first.height - second.height) < 1,
    `桌面两层高度应一致，实测 ${first.height} vs ${second.height}`,
  );
  // 22rem = 352px；基础组件的 right 变体是 20rem（320px），这就是原来那条缝。
  assert(Math.abs(first.width - 352) < 1, `桌面宽度应为 22rem(352px)，实测 ${first.width}`);

  /* ---------- 手机：底部弹出，两层同高同位置 ---------- */
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.__drawerGeometry.render(true));
  await settle();
  await page.evaluate(() => window.__drawerGeometry.openReplies());
  await settle();

  boxes = await page.evaluate(() => window.__drawerGeometry.boxes());
  report.compact = boxes;
  const [mobileFirst, mobileSecond] = boxes;
  assert(
    mobileFirst.side === "bottom" && mobileSecond.side === "bottom",
    `手机两层都应从底部弹出，实测 ${mobileFirst.side} / ${mobileSecond.side}`,
  );
  assert(
    Math.abs(mobileFirst.y - mobileSecond.y) < 1 &&
      Math.abs(mobileFirst.height - mobileSecond.height) < 1,
    `手机两层应完全重合，实测 y ${mobileFirst.y} vs ${mobileSecond.y}、h ${mobileFirst.height} vs ${mobileSecond.height}`,
  );
  // 70dvh：与一级抽屉同高，否则二级会露出上面一层。
  assert(
    Math.abs(mobileFirst.height - 844 * 0.7) < 2,
    `手机抽屉高度应为 70dvh，实测 ${mobileFirst.height}`,
  );
  assert(
    Math.abs(mobileFirst.width - 390) < 1,
    `手机抽屉应通栏，实测 ${mobileFirst.width}`,
  );

  /* ---------- 底部形态下二级回复要自己让出安全区 ---------- */
  // 二级抽屉是与一级并列的浮层（不是它的后代），拿不到一级外壳补的安全区，
  // 少了这一步手机上最后一条回复会压在系统手势条下面。
  const padding = await page.evaluate(() => window.__drawerGeometry.repliesScrollPaddingBottom());
  report.compactRepliesPadding = padding;
  assert(padding === "12px", `手机二级回复应让位安全区，实测 paddingBottom=${padding}`);

  return report;
}
