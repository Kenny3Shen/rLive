// Windows 主窗口：DanmakuRenderer 生命周期边界回归（固定弹幕钉住寿命、零尺寸、固定组上限、改速不跳变）。
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
    let time = 0;
    Object.defineProperties(media, {
      currentTime: { configurable: true, get: () => time },
      paused: { configurable: true, get: () => false },
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

      // 改速度保持在途位置，不跳变。
      time = 0;
      renderer.setComments([comment("scroll-speed", "scroll", 0.05)]);
      media.dispatchEvent(new Event("seeking"));
      await step(2);
      await until(() => node("scroll-speed"), "滚动弹幕未上屏");
      await frames();
      const beforeSpeed = left("scroll-speed");
      renderer.setSpeed(200);
      await frames();
      assert(Math.abs(left("scroll-speed") - beforeSpeed) < 1, `改速跳变 ${(left("scroll-speed") - beforeSpeed).toFixed(2)}px`);
      await step(2.5);
      assert(left("scroll-speed") < beforeSpeed - 40, "改速后没有按新速度继续");
      passed.push("改速度保持在途位置并按新速度继续");

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
      time = 0;
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
      return { passed };
    } finally {
      renderer?.destroy();
      stage.remove();
    }
  });
}
