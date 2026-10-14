// Windows 主窗口：DanmakuRenderer 生命周期边界回归（固定弹幕钉住寿命、零尺寸、固定组上限、原生时间轴调度）。
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
    // 夹具媒体时钟是手动步进的：`step()` 每帧推进 `time`，原生引擎在每帧按它算 `x`。
    let time = 0;
    Object.defineProperties(media, {
      currentTime: { configurable: true, get: () => time },
      paused: { configurable: true, get: () => false },
      playbackRate: { configurable: true, get: () => 1 },
    });
    const node = (id) => stage.querySelector(`[data-rlive-danmaku-id="${id}"]`);
    const left = (id) => node(id).getBoundingClientRect().left;
    const comment = (id, mode, at, duration) => ({ id, mode, time: at, duration, text: `边界回归 ${id}` });
    const step = async (target) => {
      while (time < target) {
        time = Math.min(target, time + 0.5);
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

      // 滚动弹幕由原生时间轴推进：改速后按新速度继续向左移动，且不重建节点。
      time = 0;
      renderer.setComments([comment("scroll-speed", "scroll", 0.05)]);
      media.dispatchEvent(new Event("seeking"));
      await step(2);
      await until(() => node("scroll-speed"), "滚动弹幕未上屏");
      await frames();
      const beforeSpeed = left("scroll-speed");
      const scrollNode = node("scroll-speed");
      renderer.setSpeed(200);
      await frames();
      assert(node("scroll-speed") === scrollNode, "改速重建了弹幕节点");
      await step(2.5);
      assert(left("scroll-speed") < beforeSpeed - 40, "改速后没有按新速度继续");
      passed.push("改速后节点不重建并按新速度继续");

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

      /*
        准入判据是原生 allocate 覆盖不到的部分：原生检测到轨道冲突后走
        `channel % (height - cmt.height)` 回绕复用，宁可重叠也不丢弃。固定弹幕
        整屏同发时轨道会被瞬间占满，此时全靠 canAttach 拒绝。夹具必须用墙钟媒体
        （与原生 `_utc` 同源）真实推进数秒，固定弹幕才会堆满轨道；用逐帧跳进媒体
        时间的夹具只能上屏十几条，测不出这条边界（去掉判据实测 2 269 处重叠）。
      */
      const crowdStage = document.createElement("div");
      crowdStage.style.cssText = "position:fixed;left:0;top:420px;width:800px;height:400px;pointer-events:none";
      document.body.append(crowdStage);
      const crowdAnchor = performance.now();
      const crowdMedia = document.createElement("video");
      Object.defineProperties(crowdMedia, {
        currentTime: { configurable: true, get: () => (performance.now() - crowdAnchor) / 1_000 },
        paused: { configurable: true, get: () => false },
        playbackRate: { configurable: true, get: () => 1 },
      });
      const crowd = new Renderer({ container: crowdStage, media: crowdMedia, speed: 100 });
      try {
        crowd.setComments(
          Array.from({ length: 200 }, (_, i) => ({
            id: `crowd-${i}`,
            mode: i % 2 ? "top" : "bottom",
            time: 0.05 + i * 0.004,
            duration: 15_000,
            text: `拥挤固定弹幕 ${i}`,
            style: { fontSize: "24px", lineHeight: "1.35" },
          })),
        );
        await until(() => crowdStage.querySelector("[data-danmaku-group]"), "拥挤夹具分组未建立");
        crowdMedia.dispatchEvent(new Event("seeking"));
        crowdMedia.dispatchEvent(new Event("playing"));
        const overlapCount = () => {
          const boxes = [...crowdStage.querySelectorAll("[data-rlive-danmaku-id]")].map((el) => {
            const rect = el.parentElement.getBoundingClientRect();
            return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
          });
          let count = 0;
          for (let i = 0; i < boxes.length; i += 1) {
            for (let j = i + 1; j < boxes.length; j += 1) {
              const a = boxes[i];
              const b = boxes[j];
              if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
                  Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) count += 1;
            }
          }
          return count;
        };
        let worstOverlaps = 0;
        let framesSeen = 0;
        const crowdEnd = performance.now() + 3_000;
        while (performance.now() < crowdEnd) {
          await frames();
          framesSeen += 1;
          if (framesSeen % 8 === 0) worstOverlaps = Math.max(worstOverlaps, overlapCount());
        }
        assert(worstOverlaps === 0, `固定弹幕互相遮挡 ${worstOverlaps} 处：准入判据失效`);
        passed.push("固定弹幕堆满轨道后无二维重叠，准入判据拦住原生轨道回绕");
      } finally {
        crowd.destroy();
        crowdStage.remove();
      }

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
