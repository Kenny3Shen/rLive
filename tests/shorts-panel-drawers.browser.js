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
    // 二级回复抽屉只在触摸客户端存在：桌面端改成就地展开，量不到第二层浮层。
    // UA 与 viewport 分开桩，因为「手机视口 + 桌面 UA」正是要覆盖的分叉组合之一。
    //
    // `userAgentData.platform` 优先于 `userAgent`（见 `getClientPlatform`），而
    // Chromium 的它是真实平台、不随 UA 覆盖变化，因此两个都要桩。
    Object.defineProperty(navigator, "userAgent", {
      get: () => window.__mobileUA ?? "Mozilla/5.0 (X11; Linux x86_64) desktop-ua",
      configurable: true,
    });
    Object.defineProperty(navigator, "userAgentData", {
      get: () =>
        window.__mobileUA
          ? { platform: "Android", mobile: true }
          : { platform: "Linux", mobile: false },
      configurable: true,
    });
    // `isTauri()` 读的是 `window.isTauri` 这个全局（不是 `__TAURI_INTERNALS__`），
    // 缺了它 `invokeCmd` 会在发请求之前就抛「未连接客户端」。
    window.isTauri = true;
    // null = 桌面 UA；下面手机段切成 Android UA。
    window.__mobileUA = null;
    // 每次回复请求记下 (pn, ps)：桌面端分页与移动端无限滚动的页大小不同（10 / 20）。
    window.__replyRequests = [];
    let nextCallback = 1;
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => nextCallback++,
      unregisterCallback: () => {},
      invoke: async (command, args) => {
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
          window.__replyRequests.push({ pn: args?.page ?? null, ps: args?.pageSize ?? null });
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
            has_more: (args?.page ?? 1) < 5,
            next: 2,
            all_count: 42,
          };
        }
        return null;
      },
    };
  });

  // 端口不写死：用已打开页面（Vite 预览页）的 origin，免得默认端口被占时整段跑
  // 不起来。取 origin 而不是截掉最后一段路径：`page.url()` 可能是深层路由，截路径
  // 会拼出一条嵌套重复的夹具路径。
  // 用页面自己的 location 拼：驱动脚本的运行环境没有全局 `URL`，而 `page.url()`
  // 可能是深层路由，截路径会拼出一条嵌套重复的夹具路径。
  const origin = await page.evaluate(() => window.location.origin);
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
  // 二级抽屉只在触摸客户端存在，因此这一段的 UA 桩成 Android —— 它测的是两层浮层
  // 的几何重合，与「桌面端改成就地展开」是两件事。
  await page.evaluate(() => window.__drawerGeometry.setMobile(true));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => window.__drawerGeometry.render(false));
  await settle();
  await page.evaluate(() => window.__drawerGeometry.openReplies());
  await settle();

  assert(
    await page.evaluate(() => window.__replyRequests.at(-1)?.ps ?? null) === null,
    "移动端二级回复应走后端默认页大小（不传 ps）",
  );

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

  assert(
    await page.evaluate(() => window.__replyRequests.at(-1)?.ps ?? null) === null,
    "移动端二级回复应走后端默认页大小（不传 ps）",
  );

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

  /* ---------- 桌面 UA：不叠第二层浮层，就地展开分页（每页 10） ---------- */
  await page.evaluate(() => window.__drawerGeometry.setMobile(false));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    window.__replyRequests.length = 0;
    window.__drawerGeometry.render(false);
  });
  await settle();
  await page.evaluate(() => window.__drawerGeometry.openReplies());
  await settle();

  boxes = await page.evaluate(() => window.__drawerGeometry.boxes());
  assert(boxes.length === 1, `桌面端不应叠第二层抽屉，实测 ${boxes.length}`);

  const inline = await page.evaluate(() => window.__drawerGeometry.inlineReplies());
  report.inline = inline;
  assert(inline, "桌面端应就地展开回复块");
  // 不断言「不在抽屉里」：本夹具本身就把评论区挂在一级评论抽屉内部（短视频就是
  // 这么接的），就地展开的回复块必然是它的后代。分端的落点是「有没有第二层浮层」。
  assert(inline.hasPager, `桌面端回复块应有分页条，实测 ${inline.text}`);

  const firstRequest = await page.evaluate(() => window.__replyRequests[0] ?? null);
  report.inlineFirstRequest = firstRequest;
  assert(
    firstRequest?.pn === 1 && firstRequest?.ps === 10,
    `桌面端首次应请求 pn=1&ps=10，实测 ${JSON.stringify(firstRequest)}`,
  );
  // 首条回复应当真的画出来了（分页块不是空壳）。
  assert(inline.text.includes("回复一条"), `桌面端应渲染回复内容，实测 ${inline.text}`);

  /* ---------- 桌面端翻页：下一页 → pn=2，上一页 → pn=1 且按钮置灰 ---------- */
  await page.evaluate(() => window.__drawerGeometry.clickPageButton(/下一页回复/));
  await settle();
  assert(
    await page.evaluate(() => window.__replyRequests.at(-1)?.pn) === 2,
    "点下一页应请求 pn=2",
  );
  let pager = await page.evaluate(() => window.__drawerGeometry.inlineReplies());
  assert(pager.text.includes("第 2 / 5 页"), `应显示第 2 页，实测 ${pager.text}`);

  await page.evaluate(() => window.__drawerGeometry.clickPageButton(/上一页回复/));
  await settle();
  assert(
    await page.evaluate(() => window.__replyRequests.at(-1)?.pn) === 1,
    "点上一页应回到 pn=1",
  );
  pager = await page.evaluate(() => window.__drawerGeometry.inlineReplies());
  assert(
    pager.buttons.find((b) => /上一页回复/.test(b.label ?? ""))?.disabled === true,
    "第 1 页的上一页应置灰",
  );

  /* ---------- 桌面端再点同一条即收起 ---------- */
  // 收起态的入口是「共 N 条回复」；展开后它让位给完整列表，因此这里改点一级
  // 评论的正文（同一个开关的另一个落点）。
  await page.evaluate(() => {
    const body = [...document.querySelectorAll("button")].find((node) =>
      /查看 .* 的评论详情/.test(node.getAttribute("aria-label") ?? ""),
    );
    if (!body) throw new Error("未找到评论正文按钮");
    body.click();
  });
  await settle();
  assert(
    await page.evaluate(() => window.__drawerGeometry.inlineReplies()) === null,
    "再点同一条应收起展开块",
  );
  assert(
    await page.evaluate(() => window.__drawerGeometry.hasRepliesEntry()),
    "收起后「共 N 条回复」入口应回来",
  );

  return report;
}
