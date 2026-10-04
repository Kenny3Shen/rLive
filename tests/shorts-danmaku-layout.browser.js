// 竖屏流弹幕层的几何契约。断言渲染后的矩形与计算样式，不比对类名：
//
//   1. 16:9 源：弹幕层顶边在**顶部控制栏下沿**（相对画面区顶边），首轨不穿过返回/
//      更多按钮 —— 弹幕列与画面框平级、起点固定，正是这次修复的核心；
//   2. 竖屏源（铺满）：同一条约定不变 —— 控制栏压在画面顶部这一条上；
//   3. 横屏源的画面框偏上（顶偏移 < 留白的一半，不再是垂直居中），而竖屏源贴顶；
//   4. 弹幕列宽度等于画面框宽、水平居中（宽屏上画面收成竖卡时，弹幕不会飘到两侧黑边）；
//   5. 弹幕字号按 `SHORTS_DANMAKU_FONT_SCALE`（0.85）缩过一档，不是全应用设置的原值。
//
// 只桩 IPC，不访问真实站点，也不起真实播放：媒体桩只喂 `currentTime` / `paused`。
//
// 用手机视口跑（`open --mobile`）：字号断言读的是移动端默认值（`(pointer: coarse)`
// → 16px），且竖屏源的「贴顶」分支本来就是手机形态。
// 用法：playwright-cli -s=shorts-danmaku open --mobile http://127.0.0.1:1420/ && \
//      playwright-cli -s=shorts-danmaku run-code --filename=tests/shorts-danmaku-layout.browser.js
// oxlint-disable-next-line no-unused-expressions -- run-code 要求顶层函数表达式。
async (page) => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const TOP_BAR_PX = 52; // SHORTS_TOP_BAR_HEIGHT_PX
  const FONT_SCALE = 0.85; // SHORTS_DANMAKU_FONT_SCALE

  const story = (aspect) => [
    {
      bvid: "BV1a",
      aid: "1",
      cid: 41_855_094_127,
      title: aspect === "landscape" ? "横屏第一条" : "竖屏第一条",
      cover: "http://i0.hdslb.com/bfs/storyff/a.jpg",
      author: "测试 UP 主",
      author_face: null,
      author_fans: 11389,
      duration: 93,
      view: 187_172,
      danmaku: 24,
      reply: 56,
      pubdate: 1_789_292_152,
      rcmd_reason: null,
      dimension:
        aspect === "landscape"
          ? { width: 1920, height: 1080, rotate: 0 }
          : { width: 1080, height: 1920, rotate: 0 },
    },
  ];
  const danmaku = [0, 1, 2].map((index) => ({
    progress: 0,
    mode: 1,
    fontsize: 25,
    color: 16777215,
    midHash: "x",
    content: `测试弹幕 ${index}`,
    ctime: 0,
    weight: 1,
    idStr: `e${index}`,
    pool: 0,
  }));

  // 桩必须用 `addInitScript` 注入：`page.goto` 是整文档加载，`page.evaluate` 设的
  // 全局量会被下一次导航冲掉。这里走两层：下面这份注册**一次**的脚本定义 IPC 钩子
  // （invoke 时读全局量），迭代里再为每种画幅注册一份带数据的脚本 —— 后注册者每次
  // 导航都后运行，因此 `window.__shortsLayoutStory` 总是本次迭代要用的那一份。
  await page.addInitScript(() => {
    window.isTauri = true;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    let nextCallback = 1;
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => nextCallback++,
      unregisterCallback: () => {},
      invoke: async (command) => {
        // 设置按「没有客户端」处理：store 认这个 code 就退回默认值（桌面 20px、
        // 移动 16px），夹具因此不必复制一整份 AppSettings。
        if (command === "settings_get") {
          throw { code: "tauri_unavailable", message: "夹具无后端", site: null, retryable: false };
        }
        if (command === "video_get_story") {
          return { has_more: false, items: window.__shortsLayoutStory };
        }
        if (command === "video_get_danmaku") {
          return { segment_index: 0, has_more: false, items: window.__shortsLayoutDanmaku };
        }
        if (command === "video_get_play_info") throw "测试环境不取流";
        return null;
      },
    };
  });

  const origin = page.url().match(/^https?:\/\/[^/]+/)[0];
  const results = [];
  try {
    for (const aspect of ["landscape", "portrait"]) {
      // 后注册的初始化脚本在每个新文档里后执行，因此盖住数据源。
      await page.addInitScript(
        ({ items, entries }) => {
          window.__shortsLayoutStory = items;
          window.__shortsLayoutDanmaku = entries;
        },
        { items: story(aspect), entries: danmaku },
      );
      await page.goto(`${origin}/shorts/bilibili`, { waitUntil: "domcontentloaded" });
      await page.reload();
      await page.waitForSelector('[data-slot="shorts-top-bar"]', { timeout: 15000 });
      await page.waitForTimeout(700);
      const report = await page.evaluate(
        async ({ label }) => {
          const stage = document.querySelector('[data-slot="shorts-viewport"]');
          const frame = stage.querySelector('[data-slot="shorts-frame"]');
          const column = stage.querySelector('[data-slot="shorts-danmaku-column"]');
          const layer = stage.querySelector("[data-video-danmaku-layer]");
          const video = frame.querySelector("video");
          const rect = (node) => {
            if (!node) return null;
            const { x, y, width, height } = node.getBoundingClientRect();
            return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, width: Math.round(width * 10) / 10, height: Math.round(height * 10) / 10 };
          };
          // 喂几次播放位置：弹幕层按 `currentTime` 投放，媒体桩因此足够（不取流）。
          let time = 0;
          Object.defineProperty(video, "currentTime", { configurable: true, get: () => time });
          Object.defineProperty(video, "paused", { configurable: true, get: () => false });
          video.dispatchEvent(new Event("play"));
          for (let step = 0; step < 4; step += 1) {
            time += 0.25;
            video.dispatchEvent(new Event("timeupdate"));
            await new Promise((resolve) => setTimeout(resolve, 40));
          }
          await new Promise((resolve) => setTimeout(resolve, 400));
          const bullets = [...stage.querySelectorAll("[data-rlive-danmaku-id]")].map((node) => ({
            ...rect(node),
            fontSize: getComputedStyle(node).fontSize,
          }));
          return {
            label,
            viewport: rect(stage),
            topBar: rect(stage.querySelector('[data-slot="shorts-top-bar"]')),
            mediaArea: rect(stage.querySelector('[data-slot="shorts-media-area"]')),
            frame: rect(frame),
            column: rect(column),
            columnCssTop: column ? getComputedStyle(column).top : null,
            layer: layer ? { ...rect(layer), cssTop: getComputedStyle(layer).top } : null,
            bullets,
          };
        },
        { label: aspect },
      );
      results.push(report);
    }
  } finally {
    await page.evaluate(() => {
      delete window.__shortsLayoutStory;
      delete window.__shortsLayoutDanmaku;
    });
  }

  const near = (actual, expected, tolerance = 1.5) => Math.abs(actual - expected) <= tolerance;
  const [landscape, portrait] = results;

  /* ---------- 1. 弹幕从控制栏下沿起轨（横屏源） ---------- */
  assert(landscape.topBar && landscape.column && landscape.layer, "横屏源应渲染顶栏、弹幕列与弹幕层");
  assert(
    near(landscape.topBar.height, TOP_BAR_PX),
    `顶部控制栏高度应为 ${TOP_BAR_PX}px，实测 ${landscape.topBar.height}`,
  );
  assert(
    near(landscape.column.y - landscape.viewport.y, TOP_BAR_PX),
    `弹幕列顶边应落在控制栏下沿（相对视口 ${TOP_BAR_PX}px），实测 ${landscape.column.y - landscape.viewport.y}`,
  );
  // 层级：层自己的 `--video-danmaku-top` 必须钉成 0，否则与列的 top 叠加两份偏移。
  assert(
    landscape.layer.cssTop === "0px",
    `弹幕层不应再叠一份偏移（起始线由列承担），实测 top=${landscape.layer.cssTop}`,
  );

  /* ---------- 2. 横屏源偏上：顶留白 < 留白的一半 ---------- */
  const landscapeSlack = landscape.mediaArea.height - landscape.frame.height;
  const landscapeTop = landscape.frame.y - landscape.mediaArea.y;
  assert(
    landscapeTop > 20 && landscapeTop < landscapeSlack / 2 - 1,
    `16:9 画面应偏上（留白的 1/4），实测顶偏移 ${landscapeTop} / 留白 ${landscapeSlack}`,
  );
  assert(
    landscape.frame.y - landscape.column.y > 0,
    "横屏画面框顶边应在弹幕列顶边之下（首轨不穿画面顶部）",
  );

  /* ---------- 3. 竖屏源：贴顶 + 同一条起始线 ---------- */
  assert(portrait.topBar && portrait.column && portrait.layer, "竖屏源应渲染顶栏、弹幕列与弹幕层");
  assert(
    near(portrait.column.y - portrait.viewport.y, TOP_BAR_PX),
    `竖屏源的弹幕列顶边同样落在控制栏下沿，实测 ${portrait.column.y - portrait.viewport.y}`,
  );
  const portraitSlack = portrait.mediaArea.height - portrait.frame.height;
  // 竖屏源在手机上多数会裁切铺满（没有留白）；有留白时必须贴顶。
  assert(
    portraitSlack <= 1 || near(portrait.frame.y, portrait.mediaArea.y, 2),
    `竖屏画面应贴顶（不留上方黑边），实测顶偏移 ${portrait.frame.y - portrait.mediaArea.y}`,
  );

  /* ---------- 4. 弹幕列宽度跟着画面框 ---------- */
  for (const report of results) {
    assert(
      near(report.column.width, report.frame.width, 1),
      `[${report.label}] 弹幕列应与画面框同宽，实测 ${report.column.width} vs ${report.frame.width}`,
    );
    assert(
      near(report.column.x + report.column.width / 2, report.viewport.x + report.viewport.width / 2),
      `[${report.label}] 弹幕列应水平居中于视口，实测 ${report.column.x} / ${report.column.width}`,
    );
  }

  /* ---------- 5. 首条弹幕的落点与字号 ---------- */
  // 字号基准是全应用默认值：移动默认 16px、桌面默认 20px（`isMobileClient()` 沿
  // `(pointer: coarse)` 分野，与设置 store 同一判据）。
  const coarsePointer = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  const baseFontDefault = coarsePointer ? 16 : 20;
  for (const report of results) {
    assert(
      report.bullets.length > 0,
      `[${report.label}] 喂了 currentTime 后应有弹幕投放，实测 0 条（column=${JSON.stringify(report.column)}）`,
    );
    const bullet = report.bullets[0];
    // 首轨不上移：弹幕元素的顶边就是层顶边（`--video-danmaku-top` 已由列表达）。
    assert(
      bullet.y >= report.column.y - 1 && bullet.y - report.column.y < 20,
      `[${report.label}] 首条弹幕应落在列顶边这一带，实测 ${bullet.y}（列顶 ${report.column.y}）`,
    );
    // 滚动弹幕从右沿进入，采样时可能正被 `overflow-hidden` 裁着一部分：只要与列
    // 有实际重叠就说明它挂在列的坐标系里（挂错容器会整条落在列外）。
    const overlap =
      Math.min(bullet.x + bullet.width, report.column.x + report.column.width) -
      Math.max(bullet.x, report.column.x);
    assert(
      overlap > 4,
      `[${report.label}] 弹幕应与弹幕列重叠（不在列外飘），实测重叠 ${overlap}（弹幕 ${bullet.x}–${bullet.x + bullet.width}，列 ${report.column.x}–${report.column.x + report.column.width}）`,
    );
    // 字号缩一档：默认 ${baseFontDefault}px 乘以 `SHORTS_DANMAKU_FONT_SCALE` 后取整。
    const expectedFont = Math.round(baseFontDefault * FONT_SCALE);
    assert(
      near(Number.parseFloat(bullet.fontSize), expectedFont, 2),
      `[${report.label}] 弹幕字号应为 ${expectedFont}px（默认 ${baseFontDefault} × ${FONT_SCALE}），实测 ${bullet.fontSize}`,
    );
  }

  return {
    landscape: {
      topOffset: landscape.column.y - landscape.viewport.y,
      frameTop: landscape.frame.y - landscape.mediaArea.y,
      slack: landscapeSlack,
      frame: landscape.frame,
      column: landscape.column,
      bulletFontSize: landscape.bullets[0]?.fontSize,
      bullets: landscape.bullets.length,
    },
    portrait: {
      topOffset: portrait.column.y - portrait.viewport.y,
      frameTop: portrait.frame.y - portrait.mediaArea.y,
      frame: portrait.frame,
      column: portrait.column,
      bulletFontSize: portrait.bullets[0]?.fontSize,
      bullets: portrait.bullets.length,
    },
  };
}
