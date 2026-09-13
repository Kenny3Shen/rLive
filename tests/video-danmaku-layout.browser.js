// 在 Vite 开发预览页运行，复用真实弹幕组件和 danmu.js，不依赖平台接口：
// playwright-cli -s=danmaku-preview run-code --filename=tests/video-danmaku-layout.browser.js
async (page) => {
  return await page.evaluate(async () => {
    const { setupHarness, assert, frames, until } = await import("/tests/browser/harness.js");
    const { VideoDanmakuLayer } = await import("/src/features/video/VideoDanmakuLayer.tsx");
    const { useVideoDanmakuTopInset } =
      await import("/src/features/video/useVideoDanmakuTopInset.ts");
    const { loadDanmuJs } = await import("/src/features/room/danmaku/danmuJsLoader.ts");
    await loadDanmuJs();

    const ui = await setupHarness();
    const { h, createRef, rect } = ui;
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
        h(VideoDanmakuLayer, { videoRef, entries, active: true }),
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

    const render = (avoidHud) => ui.render(h(Harness, { avoidHud }));
    const layer = () => ui.query("[data-video-danmaku-layer]");
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

      // 全屏已隐藏系统栏，但原生 inset 按 getInsetsIgnoringVisibility 上报，
      // 仍是窗口化的值；HUD 再消费一次就会在画面顶部留出一条空带。
      const fullscreenHudTop = rect(hudRef.current).top;
      stageRef.current.style.setProperty("--android-safe-area-top", "72.25px");
      await frames();
      assert(
        Math.abs(rect(hudRef.current).top - fullscreenHudTop) < 1,
        "全屏 HUD 错误预留了系统状态栏空间",
      );
      assert(aligned(), "Android 安全区变化后弹幕没有继续贴合 HUD");

      // 按增量断言而不是绝对像素：绝对阈值会把「HUD 是否多让一条安全区」编码进
      // 这条与安全区无关的用例里（旧值 132 正是照修复前的 72.25+36+24 标定的）。
      // 只有 aligned() 会在两边一起错时假通过，所以这里另取一个绝对位移量。
      const layerTopBefore = rect(layer()).top;
      hudRef.current.style.paddingBottom = "24px";
      await until(
        () => Math.abs(rect(layer()).top - layerTopBefore - 12) < 1,
        "HUD 内边距增高 12px 未同步到弹幕层顶边（border-box 观察失效）",
      );
      assert(aligned(), "内边距变化后弹幕层未贴合 HUD 底边");
      results.push("HUD 显隐不跳动，安全区不重复预留且内边距变化同步更新");

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
      ui.dispose();
      assert(
        detachedStage.style.getPropertyValue("--video-danmaku-top") === "",
        "卸载后遗留顶部样式",
      );
      results.push("再次进入与卸载清理正常");
      return { viewport: [innerWidth, innerHeight], userAgent: navigator.userAgent, passed: results };
    } finally {
      ui.dispose();
    }
  });
}
