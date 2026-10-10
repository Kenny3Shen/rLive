// Windows 主窗口 / Vite 页面：真实 VideoDanmakuLayer + danmu.js，仅替换媒体时钟。
// playwright-cli -s=rwin run-code --filename=tests/video-danmaku-expiry.browser.js
async (page) => {
  return page.evaluate(async () => {
    const { setupHarness, assert, frames, until } = await import("/tests/browser/harness.js");
    const { VideoDanmakuLayer } = await import("/src/features/video/VideoDanmakuLayer.tsx");
    const { VIDEO_DANMAKU_FIXED_DURATION_MS } = await import("/src/features/video/videoDanmaku.ts");
    const { loadDanmuJs } = await import("/src/features/room/danmaku/danmuJsLoader.ts");
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
    const passed = [];
    // 只捕获此夹具的实例，以同时核对 DOM、主队列和车道没有失去同步。
    const DanmuJs = await loadDanmuJs();
    const originalSend = DanmuJs.prototype.sendComment;
    let instance;
    DanmuJs.prototype.sendComment = function (comment) {
      if (harness.host.contains(this.container)) instance = this;
      return originalSend.call(this, comment);
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
    const advanceTo = (target) => {
      while (time < target) {
        time = Math.min(target, time + 0.25);
        dispatch("timeupdate");
      }
    };
    const bullet = (id) => query(`[data-rlive-danmaku-id="${id}"]`);
    const queued = (id) => instance.main.queue.some((item) => item.id === id);
    const onTrack = (id) =>
      instance.main.channel.channels.some((channel) =>
        ["top", "bottom", "scroll"].some((mode) =>
          channel.queue[mode].some((item) => item.id === id),
        ),
      );
    const fixed = (id, mode, color, progressMs = 100) => ({
      id,
      mode,
      color,
      progressMs,
      content: `固定弹幕 ${id}`,
      pool: 0,
    });
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
      await until(() => query("[data-video-danmaku-layer].danmu"), "弹幕实例未就绪");
      await frames();

      for (const color of ["#ff0000", "#ffffff"]) {
        entries = [
          fixed("top-first", "top", "#ffffff"),
          fixed("top-next", "top", color),
          fixed("bottom-first", "bottom", color),
          fixed("bottom-next", "bottom", "#00aaff"),
          fixed("top-later", "top", color, 1_100),
        ];
        active = true;
        paint();
        time = 0;
        dispatch("seeking");
        paused = false;
        dispatch("play");
        advanceTo(1.1);
        await frames();
        for (const entry of entries) {
          assert(bullet(entry.id) && queued(entry.id), `弹幕未上屏：${entry.id}`);
          assert(getComputedStyle(bullet(entry.id)).visibility === "visible", "固定弹幕不可见");
        }
        assert(getComputedStyle(bullet("bottom-next")).color === "rgb(0, 170, 255)", "颜色未保留");

        paused = true;
        dispatch("pause");
        await frames();
        assert(
          entries.every((entry) => bullet(entry.id)),
          "暂停清掉了固定弹幕",
        );
        paused = false;
        dispatch("play");
        advanceTo(VIDEO_DANMAKU_FIXED_DURATION_MS / 1_000);
        assert(
          entries.every((entry) => bullet(entry.id)),
          "固定弹幕提前到期",
        );
        advanceTo(VIDEO_DANMAKU_FIXED_DURATION_MS / 1_000 + 0.1);
        const expired = entries.slice(0, 4);
        const remaining = expired.filter((entry) => bullet(entry.id)).map((entry) => entry.id);
        assert(remaining.length === 0, `到期后残留固定弹幕（${color}）：${remaining.join(", ")}`);
        assert(
          expired.every((entry) => !queued(entry.id) && !onTrack(entry.id)),
          "到期未释放队列或车道",
        );
        assert(bullet("top-later") && queued("top-later"), "删除相邻弹幕使未到期弹幕丢失跟踪");

        // 隐藏期间仍应按媒体时间清理；重新显示不能让到期弹幕复活。
        active = false;
        paint();
        advanceTo(VIDEO_DANMAKU_FIXED_DURATION_MS / 1_000 + 1.1);
        active = true;
        paint();
        assert(
          !bullet("top-later") && !queued("top-later") && !onTrack("top-later"),
          "隐藏期间到期弹幕残留",
        );
        passed.push(`${color} 相邻顶部/底部弹幕按时清理，未到期邻居保留，隐藏不妨碍到期`);

        // seek 重投验证车道可复用，且原弹幕已彻底移除。
        time = 0;
        dispatch("seeking");
        advanceTo(1.1);
        assert(
          entries.every((entry) => bullet(entry.id) && queued(entry.id)),
          "seek 后车道未释放或弹幕无法重投",
        );
        time = 30;
        dispatch("seeking");
        assert(!query("[data-rlive-danmaku-id]"), "seek 后旧弹幕残留");
      }
      return { passed };
    } finally {
      DanmuJs.prototype.sendComment = originalSend;
      harness.dispose();
      useSettingsStore.setState(settings, true);
    }
  });
}
