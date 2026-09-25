// 卡片表面回归：关注页的两张卡片（直播 FollowCard、IPTV IptvFavoriteCard）必须与
// 首页房间卡 RoomCard、视频卡 VideoCard / PgcCard 是同一块表面 —— 底色、投影、
// 圆角逐项相等，亮/暗两套主题各跑一次。
//
// 断言的是「渲染出来的计算样式」而不是类名字符串：cardSurface.ts 的常量被改动、
// 或某个调用点漏改，这里就会失败。主题通过 html.dark 切换（与 applyTheme() 同一机制），
// 并额外断言 --card 在两个主题下确实不同 —— 否则「两边都错成一样」也会被误判为通过。
//
// 只桩 IPC，不访问真实站点。
// 用法：playwright-cli -s=cardalign run-code --filename=tests/card-surface-align.browser.js
async (page) => {
  const pattern = "**/src/shared/api/tauri.ts*";
  await page.unroute(pattern);
  const source = await page.evaluate(async () => (await fetch("/src/shared/api/tauri.ts")).text());
  const signature = "async function invokeCmd(cmd, args) {";
  if (!source.includes(signature)) throw new Error("IPC 测试注入点已改变");
  await page.route(pattern, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: source.replace(
        signature,
        `${signature}\nif (window.__invoke) { const handled = window.__invoke(cmd, args); if (handled !== undefined) return handled; }`,
      ),
    }),
  );

  const follows = Array.from({ length: 4 }, (_, index) => ({
    site_id: "bilibili",
    room_id: `${index}`,
    user_name: `主播${index}`,
    face: "",
    tag_ids: [],
    auto_record: false,
    live_status: index % 2 === 0,
    live_started_at: null,
    updated_at: 1,
  }));
  const favorites = [
    {
      // 形状镜像 Rust 解析出的 IptvChannel；source_id 必须与关注页默认来源
      // （builtInSources[0].id）一致，否则会被按来源过滤掉。
      id: "channel-a",
      name: "频道甲",
      group: "默认",
      logo: null,
      url: "http://example.test/a.m3u8",
      protocol: "hls",
      headers: {},
      source_id: "chinese",
      favorite_group_id: null,
      updated_at: 1,
    },
  ];

  await page.addInitScript(
    ({ followsData, favoritesData }) => {
      // 只接管本用例需要的命令；其余返回 undefined，交给原实现 —— 非 Tauri 环境下
      // invokeCmd 本来就会抛 tauri_unavailable，设置因此走应用自己的默认值，
      // 不必在这里复制一份完整的 settings schema。
      window.__invoke = (command) => {
        if (command === "follow_list") return followsData;
        if (command === "tag_list") return [];
        if (command === "iptv_favorite_list") return favoritesData;
        if (command === "iptv_favorite_group_list") return [];
        return undefined;
      };
    },
    { followsData: follows, favoritesData: favorites },
  );

  const video = {
    bvid: "BValign",
    aid: "1",
    cid: 1,
    title: "对齐回归",
    cover: "",
    author: "作者",
    author_face: null,
    duration: 30,
    view: 1,
    danmaku: 1,
    pubdate: 0,
    rcmd_reason: null,
    dimension: { width: 1920, height: 1080, rotate: 0 },
  };

  try {
    const report = {};
    for (const theme of ["dark", "light"]) {
      const dark = theme === "dark";
      const surfaces = {};

      const origin = await page.evaluate(() => location.origin);
      for (const [view, marker] of [
        ["live", "主播0"],
        ["iptv", "频道甲"],
      ]) {
        await page.goto(`${origin}/follow?view=${view}`);
        surfaces[view] = await page.evaluate(
          async ({ markerText, dark: wantDark }) => {
            const { until, assert } = await import("/tests/browser/harness.js");
            // 与 applyTheme() 同一机制：切 html 上的类，token 自己翻转。
            document.documentElement.classList.toggle("dark", wantDark);
            await until(() => document.body.textContent.includes(markerText), "卡片未渲染");
            assert(
              document.documentElement.classList.contains("dark") === wantDark,
              "主题类未生效",
            );
            // 桌面端 Card 由 ContextMenuTrigger 渲染，data-slot 因此是
            // context-menu-trigger 而不是 card；两种都接受。
            const card =
              document.querySelector('li > [data-slot="card"]') ??
              document.querySelector('li > [data-slot="context-menu-trigger"]');
            if (!card) return null;
            const style = getComputedStyle(card);
            return {
              background: style.backgroundColor,
              shadow: style.boxShadow,
              radius: style.borderTopLeftRadius,
              tokenCard: getComputedStyle(document.documentElement)
                .getPropertyValue("--card")
                .trim(),
            };
          },
          { markerText: marker, dark },
        );
      }

      // 组件级：房间卡与视频卡渲染在同一文档里，因此共用同一套主题 token。
      const harnessed = await page.evaluate(
        async ({ videoItem, dark: wantDark }) => {
          const { setupHarness, dependencyUrl, frames } = await import("/tests/browser/harness.js");
          const { MemoryRouter } = await import(dependencyUrl("react-router-dom"));
          const { QueryClient, QueryClientProvider } = await import(
            dependencyUrl("@tanstack_react-query")
          );
          const { RoomCard } = await import("/src/shared/components/RoomCard.tsx");
          const { VideoCard, PgcCard } = await import("/src/features/video/VideoCard.tsx");
          const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
          const harness = await setupHarness({
            style: "position:fixed;inset:0;z-index:99999;background:var(--background)",
          });
          const { h } = harness;
          const read = (element) => {
            if (!element) return null;
            const style = getComputedStyle(element);
            return {
              background: style.backgroundColor,
              shadow: style.boxShadow,
              radius: style.borderTopLeftRadius,
            };
          };
          try {
            document.documentElement.classList.toggle("dark", wantDark);
            harness.render(
              h(
                QueryClientProvider,
                { client },
                h(
                  MemoryRouter,
                  null,
                  h(
                    "div",
                    { style: { display: "flex", gap: 12, width: 960 } },
                    h(RoomCard, {
                      key: "room",
                      room: {
                        site_id: "bilibili",
                        room_id: "1",
                        title: "房间",
                        user_name: "主播",
                        cover: "",
                        online: 1,
                        status: true,
                      },
                    }),
                    h(VideoCard, { key: "video", item: videoItem }),
                    h(PgcCard, {
                      key: "pgc",
                      item: { season_id: "1", title: "番剧", cover: "", badge: null, index_show: null },
                    }),
                  ),
                ),
              ),
            );
            await frames();
            return {
              room: read(harness.host.querySelector(".room-card")),
              video: read(harness.host.querySelector('button[data-page-scroll-anchor^="video:"]')),
              pgc: read(harness.host.querySelector('button[data-page-scroll-anchor^="pgc:"]')),
            };
          } finally {
            harness.dispose();
          }
        },
        { videoItem: video, dark },
      );

      report[theme] = { ...surfaces, ...harnessed };
    }

    // 判定：两侧卡片与媒体卡片逐项相等，且主题确实翻转了 token。
    const check = (condition, message) => {
      if (!condition) throw new Error(`卡片表面对齐失败：${message}`);
    };
    for (const theme of ["dark", "light"]) {
      const r = report[theme];
      check(r.live && r.iptv && r.room && r.video && r.pgc, `${theme} 有卡片未渲染`);
      for (const reference of ["room", "video", "pgc"]) {
        for (const field of ["background", "shadow", "radius"]) {
          check(
            r.live[field] === r[reference][field],
            `${theme} 直播关注卡 ${field} 与 ${reference} 不一致：` +
              `${r.live[field]} vs ${r[reference][field]}`,
          );
          check(
            r.iptv[field] === r[reference][field],
            `${theme} IPTV 关注卡 ${field} 与 ${reference} 不一致：` +
              `${r.iptv[field]} vs ${r[reference][field]}`,
          );
        }
      }
      check(
        !r.live.tokenCard.includes("var("),
        `${theme} --card token 未解析：${r.live.tokenCard}`,
      );
    }
    check(
      report.dark.live.tokenCard !== report.light.live.tokenCard,
      "亮暗两套主题的 --card 相同，说明主题没有真正翻转，比对结果不可信",
    );
    check(
      report.dark.live.background !== report.light.live.background,
      "亮暗两套主题的卡片底色相同，说明主题没有真正翻转",
    );

    return {
      passed: true,
      tokens: {
        dark: report.dark.live.tokenCard,
        light: report.light.live.tokenCard,
      },
      surfaces: report,
    };
  } finally {
    await page.unroute(pattern);
  }
}
