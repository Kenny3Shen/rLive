// 真实 VideoSidebar 的布局回归：选集归并、局部滚动、导航队列与固定发送区。
// 仅桩 IPC / Query 缓存，不请求真实站点；在独立 Vite 浏览器运行，不用于真实 Tauri 主窗口：
//   playwright-cli run-code --filename=tests/video-sidebar-layout.browser.js
async (page) => {
  await page.waitForFunction(() =>
    performance
      .getEntriesByType("resource")
      .some((entry) => entry.name.includes("/deps/react-dom_client.js")),
  );
  return page.evaluate(async () => {
    await import("/src/styles.css");
    const { setupHarness, dependencyUrl, assert, frames, until, settleAnimations } =
      await import("/tests/browser/harness.js");
    const { QueryClient, QueryClientProvider } = await import(
      dependencyUrl("@tanstack_react-query")
    );
    const { MemoryRouter, useLocation } = await import(dependencyUrl("react-router-dom"));
    const { VideoSidebar } = await import("/src/features/video/VideoSidebar.tsx");
    const { TooltipProvider } = await import("/src/components/ui/tooltip.tsx");
    const { usePlaylistStore } = await import("/src/features/video/playlistStore.ts");
    const ui = await setupHarness({
      style:
        "position:fixed;left:0;top:0;width:390px;height:600px;z-index:1000;background:var(--background)",
    });
    const { h, React, flushSync } = ui;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnMount: false } },
    });
    const oldTauri = window.__TAURI_INTERNALS__;
    const oldPlaylist = usePlaylistStore.getState();
    const calls = [];
    window.__TAURI_INTERNALS__ = {
      ...oldTauri,
      invoke: async (command) => {
        calls.push(command);
        if (command === "video_get_related") return { items: [], has_more: false };
        if (command === "video_get_comments")
          return { items: [], has_more: false, next: 0, all_count: 0 };
        return null;
      },
    };
    const pages = Array.from({ length: 60 }, (_, index) => ({
      page: index + 1,
      cid: index + 1,
      part: `测试分 P ${index + 1}`,
      duration: 120,
    }));
    const season = {
      title: "测试合集",
      episodes: pages.map((part) => ({
        bvid: `BVselection${part.cid}`,
        cid: part.cid,
        aid: String(part.cid),
        title: `合集视频 ${part.cid}`,
        duration: 120,
      })),
    };
    const archive = {
      bvid: "BVselection40",
      aid: "40",
      cid: 40,
      title: "当前视频信息卡",
      cover: "",
      desc: "",
      tags: [],
      author: "测试作者",
      author_face: null,
      author_mid: "",
      author_fans: 0,
      author_videos: 0,
      view: 0,
      danmaku: 0,
      reply: 0,
      pubdate: 0,
      ugc_season: season,
      pages,
    };
    const pgc = {
      season_id: "1",
      title: "测试剧集",
      cover: "",
      evaluate: "真实剧集简介",
      episodes: pages.map((part) => ({
        ep_id: String(part.cid),
        bvid: `BVepisode${part.cid}`,
        cid: part.cid,
        aid: String(part.cid),
        title: String(part.cid),
        long_title: `剧集 ${part.cid}`,
        cover: "",
        duration: 120,
      })),
    };
    const entries = pages.map((part) => ({
      progressMs: part.cid * 1000,
      content: `弹幕 ${part.cid}`,
      color: "",
    }));
    let changeProps;
    function Harness({ initial }) {
      const [props, setProps] = React.useState(initial);
      const [tab, setTab] = React.useState("related");
      changeProps = setProps;
      const location = useLocation();
      return h(
        React.Fragment,
        null,
        h(VideoSidebar, {
          ...props,
          tab,
          onTabChange: setTab,
          danmaku: { entries, positionMs: 40000, loading: false, onSeek: () => {} },
          danmakuComposer: h("input", {
            "aria-label": "测试弹幕发送",
            style: { height: 36, width: "100%" },
          }),
        }),
        h("output", { "data-location": true, hidden: true }, location.search),
      );
    }
    const render = (name, initial) =>
      ui.render(
        h(
          QueryClientProvider,
          { client },
          h(TooltipProvider, null, h(MemoryRouter, { key: name }, h(Harness, { initial }))),
        ),
      );
    const panel = (name) => ui.query(`[data-video-side-tab-panel="${name}"]`);
    const selectTab = async (label) => {
      const tab = [...ui.host.querySelectorAll('[role="tab"]')].find(
        (item) => item.textContent === label,
      );
      assert(tab, `未找到 ${label} Tab`);
      flushSync(() => tab.click());
      await settleAnimations(ui.query('[data-slot="horizontal-swipe-track"]'));
    };
    const checkTabs = () => {
      const labels = [...ui.host.querySelectorAll('[role="tab"]')].map((item) => item.textContent);
      assert(
        labels.join("/") === "相关视频/评论/弹幕/设置",
        `独立选集 Tab 未移除或入口丢失：${labels}`,
      );
    };
    const selectionToggle = (label) => {
      const section = [...panel("related").querySelectorAll("section[aria-label]")].find(
        (item) =>
          item.getAttribute("aria-label") === label ||
          item.getAttribute("aria-label").startsWith(`${label}：`),
      );
      const trigger = section?.querySelector("h3 button[aria-expanded]");
      assert(trigger, `${label} 没有统一的标题开关`);
      return trigger;
    };
    const toggleSelection = async (label) => {
      flushSync(() => selectionToggle(label).click());
      await frames();
    };
    const checkClosed = (kind, label, previousList) => {
      const trigger = selectionToggle(label);
      assert(trigger.getAttribute("aria-expanded") === "false", `${label} 收起语义错误`);
      const list = ui.query(`[data-video-selection-list="${kind}"]`);
      assert(!list || list.closest("[hidden], [inert]"), `${label} 收起后内容仍可见 / 可聚焦`);
      trigger.focus({ preventScroll: true });
      previousList.querySelector("button").focus({ preventScroll: true });
      assert(document.activeElement === trigger, `${label} 隐藏条目仍可获得焦点`);
    };
    const checkList = (kind, card) => {
      const label = { parts: "选集", season: "合集", episodes: "分集" }[kind];
      const trigger = selectionToggle(label);
      assert(trigger.getAttribute("aria-expanded") === "true", `${label} 展开语义错误`);
      const controlled = document.getElementById(trigger.getAttribute("aria-controls"));
      const list = ui.query(`[data-video-selection-list="${kind}"]`);
      assert(controlled?.contains(list), `${label} 标题未关联到内容区域`);
      assert(list, `缺少 ${kind} 列表`);
      assert(
        card.getBoundingClientRect().bottom <= list.getBoundingClientRect().top,
        `${kind} 没在信息卡下方`,
      );
      assert(
        list.clientHeight <= 256 && list.scrollHeight > list.clientHeight,
        `${kind} 未限制高度内滚`,
      );
      assert(list.scrollTop > 0, `${kind} 未定位到当前播放项`);
      assert(panel("related").scrollTop === 0, `${kind} 定位滚动挤走信息卡`);
      assert(
        ui.query("[data-video-side-tab-viewport]").scrollLeft === 0,
        `${kind} 定位滚动推偏了页签条带`,
      );
      const current = list.querySelector('[aria-current="true"]');
      const rowRect = current.getBoundingClientRect();
      const listRect = list.getBoundingClientRect();
      assert(
        rowRect.top >= listRect.top && rowRect.bottom <= listRect.bottom,
        `${kind} 当前项没有滚入自身视口`,
      );
      return list;
    };
    const passed = [];
    try {
      client.setQueryData(["video_comments", archive.aid, 3], {
        pages: [
          {
            items: pages.map((part) => ({
              rpid: part.cid,
              mid: "1",
              uname: "评论用户",
              avatar: null,
              level: 0,
              message: `评论正文 ${part.cid}`,
              emotes: [],
              pictures: [],
              like: 0,
              ctime: 0,
              rcount: 0,
              replies: [],
              is_upper: false,
            })),
            has_more: false,
            next: 0,
            all_count: pages.length,
          },
        ],
        pageParams: [0],
      });
      client.setQueryData(["video_archive", archive.bvid], archive);
      client.setQueryData(["video_related", archive.bvid], { items: [], has_more: false });
      client.setQueryData(["video_online_total", archive.bvid, 40], "12");
      render("ugc", { bvid: archive.bvid, epId: null, aid: archive.aid, cid: 40 });
      await frames();
      checkTabs();
      const card = ui.query('section[aria-label^="UP 主信息"]');
      let parts = checkList("parts", card);
      const selectionTriggerClass = selectionToggle("选集").className;
      assert(!ui.query('[data-video-selection-list="season"]'), "多 P 的合集应默认收起");
      assert(
        selectionToggle("合集").getAttribute("aria-expanded") === "false",
        "合集默认收起语义错误",
      );
      assert(
        selectionToggle("合集").className === selectionTriggerClass,
        "选集与合集的标题开关样式不一致",
      );
      passed.push("多 P / 合集并入相关视频，当前分 P 仅在自身有限高列表内定位");

      await toggleSelection("选集");
      checkClosed("parts", "选集", parts);
      flushSync(() => changeProps((props) => ({ ...props, cid: 45 })));
      await frames();
      checkClosed("parts", "选集", parts);
      await toggleSelection("选集");
      parts = checkList("parts", card);
      assert(
        parts.querySelector('[aria-current="true"]').textContent.includes("P45"),
        "重新展开未定位当前分 P",
      );
      flushSync(() => changeProps((props) => ({ ...props, cid: 40 })));
      await frames();
      passed.push("多 P 可收起且隐藏项不可聚焦；同稿件换 P 保持收起，重开只滚内部当前项");

      const sourceQueue = [
        {
          id: "source_1",
          bvid: "source",
          cid: 1,
          aid: "source",
          title: "来源队列",
          duration: 0,
          cover: "",
        },
      ];
      usePlaylistStore.getState().setPlaylist(sourceQueue, "source_1", "sequence");
      await toggleSelection("合集");
      let seasonList = checkList("season", card);
      await toggleSelection("合集");
      checkClosed("season", "合集", seasonList);
      await toggleSelection("合集");
      seasonList = checkList("season", card);
      passed.push("并存合集可反复收起 / 展开，隐藏项不可聚焦且重开不挤走信息卡");
      assert(usePlaylistStore.getState().currentId === "source_1", "单纯展开合集接管了来源队列");
      flushSync(() => seasonList.querySelectorAll("button")[41].click());
      await frames();
      assert(
        usePlaylistStore.getState().items.length === 60 &&
          usePlaylistStore.getState().currentId === "BVselection42_42",
        "点合集没有设置对应队列",
      );
      await until(
        () => ui.query("[data-location]").textContent.includes("bvid=BVselection42"),
        "合集行未导航到目标视频",
      );
      flushSync(() => parts.querySelectorAll("button")[42].click());
      await frames();
      assert(
        usePlaylistStore.getState().currentId === "BVselection40_43",
        "点分 P 没有设置对应队列",
      );
      await until(
        () => ui.query("[data-location]").textContent.includes("cid=43"),
        "选集行未导航到目标 cid",
      );
      passed.push("展开不接管来源队列；点击合集 / 分 P 使用原 sequence 队列并导航");

      await selectTab("评论");
      const commentComposer = ui.query('section[aria-label="发送评论"]');
      const commentsList = ui.query('[data-slot="video-sidebar-comments-list"]');
      const commentsBottom = commentComposer.getBoundingClientRect().bottom;
      assert(
        Math.abs(commentsBottom - panel("comments").getBoundingClientRect().bottom) < 1,
        "评论发送区未固定在 Tab 最底部",
      );
      assert(commentsList.scrollHeight > commentsList.clientHeight, "评论区不能独立滚动");
      assert(
        commentsList.getBoundingClientRect().bottom <= commentComposer.getBoundingClientRect().top,
        "评论发送区覆盖列表",
      );
      commentsList.scrollTop = commentsList.scrollHeight;
      await frames();
      assert(
        commentComposer.getBoundingClientRect().bottom === commentsBottom &&
          panel("comments").scrollTop === 0,
        "评论发送区随正文滚动",
      );
      passed.push("评论沿用 CommentsPanel 独立滚动，发送评论固定底部且不覆盖正文");
      const before = parts.scrollTop;
      flushSync(() => changeProps((props) => ({ ...props, cid: 50 })));
      await frames();
      assert(parts.scrollTop === before, "非活动相关视频页签仍滚动选集");
      await selectTab("相关视频");
      checkList("parts", card);
      assert(parts.scrollTop > before, "回到相关视频后未定位新的分 P");
      passed.push("后台换集不滚动，重开相关视频后只定位内部列表");

      await selectTab("弹幕");
      const composer = ui.query('[data-slot="video-sidebar-danmaku-composer"]');
      const danmakuList = ui.query('[data-slot="video-danmaku-list"]');
      const bottom = composer.getBoundingClientRect().bottom;
      assert(
        Math.abs(bottom - panel("danmaku").getBoundingClientRect().bottom) < 1,
        "弹幕发送区不在 Tab 最底部",
      );
      assert(
        danmakuList.getBoundingClientRect().bottom <= composer.getBoundingClientRect().top,
        "发送区覆盖了列表",
      );
      danmakuList.scrollTop = danmakuList.scrollHeight;
      await frames();
      assert(
        composer.getBoundingClientRect().bottom === bottom && panel("danmaku").scrollTop === 0,
        "发送区随列表滚动",
      );
      passed.push("弹幕列表独立滚动，发送区固定 Tab 底部且不覆盖正文");

      await selectTab("相关视频");
      await toggleSelection("选集");
      assert(
        selectionToggle("合集").getAttribute("aria-expanded") === "true",
        "测试前合集应为展开态",
      );
      // 不重挂整个 Harness，直接切换已缓存稿件，覆盖收起态误继承的真实路径。
      client.setQueryData(["video_archive", "BVselection41"], {
        ...archive,
        bvid: "BVselection41",
      });
      client.setQueryData(["video_related", "BVselection41"], { items: [], has_more: false });
      flushSync(() => changeProps((props) => ({ ...props, bvid: "BVselection41", cid: 41 })));
      await frames();
      parts = checkList("parts", ui.query('section[aria-label^="UP 主信息"]'));
      checkClosed("season", "合集", seasonList);
      await toggleSelection("选集");
      await toggleSelection("合集");
      flushSync(() => changeProps((props) => ({ ...props, cid: 42 })));
      await frames();
      checkClosed("parts", "选集", parts);
      assert(
        selectionToggle("合集").getAttribute("aria-expanded") === "true",
        "同稿件换 P 重置了手动展开的合集",
      );
      passed.push("切换已缓存稿件重置选集 / 合集初始策略，同稿件换 P 则保留两者手动状态");

      client.setQueryData(["video_archive", "BVselection50"], {
        ...archive,
        bvid: "BVselection50",
        pages: [],
      });
      client.setQueryData(["video_related", "BVselection50"], { items: [], has_more: false });
      flushSync(() => changeProps((props) => ({ ...props, bvid: "BVselection50", cid: 50 })));
      await frames();
      checkTabs();
      const soloCard = ui.query('section[aria-label^="UP 主信息"]');
      seasonList = checkList("season", soloCard);
      assert(!ui.query('[data-video-selection-list="parts"]'), "无分 P 时伪造了选集");
      await toggleSelection("合集");
      checkClosed("season", "合集", seasonList);
      await toggleSelection("合集");
      seasonList = checkList("season", soloCard);
      await toggleSelection("合集");
      client.setQueryData(["video_archive", "BVselection51"], {
        ...archive,
        bvid: "BVselection51",
        pages: [],
      });
      client.setQueryData(["video_related", "BVselection51"], { items: [], has_more: false });
      flushSync(() => changeProps((props) => ({ ...props, bvid: "BVselection51", cid: 51 })));
      await frames();
      checkList("season", ui.query('section[aria-label^="UP 主信息"]'));
      passed.push("单独合集默认展开且可反复收起；切换稿件不继承收起态，无多余选集列表");

      client.setQueryData(["video_season", "", "40"], pgc);
      calls.length = 0;
      render("pgc", { bvid: "BVepisode40", epId: "40", aid: null, cid: 40 });
      await frames();
      checkTabs();
      const pgcCard = ui.query('section[aria-label="当前剧集信息"]');
      assert(pgcCard.textContent.includes("剧集 40"), "PGC 信息卡缺少当前集");
      assert(!ui.query('[name="comment"]').disabled, "PGC 未将当前分集 aid 传给评论发送区");
      let episodes = checkList("episodes", pgcCard);
      assert(
        selectionToggle("分集").className === selectionTriggerClass,
        "分集与 UGC 的标题开关样式不一致",
      );
      assert(!calls.includes("video_get_related"), "PGC 不应请求 UGC 相关视频流");
      const pgcControls = [
        ...episodes.closest('[data-slot="collapsible-content"]').querySelectorAll("button"),
      ];
      await toggleSelection("分集");
      checkClosed("episodes", "分集", episodes);
      assert(
        pgcControls.every(
          (control) => !control.isConnected || control.closest("[hidden], [inert]"),
        ),
        "PGC 收起后播放控制仍可聚焦",
      );
      client.setQueryData(["video_season", "", "50"], pgc);
      flushSync(() =>
        changeProps((props) => ({ ...props, bvid: "BVepisode50", epId: "50", cid: 50 })),
      );
      await frames();
      checkClosed("episodes", "分集", episodes);
      await toggleSelection("分集");
      episodes = checkList("episodes", pgcCard);
      assert(
        episodes.querySelector('[aria-current="true"]').textContent.includes("剧集 50"),
        "重开 PGC 未定位新分集",
      );
      passed.push("PGC 分集与播放按钮一起收起，隐藏项不可聚焦；同剧换集保留状态，重开仅内部定位");
      flushSync(() => episodes.querySelectorAll("button")[42].click());
      await frames();
      assert(usePlaylistStore.getState().currentId === "BVepisode43_43", "PGC 点击未选中分集队列");
      await until(
        () => ui.query("[data-location]").textContent.includes("ep_id=43"),
        "PGC 点击未透传 epId",
      );
      await toggleSelection("分集");
      client.setQueryData(["video_season", "", "41"], {
        ...pgc,
        season_id: "2",
        title: "另一部剧集",
      });
      flushSync(() =>
        changeProps((props) => ({ ...props, bvid: "BVepisode41", epId: "41", cid: 41 })),
      );
      await frames();
      checkList("episodes", ui.query('section[aria-label="当前剧集信息"]'));
      passed.push("切换另一部剧集后分集恢复默认展开，不继承上一部收起态");
      await selectTab("弹幕");
      assert(ui.query('[data-slot="video-sidebar-danmaku-composer"]'), "PGC 弹幕发送入口丢失");
      passed.push("PGC 使用真实当前剧集信息及分集，不伪造相关流，保留弹幕入口");
      return { passed };
    } finally {
      ui.dispose();
      client.clear();
      window.__TAURI_INTERNALS__ = oldTauri;
      usePlaylistStore.setState(oldPlaylist);
    }
  });
}
