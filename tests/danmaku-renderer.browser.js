// Windows 主窗口：DanmakuRenderer 生命周期边界回归（固定弹幕钉住寿命、零尺寸、固定组上限、改速不跳变、滚动走合成器动画）。
// playwright-cli -s=rwin run-code --filename=tests/danmaku-renderer.browser.js
async (page) => {
  return page.evaluate(async () => {
    const { assert, frames, until } = await import("/tests/browser/harness.js");
    // 只测渲染器本身：带时间戳导入，确保读取最新源码而不必刷新用户正在使用的页面。
    const { DanmakuRenderer: Renderer } = await import(
      `/src/features/room/danmaku/danmakuRenderer.ts?t=${Date.now()}`
    );
    const passed = [];
    const stage = document.createElement("div");
    stage.style.cssText = "position:fixed;left:0;top:0;width:800px;height:400px;z-index:999;pointer-events:none";
    document.body.append(stage);
    const media = document.createElement("video");
    // 夹具媒体时钟是手动步进的：`step()` 每帧推进 `time`，`ratechange` 让渲染器跟上倍速。
    // 倍速漂移用例另用墙钟夹具（见下方 `rateClock`），那里模拟真实管线的换速延迟。
    let time = 0;
    let rate = 1;
    Object.defineProperties(media, {
      currentTime: { configurable: true, get: () => time },
      paused: { configurable: true, get: () => false },
      playbackRate: { configurable: true, get: () => rate },
    });
    const node = (id) => stage.querySelector(`[data-rlive-danmaku-id="${id}"]`);
    const left = (id) => node(id).getBoundingClientRect().left;
    const comment = (id, mode, at, duration) => ({ id, mode, time: at, duration, text: `边界回归 ${id}` });
    /**
     * 把合成器动画推进与手动步进的媒体时钟相同的本地时间。
     *
     * `step()` 一帧就把媒体时间推 0.5s（相当于 30 倍速），而合成器只能按墙钟推进。
     * 不把两者绑定的话，渲染器会把「媒体跑得比合成器快」当成漂移去校正，测出的位置与
     * 真实播放无关。只推进运行中的动画，已冻结的不动。
     */
    const localTimes = new WeakMap();
    const advanceAnimations = (deltaSeconds) => {
      for (const motion of stage.getAnimations({ subtree: true })) {
        if (motion.playState !== "running") continue;
        const tracked = localTimes.has(motion) ? localTimes.get(motion) : motion.currentTime;
        if (typeof tracked !== "number") continue;
        const next = tracked + deltaSeconds * 1_000;
        motion.currentTime = next;
        localTimes.set(motion, next);
      }
    };
    const step = async (target) => {
      while (time < target) {
        const next = Math.min(target, time + 0.5);
        const delta = next - time;
        time = next;
        advanceAnimations(delta);
        await frames();
      }
    };
    let renderer;
    try {
      renderer = new Renderer({ container: stage, media, speed: 100 });

      // 固定弹幕钉住超过剩余寿命，释放后仍按剩余寿命显示，而不是被立即判为到期。
      renderer.setComments([comment("fixed-pin", "top", 0.05, 4_000), comment("scroll-a", "scroll", 0.05)]);
      media.dispatchEvent(new Event("seeking"));
      media.dispatchEvent(new Event("playing"));
      await step(1);
      await until(() => renderer.has("fixed-pin"), "固定弹幕未上屏");
      assert(renderer.pin("fixed-pin"), "固定弹幕无法钉住");
      await step(6);
      assert(renderer.has("fixed-pin"), "钉住期间固定弹幕到期");
      renderer.unpin("fixed-pin");
      await frames();
      assert(renderer.has("fixed-pin"), "释放后固定弹幕被立即移除");
      // t=1 钉住时剩余约 3.05s，t=6 释放后应在 t≈9.05 到期。
      await step(8.5);
      assert(renderer.has("fixed-pin"), "释放后固定弹幕未保留剩余寿命");
      await step(9.5);
      assert(!renderer.has("fixed-pin"), "固定弹幕顺延后没有按剩余寿命到期");
      passed.push("钉住暂停固定弹幕寿命，释放后按剩余时长到期");

      // 改速度保持在途位置，不跳变。
      time = 0;
      renderer.setComments([comment("scroll-speed", "scroll", 0.05)]);
      media.dispatchEvent(new Event("seeking"));
      await step(2);
      await until(() => node("scroll-speed"), "滚动弹幕未上屏");
      await frames();
      // 滚动位移必须走合成器动画：主线程逐帧写 transform 会让 currentTime 抖动直接变成画面抖动。
      const motions = node("scroll-speed").parentElement.getAnimations();
      assert(motions.length === 1 && motions[0].playState === "running", "滚动弹幕未使用合成器动画");
      // 滚动弹幕由合成器按真实时间推进；本夹具的媒体时钟是手动步进的，量位置前必须像真实
      // 媒体停住时那样发 pause，否则动画与冻结的媒体时间之间的差会被误判为改速跳变。
      media.dispatchEvent(new Event("pause"));
      await frames();
      const beforeSpeed = left("scroll-speed");
      renderer.setSpeed(200);
      await frames();
      assert(Math.abs(left("scroll-speed") - beforeSpeed) < 1, `改速跳变 ${(left("scroll-speed") - beforeSpeed).toFixed(2)}px`);
      media.dispatchEvent(new Event("playing"));
      await step(2.5);
      assert(left("scroll-speed") < beforeSpeed - 40, "改速后没有按新速度继续");
      passed.push("改速度保持在途位置并按新速度继续");

      /*
        长按倍速：媒体换速有管线延迟（实测 WebView2 上约 150ms 才真正按新倍速推进），
        而动画是即时换速的。两者产生的偏差如果靠硬写 `currentTime` 校正，画面上就是
        一次回拉/前跳 —— 长按 3 倍速开始与结束各跳一下。

        夹具用墙钟推进媒体时钟（而不是上面的手动步进），换速后额外滞后一段再追上，
        以复现这个时序。断言：换速前后单帧位移在当前速率下不回退、不超过期望值的
        1.5 倍（硬写 `currentTime` 会产生这样的尖刺），且 1.5s 内收敛到 30ms 以内。
      */
      const rateClock = (() => {
        let wallAnchor = performance.now();
        let mediaAt = 0;
        let rate = 1;
        /** 换速时刻的 `{wall, media}`：滞后窗口内媒体仍按旧倍速推进。 */
        let lag = null;
        const LAG_SECONDS = 0.15;
        const mediaNow = () => {
          const wall = performance.now();
          if (lag) {
            const elapsed = (wall - lag.wall) / 1_000;
            if (elapsed < LAG_SECONDS) return lag.media + elapsed * lag.rate;
            mediaAt = lag.media + LAG_SECONDS * lag.rate + (elapsed - LAG_SECONDS) * rate;
            wallAnchor = wall;
            lag = null;
            return mediaAt;
          }
          return mediaAt + ((wall - wallAnchor) / 1_000) * rate;
        };
        return {
          get currentTime() {
            return mediaNow();
          },
          get playbackRate() {
            return rate;
          },
          setRate(next, element) {
            const at = mediaNow();
            mediaAt = at;
            wallAnchor = performance.now();
            if (next === rate) return;
            lag = { wall: wallAnchor, media: at, rate };
            rate = next;
            element.dispatchEvent(new Event("ratechange"));
          },
        };
      })();
      const rateStage = document.createElement("div");
      rateStage.style.cssText = "position:fixed;left:0;top:400px;width:800px;height:400px;pointer-events:none";
      document.body.append(rateStage);
      const rateMedia = document.createElement("video");
      Object.defineProperties(rateMedia, {
        currentTime: { configurable: true, get: () => rateClock.currentTime },
        paused: { configurable: true, get: () => false },
        seeking: { configurable: true, get: () => false },
        playbackRate: { configurable: true, get: () => rateClock.playbackRate },
      });
      const rateRenderer = new Renderer({ container: rateStage, media: rateMedia, speed: 100 });
      try {
        const START = 0.05;
        const driftMs = () => (rateMotion.currentTime ?? 0) - (rateMedia.currentTime - START) * 1_000;
        rateRenderer.setComments([comment("rate-sync", "scroll", START)]);
        rateMedia.dispatchEvent(new Event("playing"));
        await until(
          () => rateStage.querySelector('[data-rlive-danmaku-id="rate-sync"]'),
          "倍速夹具弹幕未上屏",
        );
        const rateNode = rateStage.querySelector('[data-rlive-danmaku-id="rate-sync"]');
        const rateMotion = rateNode.parentElement.getAnimations()[0];
        await rateMotion.ready;
        // 先让渲染器与媒体对齐，否则初始偏差会被下面的校正断言误读。
        await until(() => Math.abs(driftMs()) < 60, "倍速夹具未与媒体同步");
        /**
         * 采样一段时间内动画的单帧位移。
         *
         * 期望步长取 `墙钟帧长 × 媒体倍速`：动画必须按媒体时钟走，既不能回退，
         * 也不应该出现远超期望的尖刺（那就是硬对齐写回旧采样或跳到新位置）。
         */
        const sampleSteps = async (ms, expectedRate) => {
          const steps = [];
          const end = performance.now() + ms;
          let previous = rateMotion.currentTime;
          let previousWall = performance.now();
          while (performance.now() < end) {
            await frames();
            const wall = performance.now();
            const current = rateMotion.currentTime;
            steps.push({
              motion: current - previous,
              wall: wall - previousWall,
              diff: driftMs(),
            });
            previous = current;
            previousWall = wall;
          }
          return steps;
        };
        const assertNoJump = (steps, rate, label) => {
          for (const step of steps) {
            // 单帧位移不能为负（动画时间回退），也不能超过期望步长的 1.5 倍。
            assert(step.motion >= -0.5, `${label}：动画回退 ${step.motion.toFixed(1)}ms`);
            const expected = step.wall * rate;
            assert(
              step.motion <= expected * 1.5 + 2,
              `${label}：单帧位移 ${step.motion.toFixed(1)}ms 超过期望 ${expected.toFixed(1)}ms 的 1.5 倍`,
            );
          }
        };
        assertNoJump(await sampleSteps(300, 1), 1, "1x 基线");

        // 长按开始：3 倍速。
        rateClock.setRate(3, rateMedia);
        assertNoJump(await sampleSteps(600, 3), 3, "3x");
        await until(
          () => Math.abs(driftMs()) < 30,
          `3x 后未在 1.5s 内收敛：${driftMs().toFixed(1)}ms`,
          1500,
        );

        // 长按结束：回到 1 倍速。
        rateClock.setRate(1, rateMedia);
        assertNoJump(await sampleSteps(600, 1), 1, "回 1x");
        await until(
          () => Math.abs(driftMs()) < 30,
          `回到 1x 后未在 1.5s 内收敛：${driftMs().toFixed(1)}ms`,
          1500,
        );
        passed.push("长按 3 倍速开始与结束均不回退、不尖刺，并在 1.5s 内收敛到 30ms 内");
      } finally {
        rateRenderer.destroy();
        rateStage.remove();
      }

      // 零尺寸：在途弹幕不产生 NaN 位置，新弹幕不投放；恢复尺寸后继续投放。
      stage.style.width = "0px";
      await frames();
      renderer.resize();
      await step(3);
      const transforms = [...stage.querySelectorAll("[data-danmaku-group] > div > div")].map((el) => el.style.transform);
      assert(transforms.every((value) => !value.includes("NaN")), `零尺寸产生 NaN：${transforms.join(" ")}`);
      stage.style.width = "800px";
      await frames();
      renderer.resize();
      time = 0;
      renderer.setComments([comment("after-resize", "scroll", 0.05)]);
      media.dispatchEvent(new Event("seeking"));
      await step(1);
      await until(() => renderer.has("after-resize"), "恢复尺寸后无法投放");
      passed.push("零尺寸不写坏位置，恢复后正常投放");

      // 固定弹幕时长各异时原生实例有上限；超出的并入不短于自身时长的组，不会提前到期。
      const durations = [4_000, 6_000, 8_000, 10_000, 12_000, 5_000];
      renderer.setComments(
        durations.map((ms, i) => comment(`fixed-${ms}`, i % 2 ? "bottom" : "top", 0.05, ms)),
      );
      media.dispatchEvent(new Event("seeking"));
      await step(1);
      const groupKeys = [...stage.querySelectorAll('[data-danmaku-group^="fixed:"]')].map((el) => el.dataset.danmakuGroup);
      assert(groupKeys.length <= 4, `固定弹幕原生实例过多：${groupKeys.join(", ")}`);
      // 5s 弹幕超出上限：应并入 6s 组，到 5.5s 仍在屏。
      await step(5.5);
      assert(renderer.has("fixed-5000"), "超出上限的固定弹幕被并入更短的组而提前到期");
      passed.push(`不同时长固定弹幕共用 ${groupKeys.length} 个原生实例，超出的不提前到期`);

      renderer.destroy();
      assert(!stage.querySelector("[data-danmaku-group]"), "destroy 后残留原生舞台");
      passed.push("destroy 清理全部原生舞台");

      // `appendComments` 增量追加：分段加载不能重建整条时间轴，也不能补投过去的分段。
      time = 0;
      const appendStage = document.createElement("div");
      appendStage.style.cssText = "position:fixed;left:0;top:0;width:800px;height:400px;pointer-events:none";
      document.body.append(appendStage);
      const appended = new Renderer({ container: appendStage, media, speed: 100 });
      try {
        const seg = (name, from) =>
          Array.from({ length: 12 }, (_, i) => comment(`${name}-${i}`, "scroll", from + i * 0.2));
        time = 100;
        appended.appendComments(seg("past", 10));
        appended.appendComments(seg("future", 105));
        media.dispatchEvent(new Event("seeking"));
        media.dispatchEvent(new Event("playing"));
        await frames();
        await frames();
        // 增量追加必须把游标留在“当前时间”：过去的 40 条不能一次性补投，未来的仍要按时间入场。
        const onScreen = [...appendStage.querySelectorAll("[data-rlive-danmaku-id]")].map((el) =>
          el.dataset.rliveDanmakuId,
        );
        assert(
          onScreen.every((id) => !id.startsWith("past-")),
          `增量追加补投了过去的分段：${onScreen.filter((id) => id.startsWith("past-")).join(",")}`,
        );
        await step(106.5);
        await until(
          () => [...appendStage.querySelectorAll("[data-rlive-danmaku-id]")].some((el) => el.dataset.rliveDanmakuId.startsWith("future-")),
          "增量追加后未来弹幕没有入场",
        );
        passed.push("appendComments 不补投过去分段，未来弹幕仍按时间入场");

        // 重复追加同一 id 不得重复登记；时间轴里一个 id 只应存在一条。
        appended.appendComments(seg("future", 105));
        const duplicated = [...appendStage.querySelectorAll("[data-rlive-danmaku-id='future-0']")].length;
        assert(duplicated <= 1, `重复 append 产生了重复节点：${duplicated}`);
        passed.push("appendComments 对已登记 id 幂等");

        // `remove` 必须同时清掉尚未上屏的时间轴条目，否则它稍后仍会被投放。
        appended.remove("future-11");
        await step(108.5);
        assert(
          !appendStage.querySelector("[data-rlive-danmaku-id='future-11']"),
          "remove 没有清掉未上屏的时间轴条目",
        );
        passed.push("remove 清理未上屏的时间轴条目");

        // `setComments` 换成新对象后，`remove` 仍要能按 id 摘掉它（记录与时间轴可能不同实例）。
        time = 200;
        appended.setComments(seg("reset", 201));
        appended.remove("reset-3");
        await step(202.5);
        assert(
          !appendStage.querySelector("[data-rlive-danmaku-id='reset-3']"),
          "setComments 换对象后 remove 失效",
        );
        passed.push("setComments 换对象后 remove 仍按 id 生效");

        // 墓碑压实：移除超过阈值会重建时间轴并修正原生游标。
        // 游标修正错了会把已过去的历史整段重播，所以必须同时验证“移除的不再出现”
        // 与“未移除的仍按时间入场”。
        time = 300;
        const bulk = Array.from({ length: 600 }, (_, i) => comment(`bulk-${i}`, "scroll", 300.2 + i * 0.05));
        appended.setComments(bulk);
        media.dispatchEvent(new Event("seeking"));
        media.dispatchEvent(new Event("playing"));
        await step(300.5);
        // 隔一条移除一条：移除数超过 COMPACT_THRESHOLD(512)，必然触发至少一次压实。
        const removedBulk = [];
        for (let i = 0; i < bulk.length; i += 2) {
          removedBulk.push(`bulk-${i}`);
          appended.remove(`bulk-${i}`);
        }
        await step(305);
        const afterCompact = [...appendStage.querySelectorAll("[data-rlive-danmaku-id]")].map(
          (el) => el.dataset.rliveDanmakuId,
        );
        const leaked = afterCompact.filter((id) => removedBulk.includes(id));
        assert(leaked.length === 0, `压实前已移除的弹幕仍被投放：${leaked.slice(0, 5).join(",")}`);
        // 偶数号被移除，奇数号必须全部正常入场（600 条 × 0.05s ≈ 30s 窗口内）。
        const survivors = afterCompact.filter((id) => id.startsWith("bulk-"));
        assert(
          survivors.length > 0 && survivors.every((id) => Number(id.slice(5)) % 2 === 1),
          `压实后存活集合异常：${survivors.slice(0, 5).join(",")}`,
        );
        passed.push("墓碑压实后已移除的不重播，未移除的仍按时间入场");
      } finally {
        appended.destroy();
        appendStage.remove();
      }

      return { passed };
    } finally {
      renderer?.destroy();
      stage.remove();
    }
  });
}
