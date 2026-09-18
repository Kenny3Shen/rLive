// 在 Vite 页上测量短视频顶部控制栏、安全区及圆形按钮样式（IPC 为本地桩）：
// playwright-cli -s=shorts-safe-area open --mobile http://localhost:1420/
// playwright-cli -s=shorts-safe-area run-code --filename=tests/shorts-top-bar-safe-area.browser.js
//
// 锁的是一条纯几何契约：状态栏的让位由 `.app-shell` 的 `padding-top` 统一做，短视频
// 这一层不能再消费一次顶部安全区。改前两处各留一份，顶部控制栏落在状态栏下方又一条
// 的位置，中间空出一条状态栏高的黑带 —— 那正是本夹具要挡住的回归。
//
// Android 的真值由 `MainActivity` 注入成 `--android-safe-area-top`（WebView 的
// `env(safe-area-inset-*)` 会读成 0），因此浏览器里直接写这个变量 + `data-platform`
// 就能复刻真机几何，不需要真机也不需要带刘海的设备描述。
async (page) => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const STATUS_BAR_PX = 40;
  const GESTURE_BAR_PX = 16;
  const TOP_BAR_PX = 52; // SHORTS_TOP_BAR_HEIGHT_PX

  await page.addInitScript(() => {
    // `isTauri()` 读 `window.isTauri`；缺了它 `invokeCmd` 会在发请求前就抛「未连接客户端」。
    window.isTauri = true;
    // 事件插件的内部桩：缺了它，页面卸载时 `unlisten` 会在控制台抛一串
    // `unregisterListener of undefined`（夹具不需要事件，给个空实现即可）。
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    let nextCallback = 1;
    const story = [
      {
        bvid: "BV1a",
        aid: "1",
        cid: 41_855_094_127,
        title: "竖屏第一条",
        cover: "http://i0.hdslb.com/bfs/storyff/a.jpg",
        author: "测试 UP 主",
        author_face: null,
        author_fans: 11389,
        duration: 93,
        view: 187_172,
        danmaku: 24,
        pubdate: 1_789_292_152,
        rcmd_reason: null,
        dimension: { width: 1080, height: 1920, rotate: 0 },
      },
      {
        bvid: "BV1b",
        aid: "2",
        cid: 41_855_094_128,
        title: "竖屏第二条",
        cover: "http://i0.hdslb.com/bfs/storyff/b.jpg",
        author: "另一个 UP",
        author_face: null,
        author_fans: 520,
        duration: 61,
        view: 1024,
        danmaku: 3,
        pubdate: 1_789_292_200,
        rcmd_reason: null,
        dimension: { width: 1080, height: 1920, rotate: 0 },
      },
    ];
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => nextCallback++,
      unregisterCallback: () => {},
      invoke: async (command) => {
        // 设置按「没有客户端」处理：store 认这个 code 就退回默认值，夹具因此不必
        // 复制一整份 AppSettings（少一处会随后端 schema 漂移的重复）。
        if (command === "settings_get") {
          throw { code: "tauri_unavailable", message: "夹具无后端", site: null, retryable: false };
        }
        // 固定夹具只有两条，不可宣称还有下一页，否则预取会无限重复同一批。
        if (command === "video_get_story") return { has_more: false, items: story };
        if (command === "video_get_danmaku") return { segment_index: 0, entries: [] };
        if (command === "video_get_play_info") throw "测试环境不取流";
        return null;
      },
    };
  });

  // 端口不写死：用已打开页面（Vite 页）的 origin。
  const origin = page.url().replace(/\/[^/]*$/, "");
  await page.goto(`${origin}/shorts`);
  await page.reload();
  await page.waitForSelector('[data-slot="shorts-top-bar"]', { timeout: 15000 });

  // 复刻 Android edge-to-edge：原生注入的安全区 + 平台标记（`.app-shell` 的
  // `padding-top` 只在 `html[data-platform="android"]` 下取原生变量）。
  await page.evaluate(
    ({ top, bottom }) => {
      document.documentElement.dataset.platform = "android";
      document.documentElement.style.setProperty("--android-safe-area-top", `${top}px`);
      document.documentElement.style.setProperty("--android-safe-area-bottom", `${bottom}px`);
    },
    { top: STATUS_BAR_PX, bottom: GESTURE_BAR_PX },
  );
  await page.waitForTimeout(500);

  const report = await page.evaluate(() => {
    const rect = (node) => {
      if (!node) return null;
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    };
    const shell = document.querySelector(".app-shell");
    const topBar = document.querySelector('[data-slot="shorts-top-bar"]');
    return {
      shellPaddingTop: shell ? Number.parseFloat(getComputedStyle(shell).paddingTop) : null,
      shell: rect(shell),
      viewport: rect(document.querySelector('[data-slot="shorts-viewport"]')),
      topBar: rect(topBar),
      back: rect(topBar?.querySelector('button[aria-label="返回上一页"]')),
      more: rect(topBar?.querySelector('button[aria-label="更多操作"]')),
      topIcons: [...topBar.querySelectorAll("button svg")].map(rect),
      // 条带里每个槽位/占位面板各有一块画面区（相邻条目在视口之外等着被滑进来），
      // 因此全量量出来，由断言挑当前可见的那一块。
      mediaAreas: [...document.querySelectorAll('[data-slot="shorts-media-area"]')].map(rect),
      bottomBar: rect(document.querySelector('[data-slot="shorts-bottom-bar"]')),
      // 底栏那颗图标按钮与它左边的弹幕输入框：顶部按钮要与它们同高。
      composerInput: rect(document.querySelector('[data-slot="shorts-bottom-bar"] input')),
      bottomIconButtons: [
        ...document.querySelectorAll('[data-slot="shorts-bottom-bar"] button'),
      ]
        .filter((button) => button.getBoundingClientRect().width > 36)
        .map((button) => ({ label: button.getAttribute("aria-label"), ...rect(button) })),
      innerHeight: window.innerHeight,
    };
  });

  const near = (actual, expected, tolerance = 1.5) => Math.abs(actual - expected) <= tolerance;

  // 触摸设备上底栏按钮会被基础组件的 `[@media(pointer:coarse)]:min-h-11` 抬到 44px，
  // 顶部按钮与它们同档：断言因此要跟着设备能力走。
  const coarsePointer = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  const controlSize = coarsePointer ? 44 : 40;

  /* ---------- 1. 外壳让位一次，且只有一次 ---------- */
  assert(
    near(report.shellPaddingTop, STATUS_BAR_PX),
    `外壳应按状态栏高度预留，实测 padding-top=${report.shellPaddingTop}`,
  );
  assert(
    near(report.viewport.y, STATUS_BAR_PX),
    `短视频视口顶边应落在状态栏下沿，实测 y=${report.viewport.y}`,
  );

  /* ---------- 2. 控制栏紧贴状态栏下沿 ---------- */
  assert(
    near(report.topBar.y, STATUS_BAR_PX),
    `顶部控制栏应紧贴状态栏下沿，实测 y=${report.topBar.y}`,
  );
  assert(
    near(report.topBar.height, TOP_BAR_PX),
    `顶部控制栏高度应为 ${TOP_BAR_PX}px（不再叠加安全区），实测 ${report.topBar.height}`,
  );
  // 改前返回箭头被推到 `状态栏 + 状态栏 + 4px`；这条断言就是那条黑带的探针。
  assert(
    report.back.y - report.viewport.y < 10,
    `返回箭头应落在视口顶部这一条里，实测距视口顶 ${report.back.y - report.viewport.y}px`,
  );
  assert(
    report.back.y + report.back.height <= report.topBar.y + report.topBar.height + 1,
    "返回箭头应完整落在控制栏高度内",
  );
  assert(
    near(
      report.back.y - report.topBar.y,
      report.topBar.y + report.topBar.height - (report.back.y + report.back.height),
    ),
    "返回箭头应在控制栏里垂直居中",
  );
  // 右端的「更多」与返回箭头同一条基线：一边跑了就是栏高与内边距又分叉了。
  assert(
    report.more && near(report.more.y, report.back.y),
    `更多按钮应与返回箭头同高，实测 ${JSON.stringify(report.more)}`,
  );

  for (const [label, button] of [["返回", report.back], ["更多", report.more]]) {
    assert(
      button && near(button.width, controlSize) && near(button.height, controlSize),
      `${label}按钮应与底栏控件同为 ${controlSize}px，实测 ${JSON.stringify(button)}`,
    );
  }
  assert(
    report.topIcons.length === 2 && report.topIcons.every((icon) => near(icon.width, 24) && near(icon.height, 24)),
    `顶部图标应统一为 24px，实测 ${JSON.stringify(report.topIcons)}`,
  );

  /* ---------- 3. 画面区从视口顶边开始 ---------- */
  const activeMedia = report.mediaAreas.find(
    (area) => area.y < report.viewport.y + report.viewport.height && area.y + area.height > report.viewport.y,
  );
  assert(activeMedia, `应有一块画面区落在视口内，实测 ${JSON.stringify(report.mediaAreas)}`);
  assert(
    near(activeMedia.y, report.viewport.y),
    `画面区应从视口顶边开始，实测 y=${activeMedia.y}（视口 ${report.viewport.y}）`,
  );

  /* ---------- 4. 底部相反：手势条必须由本页让位 ---------- */
  const viewportBottom = report.viewport.y + report.viewport.height;
  const bottomBarBottom = report.bottomBar.y + report.bottomBar.height;
  assert(
    near(bottomBarBottom, viewportBottom),
    `底栏应贴到视口底边，实测 ${bottomBarBottom} vs ${viewportBottom}`,
  );
  assert(
    near(bottomBarBottom - report.bottomBar.y, 59 + GESTURE_BAR_PX),
    `底栏应把手势条高度算进自己的高度，实测 ${report.bottomBar.height}`,
  );

  /* ---------- 5. 图标按钮的悬停背景必须是圆形 ---------- */
  const labels = [
    "返回上一页",
    "更多操作",
    "评论与弹幕，弹幕 24 条",
    "关闭弹幕",
    "隐藏视频信息与评论按钮",
    "视频详情",
  ];
  const hoverSupported = await page.evaluate(() => matchMedia("(hover: hover)").matches);
  report.buttons = [];
  for (const label of labels) {
    const button = page.getByRole("button", { name: label, exact: true });
    if (hoverSupported) await button.hover();
    const measure = () => button.evaluate((node) => {
      const { width, height } = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const icon = node.querySelector("svg")?.getBoundingClientRect();
      return {
        width,
        height,
        radii: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius],
        background: style.backgroundColor,
        icon: icon ? { width: icon.width, height: icon.height } : null,
      };
    });
    // 等 hover 的颜色过渡结束，再比较左右两个 HUD 按钮的反馈。
    if (hoverSupported) {
      await page.waitForFunction((label) => {
        const node = [...document.querySelectorAll("button")].find((node) => node.getAttribute("aria-label") === label);
        return node && getComputedStyle(node).backgroundColor !== "rgba(0, 0, 0, 0)";
      }, label);
      await button.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
    }
    const style = await measure();
    assert(near(style.width, style.height), `${label}按钮应为正方形命中区`);
    assert(
      style.radii.every((radius) => Number.parseFloat(radius) >= style.width / 2),
      `${label}按钮悬停背景应为圆形，实测 ${JSON.stringify(style)}`,
    );
    const expectedSize = label === "评论与弹幕，弹幕 24 条" ? 44 : controlSize;
    assert(near(style.width, expectedSize), `${label}按钮应保持 ${expectedSize}px`);
    report.buttons.push({ label, ...style });
  }
  if (hoverSupported) {
    assert(report.buttons[0].background === report.buttons[1].background, "返回与更多的悬停填充应一致");
  }

  // 上下的尺寸对齐：顶栏的返回/更多就是底栏图标按钮那一档，也与弹幕输入框同高。
  assert(report.composerInput, "底栏应有弹幕输入框");
  for (const [label, button] of [["返回", report.back], ["更多", report.more]]) {
    assert(
      near(button.height, report.composerInput.height),
      `${label}按钮应与弹幕输入框同高，实测 ${button.height} vs ${report.composerInput.height}`,
    );
  }
  for (const bottom of report.bottomIconButtons) {
    assert(
      near(bottom.height, report.back.height) && near(bottom.height, report.more.height),
      `底栏「${bottom.label}」应与顶部按钮同高，实测 ${bottom.height} vs ${report.back.height}`,
    );
  }

  // 确认放大后桌面 Popover 与紧凑抽屉触发器仍能打开菜单。
  await page.getByRole("button", { name: "更多操作", exact: true }).click();
  await page.getByRole("button", { name: "静音", exact: true }).waitFor({ state: "visible" });
  assert(
    await page.locator('[data-slot="shorts-top-bar"] button[aria-label="更多操作"]').getAttribute("aria-expanded") === "true",
    "更多菜单应能正常展开",
  );

  return report;
}
