// Windows 主窗口：真实 VideoDanmakuLayer + danmu.js，媒体事件由夹具控制。
// playwright-cli -s=rwin run-code --filename=tests/video-danmaku-pause.browser.js
async (page) => {
  return page.evaluate(async () => {
    const { setupHarness, assert, frames, until } = await import("/tests/browser/harness.js");
    const { VideoDanmakuLayer } = await import("/src/features/video/VideoDanmakuLayer.tsx");
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
      style:
        "position:fixed;left:80px;top:80px;width:800px;height:400px;z-index:999;background:#111;pointer-events:none",
    });
    const { h, createRef, render, query } = harness;
    const videoRef = createRef();
    let time = 0;
    let paused = false;
    let instance;
    const DanmuJs = await loadDanmuJs();
    const originalSend = DanmuJs.prototype.sendComment;
    DanmuJs.prototype.sendComment = function (comment) {
      if (harness.host.contains(this.container)) instance = this;
      return originalSend.call(this, comment);
    };
    const entries = ["scroll", "scroll", "top", "bottom"].map((mode, index) => ({
      id: `pause-${index}`,
      mode,
      progressMs: 100,
      color: "#ffffff",
      pool: 0,
      content: `暂停位置回归 ${index}`,
    }));
    const dispatch = (type) => videoRef.current.dispatchEvent(new Event(type));
    const positions = () =>
      entries.map(({ id }) => {
        const element = query(`[data-rlive-danmaku-id="${id}"]`);
        assert(element, `弹幕意外消失：${id}`);
        return element.getBoundingClientRect().left;
      });
    const unchanged = (before, label) => {
      const after = positions();
      after.forEach((x, index) => {
        assert(
          Math.abs(x - before[index]) < 0.1,
          `${label}：${entries[index].id} 跳变 ${(x - before[index]).toFixed(3)}px`,
        );
      });
    };
    const passed = [];
    try {
      useSettingsStore.setState({
        danmakuFontSize: 24,
        danmakuSpeed: 100,
        danmakuArea: 1,
        danmakuOpacity: 1,
        danmakuShieldWords: [],
      });
      render(
        h(
          "section",
          null,
          h("video", { ref: videoRef }),
          h(VideoDanmakuLayer, { videoRef, entries, active: true, interactive: false }),
        ),
      );
      Object.defineProperties(videoRef.current, {
        currentTime: { configurable: true, get: () => time },
        paused: { configurable: true, get: () => paused },
      });
      await until(() => query("[data-video-danmaku-layer].danmu"), "弹幕实例未就绪");
      await frames();

      for (const shift of [0, 12, -17]) {
        harness.host.style.transform = "none";
        time = 0;
        dispatch("seeking");
        paused = false;
        dispatch("play");
        time = 0.1;
        dispatch("timeupdate");
        await until(() => positions()[0] < 850, "滚动弹幕未开始移动");
        // 只移动、不改变尺寸：复现页面转场/布局位移不触发 ResizeObserver 的情况。
        harness.host.style.transform = `translateX(${shift}px)`;
        await frames();
        if (shift !== 0) {
          assert(
            Math.abs(instance.containerPos.left - instance.container.getBoundingClientRect().left) >
              1,
            "夹具没有制造容器原点缓存过期",
          );
        }
        for (let cycle = 0; cycle < 3; cycle++) {
          const before = positions();
          paused = true;
          dispatch("pause");
          unchanged(before, `位移 ${shift}px，第 ${cycle + 1} 次暂停`);
          const stopped = positions();
          await frames();
          unchanged(stopped, "暂停后仍在移动");
          dispatch("pause");
          unchanged(stopped, "重复暂停改变位置");
          paused = false;
          dispatch("play");
          unchanged(stopped, "恢复瞬间改变位置");
          await until(() => positions()[0] < stopped[0] - 3, "恢复后没有继续向左滚动");
        }
        passed.push(`容器位移 ${shift}px：连续暂停无跳变、保持静止、恢复向左滚动，固定弹幕保留`);
      }

      // 不在暂停前测量布局：保留已有 transition，在帧间切换，覆盖合成线程动画。
      const scrolling = query('[data-rlive-danmaku-id="pause-0"]');
      const transition = scrolling.getAnimations().find((item) => item.transitionProperty === "transform");
      assert(transition, "缺少滚动动画");
      const originalLeft = scrolling.style.left;
      for (let cycle = 0; cycle < 20; cycle++) {
        await new Promise((resolve) => setTimeout(resolve, 33));
        paused = true;
        dispatch("pause");
        assert(scrolling.getAnimations().includes(transition), "暂停取消并重建了滚动时间轴");
        assert(scrolling.style.left === originalLeft, "暂停把动画采样位置重新写回 left");
        await transition.ready;
        const stopped = positions();
        await frames();
        unchanged(stopped, "合成动画暂停后仍在移动");
        paused = false;
        dispatch("play");
        assert(scrolling.getAnimations().includes(transition), "恢复重建了滚动时间轴");
        await until(() => positions()[0] < stopped[0] - 1, "恢复后未继续向左移动");
      }
      passed.push("帧间快速暂停/恢复 20 次保持同一动画，不重定位，暂停稳定且恢复向左移动");

      // 暂停期间点选再解除，会由 danmu.js 取消 transition；恢复不能复活旧动画。
      paused = true;
      dispatch("pause");
      instance.freezeComment("pause-0");
      instance.restartComment("pause-0");
      const released = positions()[0];
      paused = false;
      dispatch("play");
      await until(() => positions()[0] < released - 3, "暂停时点选再解除后无法恢复");
      assert(!scrolling.getAnimations().includes(transition), "复活了已取消的旧动画");
      passed.push("暂停时点选再解除正确交还原生动画，不复活旧 transition");

      // 已点选冻结的弹幕在媒体暂停/恢复后仍须保持冻结。
      instance.freezeComment("pause-1");
      const pinned = positions()[1];
      paused = true;
      dispatch("pause");
      paused = false;
      dispatch("play");
      await frames();
      assert(Math.abs(positions()[1] - pinned) < 0.1, "媒体恢复解除了单条弹幕的冻结");
      const finishing = scrolling.getAnimations().find((item) => item.transitionProperty === "transform");
      assert(finishing, "恢复后滚动动画丢失");
      finishing.finish();
      await until(() => !scrolling.isConnected, "滚动结束没有移除弹幕");
      assert(!instance.state.bullets.some((bullet) => bullet.id === "pause-0"), "滚动结束没有释放主队列");
      assert(!instance.main.channel.channels.some((channel) => channel.queue.scroll.some((bullet) => bullet.id === "pause-0")), "滚动结束没有释放车道");
      passed.push("暂停/恢复后动画结束仍正常移除 DOM、主队列与车道");
      time = 30;
      dispatch("seeking");
      assert(!query("[data-rlive-danmaku-id]"), "seek 后旧弹幕残留");
      passed.push("点选冻结不被恢复播放解除，seek 清理旧弹幕");
      return { passed };
    } finally {
      DanmuJs.prototype.sendComment = originalSend;
      harness.dispose();
      useSettingsStore.setState(settings, true);
    }
  });
}
