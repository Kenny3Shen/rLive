// Windows 主窗口 / Vite 页面：真实 VideoDanmakuLayer + DanmakuRenderer，仅替换媒体时钟。
// playwright-cli -s=rwin run-code --filename=tests/video-danmaku-expiry.browser.js
async (page) => {
  return page.evaluate(async () => {
    const { setupHarness, assert, frames, until } = await import("/tests/browser/harness.js");
    const { VideoDanmakuLayer } = await import("/src/features/video/VideoDanmakuLayer.tsx");
    const { VIDEO_DANMAKU_FIXED_DURATION_MS } = await import("/src/features/video/videoDanmaku.ts");
    const { loadDanmakuRenderer } = await import("/src/features/room/danmaku/danmakuLoader.ts");
    const settingsUrl =
      performance
        .getEntriesByType("resource")
        .find(
          (resource) => new URL(resource.name).pathname === "/src/shared/stores/settingsStore.ts",
        )?.name ?? "/src/shared/stores/settingsStore.ts";
    const { useSettingsStore } = await import(settingsUrl);
    const settings = useSettingsStore.getState();
    const harness = await setupHarness({
      style: "position:fixed;inset:0;z-index:999;background:#111;pointer-events:none",
    });
    const { h, createRef, render, query } = harness;
    const videoRef = createRef();
    let time = 0;
    let paused = false;
    let active = true;
    let entries = [];
    let renderer;
    const passed = [];
    const Renderer = await loadDanmakuRenderer();
    // 首次上屏走 `appendComments`（增量追加），外观变化才走 `setComments`；两个入口都要能捕获实例。
    const originalSetComments = Renderer.prototype.setComments;
    const originalAppendComments = Renderer.prototype.appendComments;
    const testIds = new Set(["top-first", "top-next", "bottom-first", "bottom-next", "top-later"]);
    const capture = function (comments) {
      if (comments.some((comment) => testIds.has(String(comment.id)))) renderer = this;
    };
    Renderer.prototype.setComments = function (comments) {
      capture.call(this, comments);
      return originalSetComments.call(this, comments);
    };
    Renderer.prototype.appendComments = function (comments) {
      capture.call(this, comments);
      return originalAppendComments.call(this, comments);
    };
    const paint = () =>
      render(
        h(
          "section",
          null,
          h("video", { ref: videoRef }),
          h(VideoDanmakuLayer, { videoRef, entries, active, interactive: false }),
        ),
      );
    const dispatch = (type) => videoRef.current.dispatchEvent(new Event(type));
    const advanceTo = async (target) => {
      while (time < target) {
        time = Math.min(target, time + 0.25);
        await frames();
      }
    };
    const bullet = (id) => query(`[data-rlive-danmaku-id="${id}"]`);
    // 弹幕时刻与夹具推进点错开：原生仅投放 time < currentTime 的弹幕，到期为严格大于 duration。
    const fixed = (id, mode, color, progressMs = 50) => ({
      id,
      mode,
      color,
      progressMs,
      content: `固定弹幕 ${id}`,
      pool: 0,
    });
    const assertVisible = (entry) => {
      const element = bullet(entry.id);
      assert(element, `弹幕未上屏：${entry.id}`);
      assert(getComputedStyle(element).visibility !== "hidden", `固定弹幕不可见：${entry.id}`);
    };
    try {
      useSettingsStore.setState({
        danmakuFontSize: 24,
        danmakuArea: 1,
        danmakuOpacity: 1,
        danmakuShieldWords: [],
      });
      paint();
      Object.defineProperties(videoRef.current, {
        currentTime: { configurable: true, get: () => time },
        paused: { configurable: true, get: () => paused },
      });

      for (const color of ["#ff0000", "#ffffff"]) {
        entries = [
          fixed("top-first", "top", "#ffffff"),
          fixed("top-next", "top", color),
          fixed("bottom-first", "bottom", color),
          fixed("bottom-next", "bottom", "#00aaff"),
          fixed("top-later", "top", color, 1_050),
        ];
        active = true;
        paint();
        await until(() => renderer, "弹幕渲染器未就绪");
        time = 0;
        paused = false;
        dispatch("seeking");
        dispatch("playing");
        await advanceTo(1.1);
        for (const entry of entries) {
          assertVisible(entry);
          assert(renderer.has(entry.id), `renderer 未记录弹幕：${entry.id}`);
        }
        assert(getComputedStyle(bullet("bottom-next")).color === "rgb(0, 170, 255)", "颜色未保留");

        paused = true;
        dispatch("pause");
        await frames();
        assert(entries.every((entry) => bullet(entry.id)), "暂停清掉了固定弹幕");
        paused = false;
        dispatch("playing");
        await advanceTo(VIDEO_DANMAKU_FIXED_DURATION_MS / 1_000);
        assert(entries.every((entry) => bullet(entry.id)), "固定弹幕提前到期");
        await advanceTo(VIDEO_DANMAKU_FIXED_DURATION_MS / 1_000 + 0.1);
        const expired = entries.slice(0, 4);
        const remaining = expired.filter((entry) => bullet(entry.id)).map((entry) => entry.id);
        assert(remaining.length === 0, `到期后残留固定弹幕（${color}）：${remaining.join(", ")}`);
        assert(expired.every((entry) => !renderer.has(entry.id)), "到期后 renderer 仍保留固定弹幕");
        assert(bullet("top-later") && renderer.has("top-later"), "删除相邻弹幕使未到期弹幕丢失跟踪");

        // 隐藏期间仍应按媒体时间清理；重新显示不能让到期弹幕复活。
        active = false;
        paint();
        await advanceTo(VIDEO_DANMAKU_FIXED_DURATION_MS / 1_000 + 1.1);
        active = true;
        paint();
        await frames();
        assert(!bullet("top-later") && !renderer.has("top-later"), "隐藏期间到期弹幕残留");
        passed.push(`${color} 相邻顶部/底部弹幕按媒体时间清理，未到期邻居保留，隐藏不妨碍到期`);

        // seek 重投验证车道可复用，且原弹幕已彻底移除。
        time = 0;
        dispatch("seeking");
        paused = false;
        dispatch("playing");
        await advanceTo(1.1);
        assert(entries.every((entry) => bullet(entry.id) && renderer.has(entry.id)), "seek 后弹幕无法重投");
        time = 30;
        dispatch("seeking");
        await frames();
        assert(!query("[data-rlive-danmaku-id]"), "seek 后旧弹幕残留");
      }
      return { passed };
    } finally {
      Renderer.prototype.setComments = originalSetComments;
      Renderer.prototype.appendComments = originalAppendComments;
      harness.dispose();
      useSettingsStore.setState(settings, true);
    }
  });
}
