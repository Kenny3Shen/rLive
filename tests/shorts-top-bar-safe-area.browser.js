// 在 Vite 页上测量短视频顶部控制栏与系统状态栏的相对位置（IPC 为本地桩）：
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
        if (command === "video_get_story") return { has_more: true, items: story };
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
      // 条带里每个槽位/占位面板各有一块画面区（相邻条目在视口之外等着被滑进来），
      // 因此全量量出来，由断言挑当前可见的那一块。
      mediaAreas: [...document.querySelectorAll('[data-slot="shorts-media-area"]')].map(rect),
      bottomBar: rect(document.querySelector('[data-slot="shorts-bottom-bar"]')),
      innerHeight: window.innerHeight,
    };
  });

  const near = (actual, expected, tolerance = 1.5) => Math.abs(actual - expected) <= tolerance;

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

  return report;
}
