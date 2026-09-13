// 在 Vite 开发页运行：playwright-cli -s=danmaku-preview run-code --filename=tests/video-portrait-layout.browser.js
async (page) => {
  return await page.evaluate(async () => {
    const { setupHarness, assert, frames } = await import("/tests/browser/harness.js");
    const { PlayerControls } = await import("/src/shared/components/player/PlayerControls.tsx");
    const { VideoJsPlayerProvider } = await import("/src/features/room/player/videoJsControls.tsx");
    const { VideoDanmakuLayer } = await import("/src/features/video/VideoDanmakuLayer.tsx");
    const { useVideoDanmakuTopInset } =
      await import("/src/features/video/useVideoDanmakuTopInset.ts");

    const ui = await setupHarness();
    const { h, createRef, query, rect } = ui;
    const stageRef = createRef();
    const hudRef = createRef();
    const videoRef = createRef();

    function Harness({ portrait, width, height, top, bottom }) {
      useVideoDanmakuTopInset(stageRef, hudRef, portrait);
      return h(
        "section",
        {
          ref: stageRef,
          "data-player-stage": true,
          "data-fullscreen": "true",
          "data-video-portrait": portrait ? "true" : undefined,
          className: "relative flex min-w-0 flex-col overflow-hidden bg-black",
          style: {
            width,
            height,
            zIndex: 999,
            "--android-safe-area-top": `${top}px`,
            "--android-safe-area-bottom": `${bottom}px`,
          },
        },
        h(
          "div",
          { "data-video-viewport": true, className: "relative flex min-h-0 flex-1 flex-col bg-black" },
          h(
            "div",
            { "data-video-frame": true, className: "relative flex min-h-0 flex-1 flex-col" },
            h(
              "div",
              {
                "data-player-video-surface": true,
                className: "relative min-h-0 flex-1 overflow-hidden bg-black",
              },
              h("video", { ref: videoRef, className: "absolute inset-0 size-full object-contain" }),
              h(VideoDanmakuLayer, { videoRef, entries: [], active: false }),
            ),
            h(
              "div",
              { ref: hudRef, "data-player-hud": true, className: "absolute inset-x-0 top-0" },
              h(
                "div",
                { className: "flex pt-[max(0.375rem,var(--player-safe-area-top,0px))] pb-3" },
                h("button", { style: { width: 36, height: 36 }, "aria-label": "返回" }),
              ),
            ),
            h(
              "div",
              {
                "data-video-short-overlay": true,
                className:
                  "pointer-events-none absolute inset-x-0 bottom-0 pb-[calc(5.5rem+env(safe-area-inset-bottom))]",
              },
              h("div", { style: { height: 48 } }),
            ),
          ),
        ),
        h(
          "div",
          { "data-player-controls": true, className: "absolute inset-x-0 bottom-0" },
          h(
            VideoJsPlayerProvider,
            null,
            h(PlayerControls, {
              compact: true,
              fullscreen: true,
              systemGestureBarReserved: portrait,
            }),
          ),
        ),
      );
    }

    const render = (props) => ui.render(h(Harness, props));
    const cases = [
      { width: 412, height: 915, top: 48.75, bottom: 24 },
      { width: 360, height: 732, top: 24, bottom: 24 },
      { width: 360, height: 640, top: 24, bottom: 24 },
      { width: 390, height: 844, top: 59, bottom: 34 },
      { width: 800, height: 1280, top: 28, bottom: 24 },
      { width: 844, height: 390, top: 0, bottom: 24 },
    ];
    const results = [];
    try {
      for (const dimensions of cases) {
        render({ ...dimensions, portrait: true });
        await frames();
        const picture = rect("[data-video-frame]");
        const hud = rect("[data-player-hud]");
        const danmaku = rect("[data-video-danmaku-layer]");
        const controls = rect("[data-player-controls]");
        const info = rect("[data-video-short-overlay]");
        assert(Math.abs(picture.top - dimensions.top) < 1, "画面没有紧贴状态栏下边界");
        assert(Math.abs(picture.width / picture.height - 9 / 16) < 0.002, "画面不再保持9:16");
        assert(picture.width <= dimensions.width + 1, "画面横向溢出");
        assert(
          Math.abs(hud.top - picture.top) < 1 && Math.abs(hud.width - picture.width) < 1,
          "HUD未叠在画面顶部",
        );
        assert(danmaku.top >= hud.bottom && danmaku.top - hud.bottom < 1, "弹幕没有紧贴HUD下边界");
        assert(Math.abs(danmaku.bottom - picture.bottom) < 1, "弹幕底边未限定在画面内");
        assert(controls.top >= picture.bottom - 1, "控制栏覆盖了画面");
        assert(
          Math.abs(controls.bottom - (dimensions.height - dimensions.bottom)) < 1,
          "底部手势栏未正确占位",
        );
        assert(Math.abs(info.bottom - picture.bottom) < 1, "用户信息未锚定画面底部");
        // 舞台外层已预留上下安全区，画面内 HUD 与控制栏都不得再消费一次。
        //
        // 控制栏按类名判定：桌面浏览器里 `env(safe-area-inset-bottom)` 恒为 0，
        // `pb-[max(0.25rem,env(...))]` 与 `pb-1` 算出的 padding 都是 4px，
        // 用 computed 值无法区分它走了哪条分支。
        const reserving = [...query("[data-player-controls]").querySelectorAll("*")].filter((el) =>
          el.className.toString().includes("safe-area-inset-bottom"),
        );
        assert(
          reserving.length === 0,
          `控制栏在舞台已预留手势栏时又消费了一次 env(safe-area-inset-bottom)（${reserving.length} 处）`,
        );
        // HUD 走 `--player-safe-area-top` 变量，夹具里能取到真实值，可直接量 padding。
        assert(
          parseFloat(getComputedStyle(hudRef.current.firstElementChild).paddingTop) <= 6.01,
          "画面内 HUD 重复预留了状态栏",
        );
        results.push({
          ...dimensions,
          picture: [picture.width, picture.height],
          danmakuTop: danmaku.top,
          controlsTop: controls.top,
        });
      }

      const originalVideo = videoRef.current;
      render({ ...cases[0], portrait: false });
      await frames();
      assert(videoRef.current === originalVideo, "模式切换重建了媒体元素");
      assert(
        stageRef.current.style.getPropertyValue("--video-danmaku-top") === "",
        "退出模式残留弹幕偏移",
      );
      assert(rect("[data-video-frame]").top === 0, "普通模式未恢复原有舞台");
      render({ ...cases[0], portrait: true });
      await frames();
      assert(
        videoRef.current === originalVideo && rect("[data-video-danmaku-layer]").top > cases[0].top,
        "再次进入模式失败",
      );
      return { passed: results, modeRoundTrip: true };
    } finally {
      ui.dispose();
    }
  });
}
