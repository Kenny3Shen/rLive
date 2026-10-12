// Windows 主窗口：补充异步媒体状态、长任务和恢复时钟偏差，不能用同步 pause 夹具替代。
// playwright-cli -s=rwin run-code --filename=tests/video-danmaku-pause-async.browser.js
async (page) => {
  return page.evaluate(async () => {
    const { assert, frame, frames, until } = await import("/tests/browser/harness.js");
    const { DanmakuRenderer } = await import(
      `/src/features/room/danmaku/danmakuRenderer.ts?t=${Date.now()}`
    );
    const stage = document.createElement("div");
    stage.style.cssText = "position:fixed;left:80px;top:80px;width:800px;height:300px;z-index:999;pointer-events:none";
    document.body.append(stage);
    const passed = [];
    let renderer;
    let stream;
    let timer;
    let realMedia;
    const motionFor = (id) => stage.querySelector(`[data-rlive-danmaku-id="${id}"]`)?.parentElement.getAnimations()[0];
    const sample = (motion) => {
      assert(typeof motion.currentTime === "number", "动画时间不可读");
      return motion.currentTime;
    };
    // RTL 动画的时间不能减小；逐帧断言，避免先回退后前进掩盖终点差值。
    const monotonic = async (motion, ms, label) => {
      let previous = sample(motion);
      const end = performance.now() + ms;
      while (performance.now() < end) {
        await frame();
        const next = sample(motion);
        assert(next >= previous - 0.1, `${label}：动画回退 ${(previous - next).toFixed(2)}ms`);
        previous = next;
      }
    };
    try {
      for (const rate of [1, 2]) {
        const media = document.createElement("video");
        let paused = false;
        let waiting = false;
        let seeking = false;
        let base = 0;
        let anchor = performance.now();
        const now = () => base + (paused || waiting ? 0 : (performance.now() - anchor) / 1_000 * rate);
        const stopClock = () => { base = now(); anchor = performance.now(); };
        const dispatch = (type) => media.dispatchEvent(new Event(type));
        const play = () => {
          anchor = performance.now();
          paused = waiting = false;
          dispatch("playing");
        };
        Object.defineProperties(media, {
          currentTime: { get: now },
          paused: { get: () => paused },
          seeking: { get: () => seeking },
          playbackRate: { get: () => rate },
        });
        renderer = new DanmakuRenderer({ container: stage, media });
        renderer.setComments([{ id: "async", mode: "scroll", time: 0.05, text: "异步暂停回归" }]);
        dispatch("playing");
        await until(() => motionFor("async"), "异步夹具弹幕未上屏");
        const motion = motionFor("async");
        await motion.ready;
        await frames();

        // 故障注入：paused 已变，但 pause 事件迟到，原生 rAF 仍可能执行。
        stopClock();
        paused = true;
        await monotonic(motion, 250, `${rate}x，pause 事件前`);
        assert(motion.playState === "paused", "未按同步媒体状态提前冻结");
        const frozen = sample(motion);
        dispatch("pause");
        await frames();
        assert(Math.abs(sample(motion) - frozen) < 0.1, "迟到的 pause 再次移动弹幕");
        dispatch("playing");
        await frames();
        assert(motion.playState === "paused", "已暂停的媒体被迟到 playing 复活");

        // 故障注入：合成器在迟到暂停前已领先媒体超过 DRIFT_MS，恢复不得回拉。
        motion.currentTime += 350;
        const ahead = sample(motion);
        play();
        assert(sample(motion) >= ahead - 0.1, "playing 瞬间回退");
        await monotonic(motion, 250, `${rate}x，恢复后校时`);
        assert(sample(motion) > ahead + 100, "恢复后未继续前进");
        dispatch("playing");
        await monotonic(motion, 120, "重复 playing");
        passed.push(`${rate}x：迟到 pause 提前冻结、迟到 playing 不复活、领先 350ms 的恢复不回退`);

        // 采样补偿按动画倍速计算；不能仅补普通墙钟毫秒。
        await motion.ready;
        stopClock(); paused = true;
        const sampled = sample(motion);
        const blockedAt = performance.now();
        while (performance.now() - blockedAt < 200) { /* 模拟主线程长任务。 */ }
        dispatch("pause");
        assert(sample(motion) >= sampled + 200 * rate - 30, `${rate}x 长任务暂停写回旧采样`);
        const caughtUp = sample(motion);
        play();
        assert(sample(motion) >= caughtUp - 0.1, `${rate}x 长任务后恢复回退`);
        await monotonic(motion, 150, `${rate}x 长任务后恢复`);
        passed.push(`${rate}x：长任务暂停按倍速补偿采样延迟`);

        stopClock();
        waiting = true;
        dispatch("waiting");
        const waitingAt = sample(motion);
        await monotonic(motion, 150, "waiting");
        assert(Math.abs(sample(motion) - waitingAt) < 0.1, "waiting 后仍在移动");
        motion.currentTime += 350;
        const waitingAhead = sample(motion);
        play();
        assert(sample(motion) >= waitingAhead - 0.1, "缓冲恢复瞬间回退");
        await monotonic(motion, 150, "缓冲恢复后校时");

        stopClock(); paused = true; dispatch("pause");
        play();
        stopClock(); paused = true; dispatch("pause");
        const rapidAt = sample(motion);
        await frames();
        assert(motion.playState === "paused" && Math.abs(sample(motion) - rapidAt) < 0.1,
          "快速 pause→play→pause 后有旧恢复操作生效");
        play();
        await monotonic(motion, 120, "快速切换后恢复");
        // 已缓冲位置 seek：先同步 seeking，再派发事件，完成后未必有新 playing。
        seeking = true;
        await frames();
        assert(motion.playState === "running", "seeking 状态窗口错误地冻结了渲染器");
        base = 0;
        anchor = performance.now();
        dispatch("seeking");
        assert(renderer.size === 0 && motion.playState === "idle", "seek 后遗留动画");
        seeking = false;
        dispatch("seeked");
        await until(() => motionFor("async")?.playState === "running", "seek 后缺少 playing 导致新弹幕冻结");
        renderer.destroy();
        renderer = undefined;
      }
      passed.push("缓冲恢复、重复事件、快速切换，以及 seek 无 playing 的继续投放通过");

      // 真实 HTMLVideoElement，不覆盖 paused/currentTime，也不伪造 pause 事件。
      // 本地 canvas 媒体避免网络、账号和观看历史副作用；长任务制造采样时间落后。
      realMedia = document.createElement("video");
      realMedia.muted = true;
      realMedia.style.cssText = "position:absolute;width:1px;height:1px";
      stage.append(realMedia);
      const canvas = document.createElement("canvas");
      canvas.width = 160;
      canvas.height = 90;
      const context = canvas.getContext("2d");
      const draw = () => {
        context.fillStyle = `hsl(${performance.now() % 360} 50% 50%)`;
        context.fillRect(0, 0, canvas.width, canvas.height);
      };
      draw();
      stream = canvas.captureStream(30);
      timer = setInterval(draw, 33);
      realMedia.srcObject = stream;
      await realMedia.play();
      renderer = new DanmakuRenderer({ container: stage, media: realMedia });
      renderer.setComments([{ id: "real", mode: "scroll", time: realMedia.currentTime + 0.1, text: "真实媒体暂停回归" }]);
      await until(() => motionFor("real"), "真实媒体弹幕未上屏");
      const motion = motionFor("real");
      await motion.ready;
      await frames();
      const samples = {};
      realMedia.addEventListener("pause", () => {
        samples.before = sample(motion);
        const started = performance.now();
        while (performance.now() - started < 250) { /* 模拟暂停事件先执行的 UI 长任务。 */ }
        samples.blockedMs = performance.now() - started;
        samples.stale = sample(motion);
      }, { capture: true, once: true });
      const pausedEvent = new Promise((resolve) => realMedia.addEventListener("pause", resolve, { once: true }));
      realMedia.pause();
      await pausedEvent;
      await frames();
      samples.frozen = sample(motion);
      // 不能只验证 DOM 几何：同一任务里的几何和 currentTime 都可能是旧采样。
      assert(samples.frozen >= samples.before + samples.blockedMs - 30,
        `长任务后写回旧采样：${JSON.stringify(samples)}`);
      await frames();
      assert(Math.abs(sample(motion) - samples.frozen) < 0.1, "真实 pause 落定后仍在移动");
      await realMedia.play();
      assert(sample(motion) >= samples.frozen - 0.1, "真实 playing 瞬间回退");
      await monotonic(motion, 300, "真实媒体恢复后");
      assert(sample(motion) > samples.frozen + 100, "真实媒体恢复后未前进");
      passed.push("真实 pause 事件遇 250ms 长任务：补偿旧采样、冻结后静止、恢复不回退");
      return { passed, samples };
    } finally {
      renderer?.destroy();
      realMedia?.pause();
      stream?.getTracks().forEach((track) => track.stop());
      clearInterval(timer);
      stage.remove();
    }
  });
}
