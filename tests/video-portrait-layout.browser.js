// 在 Vite 开发页运行：playwright-cli -s=danmaku-preview run-code --filename=tests/video-portrait-layout.browser.js
async (page) => {
  return await page.evaluate(async () => {
    const dependencyUrl = (name) => {
      const entry = performance.getEntriesByType("resource").find((resource) => {
        const url = new URL(resource.name);
        return url.pathname.endsWith(`/deps/${name}.js`) && url.searchParams.has("v");
      });
      if (!entry) throw new Error(`未找到 Vite 依赖 ${name}`);
      return entry.name;
    };
    const { default: React } = await import(dependencyUrl("react"));
    const { default: ReactDOMClient } = await import(dependencyUrl("react-dom_client"));
    const { default: ReactDOM } = await import(dependencyUrl("react-dom"));
    const { PlayerControls } = await import("/src/shared/components/player/PlayerControls.tsx");
    const { VideoDanmakuLayer } = await import("/src/features/video/VideoDanmakuLayer.tsx");
    const { useVideoDanmakuTopInset } = await import("/src/features/video/useVideoDanmakuTopInset.ts");
    const { createElement: h, createRef } = React;
    const { flushSync } = ReactDOM;
    const host = document.createElement("div");
    document.body.append(host);
    const root = ReactDOMClient.createRoot(host);
    const stageRef = createRef();
    const hudRef = createRef();
    const videoRef = createRef();
    const assert = (condition, message) => { if (!condition) throw new Error(message); };
    const frames = async () => {
      await new Promise(resolve => requestAnimationFrame(resolve));
      await new Promise(resolve => requestAnimationFrame(resolve));
    };
    const noop = () => {};
    function Harness({ portrait, width, height, top, bottom }) {
      useVideoDanmakuTopInset(stageRef, hudRef, portrait);
      return h("section", {
        ref: stageRef,
        "data-player-stage": true,
        "data-fullscreen": "true",
        "data-video-portrait": portrait ? "true" : undefined,
        className: "relative flex min-w-0 flex-col overflow-hidden bg-black",
        style: { width, height, zIndex: 999, "--android-safe-area-top": `${top}px`, "--android-safe-area-bottom": `${bottom}px` },
      }, h("div", { "data-video-viewport": true, className: "relative flex min-h-0 flex-1 flex-col bg-black" },
        h("div", { "data-video-frame": true, className: "relative flex min-h-0 flex-1 flex-col" },
          h("div", { "data-player-video-surface": true, className: "relative min-h-0 flex-1 overflow-hidden bg-black" },
            h("video", { ref: videoRef, className: "absolute inset-0 size-full object-contain" }),
            h(VideoDanmakuLayer, { videoRef, entries: [], active: false }),
          ),
          h("div", { ref: hudRef, "data-player-hud": true, className: "absolute inset-x-0 top-0" },
            h("div", { className: "flex pt-[max(0.375rem,var(--player-safe-area-top,0px))] pb-3" },
              h("button", { style: { width: 36, height: 36 }, "aria-label": "返回" }),
            ),
          ),
          h("div", { "data-video-short-overlay": true, className: "pointer-events-none absolute inset-x-0 bottom-0 pb-[calc(5.5rem+env(safe-area-inset-bottom))]" },
            h("div", { style: { height: 48 } }),
          ),
        ),
      ), h("div", { "data-player-controls": true, className: "absolute inset-x-0 bottom-0" },
        h(PlayerControls, {
          paused: true, volume: 100, compact: true, fullscreen: true,
          systemGestureBarReserved: portrait, timeline: h("div", { style: { height: 24 } }),
          onTogglePause: noop, onVolume: noop, onToggleMute: noop, onToggleFullscreen: noop,
        }),
      ));
    }
    const query = (selector) => host.querySelector(selector);
    const rect = (selector) => query(selector).getBoundingClientRect();
    const render = (props) => flushSync(() => root.render(h(React.StrictMode, null, h(Harness, props))));
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
        assert(Math.abs(hud.top - picture.top) < 1 && Math.abs(hud.width - picture.width) < 1, "HUD未叠在画面顶部");
        assert(danmaku.top >= hud.bottom && danmaku.top - hud.bottom < 1, "弹幕没有紧贴HUD下边界");
        assert(Math.abs(danmaku.bottom - picture.bottom) < 1, "弹幕底边未限定在画面内");
        assert(controls.top >= picture.bottom - 1, "控制栏覆盖了画面");
        assert(Math.abs(controls.bottom - (dimensions.height - dimensions.bottom)) < 1, "底部手势栏未正确占位");
        assert(Math.abs(info.bottom - picture.bottom) < 1, "用户信息未锚定画面底部");
        assert(parseFloat(getComputedStyle(query('[data-slot="player-controls-bar"]')).paddingBottom) <= 1, "控制栏重复预留了安全区");
        results.push({ ...dimensions, picture: [picture.width, picture.height], danmakuTop: danmaku.top, controlsTop: controls.top });
      }
      const originalVideo = videoRef.current;
      render({ ...cases[0], portrait: false });
      await frames();
      assert(videoRef.current === originalVideo, "模式切换重建了媒体元素");
      assert(stageRef.current.style.getPropertyValue("--video-danmaku-top") === "", "退出模式残留弹幕偏移");
      assert(rect("[data-video-frame]").top === 0, "普通模式未恢复原有舞台");
      render({ ...cases[0], portrait: true });
      await frames();
      assert(videoRef.current === originalVideo && rect("[data-video-danmaku-layer]").top > cases[0].top, "再次进入模式失败");
      return { passed: results, modeRoundTrip: true };
    } finally {
      flushSync(() => root.unmount());
      host.remove();
    }
  });
}
