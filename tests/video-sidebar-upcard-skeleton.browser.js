// 移动端 VOD 详情侧栏的首屏骨架必须含 UP 主信息卡：稿件详情（`video_get_archive`）
// 未落定时真卡还不存在，但它的位置必须先占住 —— 否则冷启动会先看到一条「没有 UP 主卡」
// 的相关视频列表，数据到达后整块内容再被往下推一次。
//
// 断言的是渲染后的几何而不是类名字符串：把 `UpCardSkeleton` 从 `RelatedPanel` 里摘掉、
// 或让它与真卡尺寸不一致，这里都会失败。
//
// 只桩 IPC，不访问真实站点。
// 用法：playwright-cli -s=rwin run-code --filename=tests/video-sidebar-upcard-skeleton.browser.js
// oxlint-disable-next-line no-unused-expressions -- run-code 要求顶层函数表达式。
async (page) => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const pattern = "**/src/shared/api/tauri.ts*";
  await page.unroute(pattern);
  const origin = page.url().match(/^https?:\/\/[^/]+/)?.[0] ?? "http://localhost:1420";
  await page.goto(`${origin}/settings`, { waitUntil: "domcontentloaded", timeout: 20000 });
  const source = await page.evaluate(async () => (await fetch("/src/shared/api/tauri.ts")).text());
  const signature = "async function invokeCmd(cmd, args) {";
  assert(source.includes(signature), "IPC 测试注入点已改变");
  // 稿件详情与相关视频都挂起：这正是冷启动时移动端的真实形态。
  await page.route(pattern, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: source.replace(
        signature,
        `${signature}\nif(window.__upcardInvoke) return window.__upcardInvoke(cmd,args);`,
      ),
    }),
  );

  const oldViewport = page.viewportSize();
  // 桩必须用 `addInitScript` 注入：`page.goto` 是整文档加载，`page.evaluate` 设的全局量
  // 会被下一次导航冲掉，测试于是变成「真的 IPC 恰好够慢」的碰运气断言。
  // 注入的钩子在 **invoke 时**读全局量，而 `addInitScript` 在每次导航的页面脚本之前
  // 执行，两者合起来才能让桩跨导航生效。
  await page.addInitScript(() => {
    window.__upcardInvoke = (cmd, args) => {
      // 稿件详情与相关视频永远挂起：这就是冷启动时移动端的真实形态。
      if (cmd === "video_get_archive" || cmd === "video_get_related") {
        return new Promise(() => {});
      }
      return window.__TAURI_INTERNALS__.invoke(cmd, args);
    };
  });
  try {
    const report = {};
    for (const viewport of [
      { name: "mobile", width: 390, height: 844 },
      { name: "desktop", width: 1440, height: 900 },
    ]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(`${origin}/video/play?bvid=BV1xx411c7mD&cid=123&aid=456&title=UP%E5%8D%A1%E9%AA%A8%E6%9E%B6`, {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });
      await page.evaluate(async () => {
        const { until } = await import("/tests/browser/harness.js");
        // 骨架必须出现，且要等 React 提交完成再量几何。
        await until(
          () => !!document.querySelector("[data-slot=video-up-card-skeleton]"),
          "UP 主卡骨架未出现",
          15000,
        );
        await until(
          () => !!document.querySelector("aside[aria-label=视频详情]"),
          "详情侧栏未出现",
          15000,
        );
      });

      const measured = await page.evaluate(() => {
        const skeleton = document.querySelector("[data-slot=video-up-card-skeleton]");
        const aside = document.querySelector("aside[aria-label=视频详情]");
        const card = skeleton.firstElementChild;
        const related = skeleton.nextElementSibling;
        const boxes = (el) => {
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
        };
        const blocks = [...skeleton.querySelectorAll("[data-slot=skeleton]")];
        return {
          aside: boxes(aside),
          skeleton: boxes(skeleton),
          card: boxes(card),
          relatedTop: related ? Math.round(related.getBoundingClientRect().top) : null,
          // 骨架块的数量与形状：头像 + 名称 + 两条元信息 + 标题行 + 四项统计
          //（播放/评论/发布时间/当前在线）。
          blockCount: blocks.length,
          avatar: blocks[0]
            ? { w: Math.round(blocks[0].getBoundingClientRect().width), radius: getComputedStyle(blocks[0]).borderRadius }
            : null,
          // 真卡与骨架都用主题表面，不该出现黑舞台那套 `bg-white/10`。
          background: getComputedStyle(skeleton).backgroundColor,
          // 信息卡与下方内容之间不再画分割线（骨架与真卡必须一致）。
          borderBottom: parseFloat(getComputedStyle(skeleton).borderBottomWidth),
        };
      });
      report[viewport.name] = measured;

      // 1. 骨架必须画在侧栏内容区里，宽度与侧栏一致（不是浮在别处）。
      assert(
        Math.abs(measured.skeleton.w - measured.aside.w) <= 1,
        `${viewport.name}: UP 主卡骨架宽度 ${measured.skeleton.w} 与侧栏 ${measured.aside.w} 不一致`,
      );
      // 2. 位置在侧栏顶部（页签条之下），相关视频列表被它推到下面。
      assert(
        measured.skeleton.y >= measured.aside.y,
        `${viewport.name}: UP 主卡骨架跑到了侧栏之外`,
      );
      assert(
        measured.relatedTop !== null && measured.relatedTop >= measured.skeleton.y + measured.skeleton.h - 1,
        `${viewport.name}: 相关视频列表没有被 UP 主卡骨架推到下方（related=${measured.relatedTop}）`,
      );
      // 3. 真卡实测 122px（390px 视口）/ 同样 122px（桌面侧栏）：骨架必须同高，
      //    否则数据到达时下面的列表会跳。
      assert(
        Math.abs(measured.skeleton.h - 122) <= 3,
        `${viewport.name}: UP 主卡骨架高度 ${measured.skeleton.h} 与真卡（122）差得过多`,
      );
      // 4. 头像 40px（真卡 `Avatar size="lg"` 与 `size-11` 同时存在时前者生效）且是圆形。
      assert(
        measured.avatar && Math.abs(measured.avatar.w - 40) <= 1,
        `${viewport.name}: 头像骨架不是 40px（实测 ${JSON.stringify(measured.avatar)}）`,
      );
      assert(
        measured.avatar.radius === "50%" || parseFloat(measured.avatar.radius) > 100,
        `${viewport.name}: 头像骨架不是圆形（radius=${measured.avatar.radius}）`,
      );
      // 5. 块数与构图：头像 + 名称 + 2 条元信息 + 标题行 + 4 项统计 = 9。
      assert(
        measured.blockCount === 9,
        `${viewport.name}: 骨架块应为 9 块，实测 ${measured.blockCount}`,
      );
      // 6. 侧栏是主题表面：不能带上黑舞台那套白色半透明底。
      assert(
        !measured.background.includes("255, 255, 255") && !measured.background.includes("oklch"),
        `${viewport.name}: UP 主卡骨架用了黑舞台的白色底（${measured.background}）`,
      );
      // 7. 信息卡与下方内容之间不画分割线：真卡与骨架都不带下边框，卡片自身的
      //    底色/描边已经把分块说清楚，再加一条通栏线是多余的一道。
      assert(
        measured.borderBottom === 0,
        `${viewport.name}: UP 主卡骨架不应带下分割线（实测 ${measured.borderBottom}px）`,
      );
    }
    return { passed: true, ...report };
  } finally {
    await page.unroute(pattern);
    if (oldViewport) await page.setViewportSize(oldViewport);
  }
}
