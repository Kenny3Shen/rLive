// 真实 Shell 的 VOD 历史动画回归：查询参数换视频不重挂播放器，每层 POP 都有反向动画。
// 在已加载的 Windows Debug 主窗口内挂独立 root；仅路由页内容用轻量桩，不替换 IPC。
// playwright-cli -s=rwin run-code --filename=tests/vod-navigation-motion.browser.js
async (page) => {
  return await page.evaluate(async () => {
    const { setupHarness, dependencyUrl, assert, frames, until } =
      await import("/tests/browser/harness.js");
    const { Shell } = await import("/src/app/layout/Shell.tsx");
    const { createMemoryRouter, RouterProvider, useLocation } = await import(
      dependencyUrl("react-router-dom")
    );
    const { QueryClient, QueryClientProvider } = await import(
      dependencyUrl("@tanstack_react-query")
    );
    const ui = await setupHarness({
      style: "position:fixed;inset:0;z-index:1000;background:var(--background)",
    });
    const { React, h } = ui;
    const historyState = window.history.state;
    const originalAnimate = Element.prototype.animate;
    const originalMatchMedia = window.matchMedia;
    let reduced = false;
    const calls = [];
    let router;
    let setFullscreen;
    const queryClient = new QueryClient();
    const passed = [];
    function Player() {
      const location = useLocation();
      const [fullscreen, updateFullscreen] = React.useState(false);
      setFullscreen = updateFullscreen;
      return h(
        "section",
        { "data-test-player": location.search },
        h("div", {
          "data-player-stage": true,
          "data-fullscreen": fullscreen ? "true" : undefined,
        }, h("video")),
        location.search,
      );
    }
    const scope = () => ui.query('[data-slot="page-zoom"]');
    const video = () => ui.query("video");
    const animations = () => calls.splice(0);
    const settle = async () => {
      for (const animation of scope().getAnimations({ subtree: true })) animation.finish();
      await until(
        () =>
          scope().children.length === 1 && scope().getAnimations({ subtree: true }).length === 0,
        "动画或离场层未清理",
      );
      await frames();
      calls.length = 0;
    };
    const navigate = async (target, index, options) => {
      // MemoryRouter 没有浏览器 idx；只给真实 Shell 补它读取的历史元数据。
      // 不改变主窗口 URL，finally 原样恢复。
      history.replaceState({ ...historyState, idx: index }, "");
      await router.navigate(target, options);
      await until(() => {
        const incoming = scope()?.lastElementChild;
        return router.state.location.pathname === "/video/play"
          ? incoming?.querySelector("[data-test-player]")?.dataset.testPlayer ===
              router.state.location.search
          : incoming?.textContent.includes("列表入口");
      }, "路由尚未提交到进入层");
      await frames();
    };
    try {
      window.matchMedia = (query) =>
        query === "(prefers-reduced-motion: reduce)"
          ? { matches: reduced }
          : originalMatchMedia.call(window, query);
      Element.prototype.animate = function (...args) {
        const animation = originalAnimate.apply(this, args);
        if (ui.host.contains(this) && this.parentElement?.dataset.slot === "page-zoom") {
          animation.pause();
          animation.currentTime = 0;
          calls.push({ animation, element: this, keyframes: animation.effect.getKeyframes() });
        }
        return animation;
      };
      history.replaceState({ ...historyState, idx: 0 }, "");
      router = createMemoryRouter(
        [
          {
            element: h(Shell),
            children: [
              { path: "/settings", element: h("div", null, "列表入口") },
              { path: "/video/play", element: h(Player) },
            ],
          },
        ],
        { initialEntries: ["/settings"] },
      );
      ui.render(h(QueryClientProvider, { client: queryClient }, h(RouterProvider, { router })));
      await navigate("/video/play?bvid=A&cid=1", 1);
      const entered = animations();
      assert(
        entered.length === 1,
        `进入 VOD 未触发单次缩放：${JSON.stringify(entered.map((x) => ({ state: x.animation.playState, frames: x.keyframes })))}`,
      );
      const instance = video();
      await settle();

      for (const [name, index] of [
        ["B", 2],
        ["C", 3],
      ]) {
        await navigate(`/video/play?bvid=${name}&cid=${index}`, index);
        const entry = animations();
        assert(entry.length === 1, `进入 ${name} 没有同路径动画`);
        assert(entry[0].keyframes[0].transform === "scale(0.96)", "深入层级缩放方向不对");
        assert(
          video() === instance && ui.host.querySelectorAll("video").length === 1,
          "同路径导航重建/复制了播放器",
        );
        await settle();
      }
      passed.push("A→B→C 每层进入都有动画且始终复用同一个媒体节点");

      await navigate("/video/play?bvid=C&cid=3&title=补齐元数据", 3, { replace: true });
      assert(animations().length === 0, "REPLACE 补齐参数不应重播动画");
      passed.push("同历史层 REPLACE 不重播动画");

      for (const [name, index] of [
        ["B", 2],
        ["A", 1],
      ]) {
        await navigate(-1, index);
        const exit = animations();
        assert(exit.length === 1, `返回 ${name} 丢失动画`);
        assert(exit[0].keyframes[0].transform === "scale(1.02)", `返回 ${name} 仍是向前动画`);
        exit[0].animation.currentTime = Number(exit[0].animation.effect.getTiming().duration) / 2;
        const scale = new DOMMatrixReadOnly(getComputedStyle(exit[0].element).transform).a;
        assert(scale > 1 && scale < 1.02, `返回 ${name} 没有真实中间帧`);
        assert(
          video() === instance &&
            ui.query("[data-test-player]").textContent.includes(`bvid=${name}`),
          "返回未复用节点或参数不对",
        );
        await settle();
      }
      passed.push("C→B→A 连续返回均有反向中间帧，节点不重挂载");

      await navigate(1, 2);
      const forward = animations()[0];
      assert(forward?.keyframes[0].transform === "scale(0.96)", "历史前进被误判为返回");
      // 动画未完成立即返回，旧动画须取消，不能在旧 finished 回调里清掉新动画。
      await navigate(-1, 1);
      const interrupted = animations()[0];
      assert(interrupted && forward.animation.playState === "idle", "快速返回未接管旧动画");
      assert(interrupted.keyframes[0].transform === "scale(1.02)", "快速返回方向不对");
      await settle();
      passed.push("POP 前进方向正确，快速返回取消旧动画");

      ui.flushSync(() => setFullscreen(true));
      await navigate(1, 2);
      assert(animations().length === 0 && video() === instance, "全屏换片触发了祖先缩放/重挂载");
      assert(scope().lastElementChild.style.transform === "" && scope().lastElementChild.style.willChange === "", "全屏舞台仍有变换的包含块");
      await navigate(-1, 1);
      assert(animations().length === 0, "全屏内返回仍触发缩放");
      ui.flushSync(() => setFullscreen(false));
      passed.push("全屏内换片/返回不变换 fixed 舞台祖先");

      reduced = true;
      await navigate(1, 2);
      assert(animations().length === 0 && video() === instance, "减少动态效果仍启动动画/重挂载");
      reduced = false;
      await navigate(-1, 1);
      await settle();
      passed.push("遵循减少动态效果设置");

      await navigate(-1, 0);
      assert(scope().children.length === 2, "离开播放路径未保留离场层");
      assert(
        video() === instance && ui.query("[data-test-player]").textContent.includes("bvid=A"),
        "离场层丢失旧参数/节点",
      );
      await settle();
      assert(video() === null, "离场播放器未卸载");
      passed.push("最后返回入口保留旧参数与退出动画，结束后卸载播放器");
      return { passed };
    } finally {
      ui.dispose();
      router?.dispose();
      queryClient.clear();
      Element.prototype.animate = originalAnimate;
      window.matchMedia = originalMatchMedia;
      history.replaceState(historyState, "");
    }
  });
}
