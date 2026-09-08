// 在 Vite 开发预览页运行，复用真实弹幕组件和 danmu.js，不依赖平台接口：
// playwright-cli -s=danmaku-preview run-code --filename=tests/video-danmaku-layout.browser.js
async (page) => {
  return await page.evaluate(async () => {
    const dependencyUrl = (name) => {
      const entry = performance.getEntriesByType("resource").find((resource) => {
        const url = new URL(resource.name);
        return url.pathname.endsWith(`/deps/${name}.js`) && url.searchParams.has("v");
      });
      if (!entry) throw new Error(`请先打开 Vite 开发预览页：未找到 ${name}`);
      return entry.name;
    };
    const { default: React } = await import(dependencyUrl("react"));
    const { default: ReactDOMClient } = await import(dependencyUrl("react-dom_client"));
    const { default: ReactDOM } = await import(dependencyUrl("react-dom"));
    const { VideoDanmakuLayer } = await import("/src/features/video/VideoDanmakuLayer.tsx");
    const { useVideoDanmakuTopInset } =
      await import("/src/features/video/useVideoDanmakuTopInset.ts");
    const { loadDanmuJs } = await import("/src/features/room/danmaku/danmuJsLoader.ts");
    await loadDanmuJs();
    const { createElement: h, createRef } = React;
    const { flushSync } = ReactDOM;
    const assert = (condition, message) => {
      if (!condition) throw new Error(message);
    };
    const until = async (predicate, message) => {
      const deadline = performance.now() + 5000;
      while (!predicate()) {
        assert(performance.now() < deadline, message);
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    };
    const frames = async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root = ReactDOMClient.createRoot(host);
    const hudRef = createRef();
    const videoRef = createRef();
    const stageRef = createRef();
    const entries = ["scroll", "top", "bottom"].map((mode, index) => ({
      id: `hud-layout-${mode}`,
      progressMs: 100,
      mode,
      content: `弹幕边界回归 ${index + 1}`,
      color: "#ffffff",
      pool: 0,
    }));
    function Harness({ avoidHud }) {
      useVideoDanmakuTopInset(stageRef, hudRef, avoidHud);
      return h(
        "section",
        {
          ref: stageRef,
          "data-player-stage": true,
          "data-fullscreen": "true",
          style: { "--android-safe-area-top": "48.75px", background: "#000", zIndex: 999 },
        },
        h("video", { ref: videoRef, style: { position: "absolute", inset: 0 } }),
        h(VideoDanmakuLayer, {
          videoRef,
          entries,
          active: true,
        }),
        h(
          "div",
          {
            ref: hudRef,
            "data-player-hud": true,
            style: {
              position: "absolute",
              inset: "0 0 auto",
              display: "flex",
              paddingTop: "max(0.375rem, var(--player-safe-area-top, 0px))",
              paddingBottom: "12px",
            },
          },
          h("button", { style: { width: "36px", height: "36px" }, "aria-label": "返回" }),
        ),
      );
    }
    const render = (avoidHud) =>
      flushSync(() => root.render(h(React.StrictMode, null, h(Harness, { avoidHud }))));
    const layer = () => host.querySelector("[data-video-danmaku-layer]");
    const rect = (element) => element.getBoundingClientRect();
    const aligned = () => Math.abs(rect(layer()).top - rect(hudRef.current).bottom) < 1;
    const results = [];
    try {
      render(true);
      let time = 0;
      Object.defineProperties(videoRef.current, {
        currentTime: { configurable: true, get: () => time },
        paused: { configurable: true, get: () => false },
      });
      await until(() => layer().classList.contains("danmu"), "弹幕实例未启动");
      assert(aligned(), "首帧弹幕层未避开 HUD 与安全区");
      assert(
        Math.abs(rect(layer()).bottom - rect(stageRef.current).bottom) < 1,
        "弹幕层下移后超出了播放区域",
      );
      results.push("首帧避让 HUD，底边保持不动");

      time = 0.1;
      videoRef.current.dispatchEvent(new Event("play"));
      videoRef.current.dispatchEvent(new Event("timeupdate"));
      await until(
        () => layer().querySelectorAll("[data-line-index]").length >= 3,
        "滚动、顶部或底部弹幕未真正渲染",
      );
      const bullet = layer().querySelector("[data-line-index]");
      for (const item of layer().querySelectorAll("[data-line-index]")) {
        assert(rect(item).top >= rect(hudRef.current).bottom, "弹幕被 HUD 遮住");
        assert(rect(item).bottom <= rect(layer()).bottom + 1, "弹幕超出下边界");
      }
      const startLeft = rect(bullet).left;
      await until(() => rect(bullet).left < startLeft - 2, "滚动弹幕没有移动");
      results.push("三类弹幕实际渲染，滚动保持正常");

      hudRef.current.style.opacity = "0";
      await frames();
      assert(aligned(), "HUD 隐藏后弹幕跳回了顶部");
      hudRef.current.style.opacity = "1";
      stageRef.current.style.setProperty("--android-safe-area-top", "72.25px");
      await until(aligned, "安全区变化后未重新测量 HUD");
      assert(rect(layer()).top >= 120, "未使用更新后的安全区");
      hudRef.current.style.paddingBottom = "24px";
      await until(aligned, "HUD padding 变化未触发 border-box 观察");
      assert(rect(layer()).top >= 132, "未避开增高后的 HUD");
      results.push("HUD 显隐不跳动，安全区及内边距变化同步更新");

      render(false);
      await frames();
      assert(
        Math.abs(rect(layer()).top - rect(stageRef.current).top) < 1,
        "普通详情/桌面模式残留顶部偏移",
      );
      assert(
        Math.abs(rect(layer()).height - rect(stageRef.current).height) < 1,
        "普通模式未恢复完整高度",
      );
      assert(layer().contains(bullet), "仅切换布局就重建了弹幕实例");
      hudRef.current.style.paddingBottom = "40px";
      await frames();
      assert(
        stageRef.current.style.getPropertyValue("--video-danmaku-top") === "",
        "退出避让后旧 observer 仍在修改布局",
      );
      results.push("退出模式恢复范围并清理 observer，不重建弹幕");

      render(true);
      await until(aligned, "再次进入竖屏未恢复避让");
      const detachedStage = stageRef.current;
      flushSync(() => root.unmount());
      assert(
        detachedStage.style.getPropertyValue("--video-danmaku-top") === "",
        "卸载后遗留顶部样式",
      );
      results.push("再次进入与卸载清理正常");
      return {
        viewport: [innerWidth, innerHeight],
        userAgent: navigator.userAgent,
        passed: results,
      };
    } finally {
      if (host.childNodes.length) flushSync(() => root.unmount());
      host.remove();
    }
  });
}
