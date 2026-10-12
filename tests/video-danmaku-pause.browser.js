// Windows 主窗口：真实 VideoDanmakuLayer + DanmakuRenderer，媒体事件由夹具控制。
// playwright-cli -s=rwin run-code --filename=tests/video-danmaku-pause.browser.js
async (page) => {
  return page.evaluate(async () => {
    const { setupHarness, assert, frames, until } = await import("/tests/browser/harness.js");
    // HMR 后也复用同一版依赖，避免拿旧 loader 的类去探测新组件实例。
    const version = Date.now();
    const { VideoDanmakuLayer } = await import(`/src/features/video/VideoDanmakuLayer.tsx?t=${version}`);
    const { loadDanmakuRenderer } = await import(`/src/features/room/danmaku/danmakuLoader.ts?t=${version}`);
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
    let baseTime = 0;
    let anchor = performance.now();
    let rate = 1;
    let paused = true;
    let waiting = false;
    let renderer;
    const mediaTime = () =>
      baseTime + (!paused && !waiting ? ((performance.now() - anchor) / 1_000) * rate : 0);
    const commitTime = () => {
      baseTime = mediaTime();
      anchor = performance.now();
    };
    const Renderer = await loadDanmakuRenderer();
    const originalSetComments = Renderer.prototype.setComments;
    Renderer.prototype.setComments = function (comments) {
      if (comments.some((comment) => String(comment.id).startsWith("pause-"))) renderer = this;
      return originalSetComments.call(this, comments);
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
    const seekTo = (position) => {
      commitTime();
      baseTime = position;
      anchor = performance.now();
      dispatch("seeking");
    };
    const pause = () => {
      commitTime();
      paused = true;
      dispatch("pause");
    };
    const wait = () => {
      commitTime();
      waiting = true;
      dispatch("waiting");
    };
    const play = () => {
      commitTime();
      paused = false;
      waiting = false;
      anchor = performance.now();
      dispatch("playing");
    };
    const setRate = (nextRate) => {
      commitTime();
      rate = nextRate;
      anchor = performance.now();
      dispatch("ratechange");
    };
    const bullet = (id) => {
      const element = query(`[data-rlive-danmaku-id="${id}"]`);
      if (element) return element;
      return [...query("[data-video-danmaku-layer]").querySelectorAll("*")].find(
        (candidate) => candidate.textContent?.trim() === entries.find((entry) => entry.id === id)?.content,
      );
    };
    const positions = () =>
      entries.map(({ id }) => {
        const element = bullet(id);
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
    const settlePause = async (before, label) => {
      await frames();
      const frozen = positions();
      frozen.forEach((x, index) => {
        assert(x <= before[index] + 0.1, `${label}：${entries[index].id} 暂停时回退`);
      });
      await frames();
      unchanged(frozen, `${label}：暂停落定后仍在移动`);
      return frozen;
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
        currentTime: { configurable: true, get: mediaTime },
        paused: { configurable: true, get: () => paused },
        playbackRate: { configurable: true, get: () => rate },
      });
      await until(() => renderer, "弹幕渲染器未就绪");
      seekTo(0);
      play();
      await until(() => mediaTime() >= 0.2 && bullet("pause-0"), "滚动弹幕未开始移动");

      for (const shift of [0, 12, -17]) {
        harness.host.style.transform = "none";
        seekTo(0);
        play();
        await until(() => mediaTime() >= 0.2 && bullet("pause-0"), "滚动弹幕未开始移动");
        harness.host.style.transform = `translateX(${shift}px)`;
        await frames();
        const before = positions();
        pause();
        const frozen = await settlePause(before, `位移 ${shift}px，暂停`);
        pause();
        unchanged(frozen, "重复 pause 改变位置");
        play();
        unchanged(frozen, "playing 瞬间改变位置");
        await until(() => positions()[0] < frozen[0] - 3, "playing 后没有继续向左滚动");
      }
      passed.push("容器位移与连续暂停均保持原位，playing 后继续移动");

      const beforeWaiting = positions();
      wait();
      const frozenWaiting = await settlePause(beforeWaiting, "waiting");
      play();
      unchanged(frozenWaiting, "waiting 后恢复瞬间改变位置");
      await until(() => positions()[0] < frozenWaiting[0] - 3, "waiting 后没有恢复移动");
      passed.push("waiting 冻结弹幕，playing 恢复同一位置继续移动");

      const beforeRate = positions();
      setRate(2);
      unchanged(beforeRate, "ratechange 改变弹幕位置");
      await frames();
      assert(positions()[0] < beforeRate[0], "ratechange 后弹幕没有继续按媒体时钟移动");
      passed.push("ratechange 不重定位、不清屏");

      renderer.pin("pause-1");
      const pinned = bullet("pause-1").getBoundingClientRect().left;
      pause();
      play();
      await frames();
      assert(Math.abs(bullet("pause-1").getBoundingClientRect().left - pinned) < 0.1, "单条 pin 未保持暂停");
      renderer.unpin("pause-1");
      await until(
        () => bullet("pause-1").getBoundingClientRect().left < pinned - 3,
        "unpin 后滚动弹幕无法恢复",
      );
      passed.push("单条 pin 跨媒体暂停保持冻结，unpin 后恢复");

      seekTo(30);
      await frames();
      assert(!query("[data-rlive-danmaku-id]"), "seek 后旧弹幕残留");
      assert(renderer.size === 0, "seek 后 renderer 仍保留旧弹幕");
      passed.push("seek 清理旧弹幕和 renderer 记录");
      return { passed };
    } finally {
      Renderer.prototype.setComments = originalSetComments;
      harness.dispose();
      useSettingsStore.setState(settings, true);
    }
  });
}
