// 直播取流优先于弹幕/关注；在 Windows 主窗口运行，不访问真实直播源。
// playwright-cli -s=rwin run-code --filename=tests/live-startup.browser.js
async (page) => {
  const origin = await page.evaluate(() => location.origin);
  const apiPattern = "**/src/shared/api/tauri.ts*";
  const mediaPattern = "**/__startup-live.mp4";
  await page.unroute(apiPattern);
  const source = await page.evaluate(async () => (await fetch("/src/shared/api/tauri.ts")).text());
  const signature = "async function invokeCmd(cmd, args) {";
  if (!source.includes(signature)) throw new Error("IPC 注入点已改变");
  await page.route(apiPattern, (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: source.replace(
        signature,
        signature +
          "\nif (window.__liveStartupInvoke) return window.__liveStartupInvoke(cmd, args);",
      ),
    }),
  );
  const pendingMedia = [];
  await page.route(mediaPattern, (route) => {
    pendingMedia.push(route);
  });
  try {
    await page.goto(`${origin}/settings`);
    return await page.evaluate(async () => {
      const { setupHarness, dependencyUrl, until, frames, assert } =
        await import("/tests/browser/harness.js");
      const { QueryClient, QueryClientProvider } = await import(
        dependencyUrl("@tanstack_react-query")
      );
      const { MemoryRouter, createMemoryRouter, RouterProvider } = await import(
        dependencyUrl("react-router-dom")
      );
      const { RoomPage } = await import("/src/features/room/RoomPage.tsx");
      const { IptvPlayer } = await import('/src/features/iptv/IptvPlayer.tsx');
      const { RecordingPlayer } = await import('/src/features/recording/RecordingPlayer.tsx');
      const { DouyinShortsFeed } = await import('/src/features/shorts/DouyinShortsFeed.tsx');
      const { ShortsHomePage } = await import("/src/features/shorts/ShortsHomePage.tsx");
      const { PlayerStageSkeleton } =
        await import("/src/shared/components/player/PlayerStageSkeleton.tsx");
      const harness = await setupHarness({
        strict: false,
        style: "position:fixed;inset:0;z-index:9999;",
      });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const calls = [];
      let finishQualities;
      const detail = {
        site_id: "bilibili",
        room_id: "startup",
        title: "首帧回归",
        cover: "",
        user_name: "测试",
        user_avatar: "",
        online: 0,
        status: true,
        notice: "",
        url: "",
        raw: null,
      };
      window.__liveStartupInvoke = async (cmd) => {
        calls.push(cmd);
        if (cmd === "site_get_room_detail") return detail;
        if (cmd === "site_get_play_qualities")
          return new Promise((resolve) => {
            finishQualities = resolve;
          });
        if (cmd === "site_get_play_urls")
          return [
            {
              source_id: "test",
              label: "测试",
              priority: 0,
              protocol: "native",
              url: location.origin + "/__startup-live.mp4",
              headers: {},
            },
          ];
        if (cmd === "stream_proxy_start") return location.origin + "/__startup-live.mp4";
        if (cmd === "follow_list") return [];
        if (cmd === "asr_list_models") return [];
        return null;
      };
      const routers = [];
      const mountRoom = () => {
        const router = createMemoryRouter(
          [{ path: "/live/:siteId/:roomId", element: harness.h(RoomPage) }],
          {
            initialEntries: ["/live/bilibili/startup"],
          },
        );
        routers.push(router);
        harness.render(
          harness.h(QueryClientProvider, { client }, harness.h(RouterProvider, { router })),
        );
      };
      try {
        mountRoom();
        await until(() => !!finishQualities, "未启动直播清晰度请求");
        assert(!harness.host.querySelector('[data-player-controls], [data-player-hud]'), "解析线路时不应显示控制栏");
        assert(harness.host.querySelector('button[aria-label="返回上一页"]'), "解析线路时缺少返回按钮");
        assert(
          !calls.includes("follow_list") && !calls.includes("danmaku_connect"),
          "取流前就启动辅助请求",
        );
        finishQualities([{ quality: "原画", data: null }]);
        await until(() => calls.includes("stream_proxy_start"), "未启动流代理");
        await until(() => !!harness.host.querySelector("video[src]"), "媒体未附着");
        await frames();
        assert(
          !calls.includes("follow_list") && !calls.includes("danmaku_connect"),
          "首帧未到就启动辅助请求",
        );
        // 媒体暂停时 canplay 也能开闸，不必等 playing。
        assert(!harness.host.querySelector('[data-player-controls], [data-player-hud]'), "媒体未就绪就显示控制栏");
        harness.host.querySelector("video[src]").dispatchEvent(new Event("canplay"));
        await until(
          () => calls.includes("follow_list") && calls.includes("danmaku_connect"),
          "媒体可播后未开放辅助请求",
        );
        assert(harness.host.querySelector('[data-player-controls]') && harness.host.querySelector('[data-player-hud]'), "媒体可播后未恢复控制栏");
        harness.host.querySelector('video[src]').dispatchEvent(new Event('waiting'));
        await frames();
        assert(harness.host.querySelector('[data-player-controls]'), "缓冲时不应卸载控制栏");
        assert(
          calls.filter((cmd) => cmd === "site_get_play_urls").length === 1,
          "开放辅助内容重复取流",
        );
        harness.render(null);
        await frames();
        client.clear();
        // 取流失败后不能一直封锁辅助内容。
        calls.length = 0;
        window.__liveStartupInvoke = async (cmd) => {
          calls.push(cmd);
          if (cmd === "site_get_room_detail") return detail;
          if (cmd === "site_get_play_qualities") throw new Error("夹具取流失败");
          if (cmd === "follow_list" || cmd === "asr_list_models") return [];
          return null;
        };
        mountRoom();
        await until(
          () => calls.includes("follow_list") && calls.includes("danmaku_connect"),
          "取流失败未开放辅助内容",
        );
        harness.render(null);
        await frames();
        client.clear();
        const sourceUrl = location.origin + '/__startup-live.mp4';
        window.__liveStartupInvoke = async (cmd) => {
          if (cmd === 'stream_proxy_start') return sourceUrl;
          if (cmd === 'asr_list_models') return [];
          return null;
        };
        const renderPlayer = element => harness.render(harness.h(QueryClientProvider, { client }, element));
        const channel = { id: 'startup-iptv', name: '频道回归', url: sourceUrl, protocol: 'native', headers: {} };
        renderPlayer(harness.h(IptvPlayer, { channel, reloadToken: 0, onBack: () => {} }));
        await until(() => !!harness.host.querySelector('video[src]'), 'IPTV 媒体未附着');
        assert(!harness.host.querySelector('[data-player-controls], [data-player-hud]'), 'IPTV 首帧前仍有控制栏');
        harness.host.querySelector('video[src]').dispatchEvent(new Event('canplay'));
        await until(() => !!harness.host.querySelector('[data-player-controls]'), 'IPTV 可播后控制栏未出现');
        renderPlayer(harness.h(IptvPlayer, { channel, reloadToken: 1, onBack: () => {} }));
        assert(!harness.host.querySelector('[data-player-controls], [data-player-hud]'), 'IPTV 重连未隐藏控制栏');
        harness.render(null);
        await frames();
        client.clear();
        renderPlayer(harness.h(RecordingPlayer, {
          item: { id: 'startup-recording', title: '录制回归', user_name: '测试', duration_ms: 10000, include_danmaku: false, protocol: 'native' },
          url: sourceUrl,
        }));
        await until(() => !!harness.host.querySelector('video[src]'), '录制媒体未附着');
        assert(!harness.host.querySelector('[data-player-controls]'), '录制首帧前仍有控制栏');
        harness.host.querySelector('video[src]').dispatchEvent(new Event('loadeddata'));
        await until(() => !!harness.host.querySelector('[data-player-controls]'), '录制媒体就绪后控制栏未出现');
        harness.render(null);
        await frames();
        client.clear();
        let resolveFeed, resolvePlay;
        const item = { id: 'startup-douyin', title: '抖音回归', author: '测试', cover: '', width: 160, height: 90, duration: 10 };
        window.__liveStartupInvoke = async (cmd) => {
          if (cmd === 'douyin_video_feed') return new Promise(resolve => { resolveFeed = resolve; });
          if (cmd === 'douyin_video_resolve') return new Promise(resolve => { resolvePlay = resolve; });
          return null;
        };
        renderPlayer(harness.h(MemoryRouter, null, harness.h(DouyinShortsFeed, { onRefresh: () => {} })));
        await until(() => !!resolveFeed, '抖音推荐未请求');
        const shortsControls = () => harness.host.querySelector('[data-slot="shorts-top-bar"], [data-slot="shorts-bottom-bar"]');
        assert(!shortsControls(), '抖音推荐加载时仍有控制栏');
        assert(harness.host.querySelector('button[aria-label="返回上一页"]'), '抖音加载时缺少返回');
        resolveFeed({ items: [item], has_more: false });
        await until(() => !!resolvePlay, '抖音未开始取流');
        assert(!shortsControls(), '抖音取流时仍有控制栏');
        resolvePlay({ item, play_url: sourceUrl, session_id: 'startup-douyin' });
        await until(() => !!harness.host.querySelector('video[src]'), '抖音媒体未附着');
        const shortsMedia = harness.host.querySelector('video[src]');
        Object.defineProperty(shortsMedia, 'readyState', { configurable: true, get: () => 4 });
        shortsMedia.dispatchEvent(new Event('canplay'));
        await until(() => !!shortsControls(), '抖音可播后控制栏未出现');
        harness.render(null);
        await frames();
        harness.render(harness.h(PlayerStageSkeleton));
        assert(
          !harness.host.querySelector("[data-slot=player-controls-skeleton]"),
          "公共舞台仍有控制栏骨架",
        );
        assert(
          harness.host.querySelectorAll("[data-slot=skeleton]").length === 0,
          "加载舞台不应绘制顶部骨架",
        );
        harness.render(harness.h(MemoryRouter, null, harness.h(ShortsHomePage)));
        for (const text of [
          "抖音推荐需先",
          "推荐视频、弹幕与评论",
          "推荐视频流",
          "选择平台，进入上下滑动",
        ]) {
          assert(!harness.host.textContent.includes(text), `仍有说明小字：${text}`);
        }
        assert(
          harness.host.querySelector('a[href="/shorts/bilibili"]') &&
            harness.host.querySelector('a[href="/shorts/douyin"]'),
          "平台入口丢失",
        );
        return {
          passed: true,
          streamFirst: true,
          canplayReleases: true,
          noDuplicateStream: true,
          failureReleases: true,
          noControlSkeleton: true,
          controlsWaitForMedia: true,
          iptvAndRecording: true,
          douyinLoadingControls: true,
          noDescriptions: true,
        };
      } catch (error) {
        throw new Error(`${error}\n${JSON.stringify({ calls, text: harness.host.textContent })}`);
      } finally {
        harness.dispose();
        for (const router of routers) router.dispose();
        client.clear();
        await frames();
        delete window.__liveStartupInvoke;
      }
    });
  } finally {
    for (const route of pendingMedia) await route.abort().catch(() => {});
    await page.unroute(mediaPattern);
    await page.unroute(apiPattern);
    await page.goto(origin);
  }
}
