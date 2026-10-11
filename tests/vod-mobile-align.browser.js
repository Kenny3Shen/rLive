// VOD 移动端三处对齐/定位契约的真实浏览器回归（mock IPC，不在真实 Tauri 窗口运行）：
//
//   1. 视频搜索页头部的查询条与直播搜索页同款：提交键是内嵌在输入组右端的图标
//      按钮，不再是一枚带「搜索」二字的独立按钮 —— 移动端头部要同时容下返回键、
//      输入框与提交键，文字按钮会把输入框挤掉一半宽。
//   2. 侧栏三张选集卡（选集 / 合集 / 分集）标题行右侧报「当前项序号/总数」，
//      而不是只报总数；定位不到当前项（链接缺 cid、epId 不在表里）时退回「共 N …」。
//   3. UP 主投稿抽屉：排序切换按钮的视觉高度收到 28px（与标题文字、关闭图标同高），
//      粗指针下 44px 的触摸目标挪进透明 `::after`；打开抽屉时自动定位当前播放的
//      稿件（命中即居中并加一圈描边，未命中最多自动翻 5 页）。
//
// 只桩 IPC，不访问真实站点。用法：
//   playwright-cli -s=vod-align open http://127.0.0.1:1421/
//   playwright-cli -s=vod-align run-code --filename=tests/vod-mobile-align.browser.js
async (page) => {
  const origin = await page.evaluate(() => location.origin);
  const cdp = await page.context().newCDPSession(page);
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const passed = [];
  const frames = async () =>
    await page.evaluate(async () => {
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });

  try {
    // 触摸 + 紧凑视口：三处契约都只在移动端形态下成立（`(pointer: coarse)` 决定
    // 按钮的 44px 触摸目标，`isMobileClient()` 决定搜索条与抽屉的布局分支）。
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await cdp.send("Emulation.setUserAgentOverride", {
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36",
      userAgentMetadata: {
        brands: [],
        fullVersionList: [],
        platform: "Android",
        platformVersion: "14",
        architecture: "",
        model: "Pixel 8",
        mobile: true,
      },
    });
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 401,
      height: 757,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // ── 1. 搜索页头部查询条 ──────────────────────────────────────────────
    await page.goto(`${origin}/video/search`);
    await page.waitForSelector("[data-slot=app-header] form [data-slot=input-group]", {
      timeout: 20000,
    });
    const searchBar = await page.evaluate(() => {
      const form = document.querySelector("[data-slot=app-header] form");
      const group = form.querySelector("[data-slot=input-group]");
      const submit = form.querySelector('button[type="submit"]');
      const rect = (el) => {
        const box = el.getBoundingClientRect();
        return { x: box.x, y: box.y, w: box.width, h: box.height, right: box.right };
      };
      return {
        // 提交键住在输入组**内部**（内嵌），不是表单里并排的第二个兄弟。
        insideGroup: group.contains(submit),
        submitText: submit.textContent.trim(),
        submitLabel: submit.getAttribute("aria-label"),
        submit: rect(submit),
        group: rect(group),
        // 提交键与输入框同高（都撑满输入组内容盒），纵向中线也对齐。
        input: rect(form.querySelector("input")),
      };
    });
    assert(searchBar.insideGroup, "视频搜索条的提交键没有内嵌进输入组");
    assert(searchBar.submitText === "", `提交键仍带文字「${searchBar.submitText}」`);
    assert(searchBar.submitLabel === "搜索", "内嵌提交键缺少「搜索」无障碍名");
    assert(
      Math.abs(
        (searchBar.submit.y + searchBar.submit.h / 2) - (searchBar.input.y + searchBar.input.h / 2),
      ) < 1,
      "提交键与输入框纵向中线不齐",
    );
    assert(
      searchBar.submit.right <= searchBar.group.right + 1,
      `提交键越出输入组右缘：${searchBar.submit.right} > ${searchBar.group.right}`,
    );
    // 输入框仍占大头：图标按钮只吃掉一枚图标的宽度。
    assert(
      searchBar.input.w > searchBar.group.w * 0.75,
      `输入框被提交键挤得太窄：${searchBar.input.w}/${searchBar.group.w}`,
    );
    passed.push("搜索条提交键内嵌为图标按钮，输入框保留大部分宽度");

    // ── 2. 侧栏选集卡片的 x/y ───────────────────────────────────────────
    await page.goto(`${origin}/tests/browser/video-shell.html`);
    await page.evaluate(async () => {
      await import("/src/styles.css");
    });
    await page.waitForFunction(() => Boolean(window.shellFixture));
    await page.evaluate(() => {
      const original = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async (command, args) => {
        if (command === "video_get_archive") {
          return {
            bvid: args.bvid,
            aid: "456",
            cid: 1001,
            title: "选集回归",
            cover: "",
            desc: "",
            tags: [],
            author: "测试",
            author_face: null,
            author_mid: "1",
            author_fans: 0,
            author_videos: 0,
            view: 0,
            danmaku: 0,
            reply: 0,
            pubdate: 0,
            pages: [
              { page: 1, cid: 1001, part: "第一集", duration: 10 },
              { page: 2, cid: 1002, part: "第二集", duration: 10 },
              { page: 3, cid: 1003, part: "第三集", duration: 10 },
            ],
            ugc_season: {
              title: "测试合集",
              episodes: [1, 2, 3, 4, 5].map((index) => ({
                bvid: `BVseason${index}`,
                cid: 2000 + index,
                title: `合集第 ${index} 期`,
                aid: String(index),
                duration: 60,
                cover: "",
              })),
            },
          };
        }
        return original(command, args);
      };
    });

    /** 读三张选集卡标题行右侧的数量文案。 */
    const readCounts = () =>
      page.evaluate(() => {
        const out = {};
        for (const card of document.querySelectorAll("[data-slot=video-selection-card]")) {
          const spans = [...card.querySelectorAll("h3 button > span")].map(
            (span) => span.textContent,
          );
          out[spans[0]] = spans[spans.length - 1];
        }
        return out;
      });

    // 当前稿件是合集第 3 期（bvid 定位，链接的 cid 属于别的稿件）：合集报 3/5。
    // 移动端合集卡默认收起（列表不挂载），因此等卡片本身而不是条目文案。
    await page.evaluate(() =>
      window.shellFixture.router.navigate("/video/play?bvid=BVseason3&cid=2003&aid=3"),
    );
    await page.waitForFunction(
      () => document.querySelectorAll("[data-slot=video-selection-card]").length === 2,
      null,
      { timeout: 30000 },
    );
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("[data-slot=video-selection-card] h3 button")].some((node) =>
          node.textContent.includes("3/5"),
        ),
      null,
      { timeout: 20000 },
    );
    await frames();
    const seasonCounts = await readCounts();
    assert(seasonCounts["合集"] === "3/5", `合集应报 3/5，实测 ${seasonCounts["合集"]}`);
    assert(seasonCounts["选集"] === "共 3 P", `选集未定位到当前 P 时应报总数，实测 ${seasonCounts["选集"]}`);
    passed.push("合集卡片报当前项序号/总数，选集定位不到时退回总数");

    // 当前 cid 是第二个 P：选集报 2/3（同稿件换 P 不重挂，文案跟着换）。
    await page.evaluate(() =>
      window.shellFixture.router.navigate("/video/play?bvid=BV1shell&cid=1002&aid=456"),
    );
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("[data-slot=video-selection-card] h3 button")].some((node) =>
          node.textContent.includes("2/3"),
        ),
      null,
      { timeout: 20000 },
    );
    await frames();
    const partCounts = await readCounts();
    assert(partCounts["选集"] === "2/3", `选集应报 2/3，实测 ${partCounts["选集"]}`);
    // 合集按 bvid 定位：换成不在合集里的稿件后不再报位置，退回总数。
    assert(
      partCounts["合集"] === "共 5 个",
      `当前稿件不在合集里时应退回总数，实测 ${partCounts["合集"]}`,
    );
    passed.push("选集卡片报当前 P 序号/总数，稿件不在合集里时退回总数");

    // PGC 分集卡同款：ep_id 在表里就报位置，换集跟着走。
    await page.evaluate(() => {
      const original = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async (command, args) => {
        if (command === "video_get_season") {
          return {
            season_id: "1",
            title: "测试剧集",
            cover: "",
            evaluate: "",
            episodes: [40, 41, 42, 43, 44].map((cid) => ({
              ep_id: String(cid),
              bvid: `BVepisode${cid}`,
              cid,
              aid: String(cid),
              title: String(cid),
              long_title: `剧集 ${cid}`,
              cover: "",
              duration: 120,
            })),
          };
        }
        return original(command, args);
      };
    });
    await page.evaluate(() =>
      window.shellFixture.router.navigate("/video/play?ep_id=42&bvid=BVepisode42&cid=42"),
    );
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("[data-slot=video-selection-card] h3 button")].some((node) =>
          node.textContent.includes("3/5"),
        ),
      null,
      { timeout: 20000 },
    );
    const pgcCounts = await readCounts();
    assert(pgcCounts["分集"] === "3/5", `分集应报 3/5，实测 ${pgcCounts["分集"]}`);
    await page.evaluate(() =>
      window.shellFixture.router.navigate("/video/play?ep_id=44&bvid=BVepisode44&cid=44"),
    );
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("[data-slot=video-selection-card] h3 button")].some((node) =>
          node.textContent.includes("5/5"),
        ),
      null,
      { timeout: 20000 },
    );
    passed.push("PGC 分集卡片报当前集序号/总数，换集跟随");

    // 回到 UGC 稿件：下面的投稿抽屉要挂在 UP 主信息卡上（PGC 没有这张卡）。
    await page.evaluate(() =>
      window.shellFixture.router.navigate("/video/play?bvid=BV1shell&cid=1002&aid=456"),
    );
    await page.waitForSelector("section[aria-label^='UP 主信息']", { timeout: 20000 });

    // ── 3. 投稿抽屉：排序按钮高度 + 打开时定位当前稿件 ─────────────────
    await page.evaluate(() => {
      const original = window.__TAURI_INTERNALS__.invoke;
      window.__uploaderPages = [];
      window.__TAURI_INTERNALS__.invoke = async (command, args) => {
        if (command === "video_uploader_videos") {
          window.__uploaderPages.push(args.page);
          const items = Array.from({ length: 30 }).map((_, index) => {
            const n = (args.page - 1) * 30 + index + 1;
            return {
              // 当前播放的稿件放在第 2 页中段：必须真的翻页才能定位到。
              bvid: n === 45 ? "BV1shell" : `BVup${n}`,
              aid: String(500 + n),
              cid: 1001,
              title: `投稿第 ${n} 条`,
              cover: "",
              author: "测试",
              duration: 120,
              pubdate: 1700000000,
              view: 1000,
              danmaku: 10,
              dimension: { width: 1920, height: 1080, rotate: 0 },
            };
          });
          return { has_more: args.page < 4, items };
        }
        return original(command, args);
      };
    });
    await page.evaluate(() => {
      const button = [
        ...document.querySelectorAll("section[aria-label^='UP 主信息'] button"),
      ].find((node) => (node.getAttribute("aria-label") || "").includes("的投稿视频"));
      button.click();
    });
    await page.waitForSelector("[data-slot=drawer-content] [data-uploader-current]", {
      timeout: 20000,
    });
    await page.waitForTimeout(400);

    const drawer = await page.evaluate(() => {
      const popup = document.querySelector("[data-slot=drawer-content]");
      const title = popup.querySelector("[data-slot=drawer-title]");
      const sort = [...popup.querySelectorAll("button")].find((node) =>
        (node.getAttribute("aria-label") || "").includes("排序"),
      );
      const close = popup.querySelector("button[aria-label=关闭]");
      const closeIcon = close.querySelector("svg");
      const list = popup.querySelector(".overflow-y-auto");
      const current = list.querySelector("[data-uploader-current]");
      const card = current.querySelector("button");
      const box = (el) => {
        const rect = el.getBoundingClientRect();
        return { y: rect.y, h: rect.height, cy: rect.y + rect.height / 2 };
      };
      // 排序按钮可见框顶部之上 6px 处命中什么：透明 `::after` 补出的触摸目标
      // 应当仍把这块区域交给排序按钮自己。
      const sortBox = sort.getBoundingClientRect();
      const probe = document.elementFromPoint(
        sortBox.left + sortBox.width / 2,
        sortBox.top - 6,
      );
      return {
        pages: window.__uploaderPages,
        title: box(title),
        sort: box(sort),
        close: box(close),
        closeIcon: box(closeIcon),
        // 视觉高度：28px 的 `sm` 档，与 24px 的标题文字同一条水平中线。
        sortVisualHeight: sort.getBoundingClientRect().height,
        sortHitTargetIsSort: probe === sort || sort.contains(probe),
        listScrollTop: list.scrollTop,
        currentVisible: (() => {
          const listBox = list.getBoundingClientRect();
          const cardBox = card.getBoundingClientRect();
          return cardBox.top >= listBox.top - 1 && cardBox.bottom <= listBox.bottom + 1;
        })(),
        currentOutlineWidth: getComputedStyle(current).outlineWidth,
        currentOutlineColor: getComputedStyle(current).outlineColor,
        currentBvid: current.getAttribute("data-uploader-video"),
        // 描边画在内侧：卡片本身没有被推出容器横向边界。
        currentInsideList:
          card.getBoundingClientRect().left >= list.getBoundingClientRect().left - 1 &&
          card.getBoundingClientRect().right <= list.getBoundingClientRect().right + 1,
      };
    });

    assert(
      drawer.sortVisualHeight <= 30,
      `排序按钮视觉高度应收到 28px 档，实测 ${drawer.sortVisualHeight}`,
    );
    assert(
      Math.abs(drawer.sort.cy - drawer.title.cy) < 1.5,
      `排序按钮与标题文字纵向中线不齐：${drawer.sort.cy} vs ${drawer.title.cy}`,
    );
    assert(
      Math.abs(drawer.closeIcon.cy - drawer.sort.cy) < 1.5,
      `关闭图标与排序按钮纵向中线不齐：${drawer.closeIcon.cy} vs ${drawer.sort.cy}`,
    );
    assert(
      drawer.sortHitTargetIsSort,
      "排序按钮视觉框上方 6px 处不再属于它的触摸目标（44px 命中区丢失）",
    );
    assert(
      drawer.pages.includes(2),
      `未翻页找当前稿件，实际请求页：${drawer.pages.join(",")}`,
    );
    assert(
      drawer.currentBvid === "BV1shell",
      `高亮的不是当前稿件：${drawer.currentBvid}`,
    );
    assert(drawer.currentVisible, "当前稿件没有被滚进可视区");
    assert(drawer.listScrollTop > 0, "列表没有滚动到当前稿件位置");
    assert(
      Number.parseFloat(drawer.currentOutlineWidth) >= 2,
      `当前稿件缺少描边标记：${drawer.currentOutlineWidth}`,
    );
    assert(
      !/rgba\(0, 0, 0, 0\)|transparent/.test(drawer.currentOutlineColor),
      "当前稿件描边没有颜色",
    );
    assert(drawer.currentInsideList, "当前稿件的描边把卡片推出了列表横向边界");
    passed.push("投稿抽屉排序按钮收到文字高度且保留 44px 命中区，打开时翻页定位并高亮当前稿件");

    // 换排序：列表整体换一份，回到顶部且不再为它自动翻页（最多 5 页只留给首次打开）。
    const beforeToggle = drawer.pages.length;
    await page.evaluate(() => {
      const popup = document.querySelector("[data-slot=drawer-content]");
      const sort = [...popup.querySelectorAll("button")].find((node) =>
        (node.getAttribute("aria-label") || "").includes("排序"),
      );
      sort.click();
    });
    await page.waitForTimeout(600);
    const afterToggle = await page.evaluate(() => {
      const popup = document.querySelector("[data-slot=drawer-content]");
      const sort = [...popup.querySelectorAll("button")].find((node) =>
        (node.getAttribute("aria-label") || "").includes("排序"),
      );
      const list = popup.querySelector(".overflow-y-auto");
      return { text: sort.textContent.trim(), pages: window.__uploaderPages.length, scrollTop: list.scrollTop };
    });
    assert(afterToggle.text === "最多播放", `排序未切换：${afterToggle.text}`);
    assert(
      afterToggle.pages === beforeToggle + 1,
      `换排序应只重取一页，实际又发了 ${afterToggle.pages - beforeToggle} 次请求`,
    );
    assert(afterToggle.scrollTop === 0, "换排序后列表没有回到顶部");
    passed.push("换排序只重取一页并回到顶部");

    return { passed: true, passed, searchBar, seasonCounts, partCounts, pgcCounts, drawer };
  } finally {
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => {});
  }
}
