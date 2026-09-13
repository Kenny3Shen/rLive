// 在已接入 Windows Debug 主窗口的会话运行：
// playwright-cli -s=tab-fix run-code --filename=tests/tab-motion.browser.js
async (page) => {
  return await page.evaluate(async () => {
    if (!window.__TAURI_INTERNALS__ || !navigator.userAgent.includes("Windows NT")) {
      throw new Error("必须在 Windows Debug 主窗口运行，不能使用普通浏览器或 CDP 新标签。");
    }
    const { setupHarness, assert, frames } = await import("/tests/browser/harness.js");
    // 带查询参数绕过模块缓存：每次运行都要拿到当前源码的钩子实现。
    const { useHorizontalSwipe } = await import(
      `/src/shared/hooks/useHorizontalSwipe.ts?motion-test=${Date.now()}`
    );

    const ui = await setupHarness({
      style:
        "position:fixed;left:80px;top:100px;width:360px;z-index:1000;background:var(--background)",
    });
    const { React, h, flushSync } = ui;

    let setState;
    let swipe;
    let deferChanges = false;
    let requestedValue;
    const items = ["a", "b", "c", "d"];

    function Harness() {
      const [state, update] = React.useState({ value: "a", key: 0 });
      setState = update;
      swipe = useHorizontalSwipe({
        items,
        value: state.value,
        onChange: (value) => {
          requestedValue = value;
          if (!deferChanges) update((current) => ({ ...current, value }));
        },
        enabled: false,
        layout: "track",
        animateAcrossItems: true,
      });
      return h(
        "div",
        { "data-test-viewport": true, style: { width: "360px", height: "160px", overflow: "hidden" } },
        h(
          "div",
          {
            key: state.key,
            ref: swipe.bindPage,
            "data-test-track": true,
            style: { display: "flex", width: "400%", height: "100%" },
          },
          items.map((value) => h("div", { key: value, style: { width: "25%", flexShrink: 0 } }, value)),
        ),
      );
    }

    const track = () => ui.query("[data-test-track]");
    const viewport = () => ui.query("[data-test-viewport]");
    const offset = () => new DOMMatrixReadOnly(getComputedStyle(track()).transform).m41;
    /** 暂停轨道动画并定位到指定进度，用于观察中间帧而非最终停靠位。 */
    const pauseAt = async (progress) => {
      const animation = track().getAnimations()[0];
      assert(animation, "未创建轨道动画");
      animation.pause();
      animation.currentTime = Number(animation.effect.getTiming().duration) * progress;
      await frames();
      return animation;
    };

    const results = [];
    const oldMatchMedia = window.matchMedia;
    const stubReducedMotion = (matches) => {
      window.matchMedia = (query) =>
        query === "(prefers-reduced-motion: reduce)" ? { matches } : oldMatchMedia.call(window, query);
    };

    try {
      stubReducedMotion(false);
      ui.render(h(Harness));
      await frames();
      assert(offset() === 0, "初始轨道没有停靠到第一页");

      flushSync(() => swipe.selectValue("b"));
      const first = await pauseAt(0.35);
      const midway = offset();
      assert(midway < 0 && midway > -360, "动画没有中间帧");
      viewport().style.height = "240px";
      await frames();
      assert(first.playState === "paused", "仅高度变化就取消了动画");
      assert(Math.abs(offset() - midway) < 0.1, "高度变化让横向偏移跳变");
      results.push("高度变化不取消动画");

      flushSync(() => swipe.selectValue("c"));
      const second = track().getAnimations()[0];
      assert(second && second !== first, "连续切换没有接管动画");
      second.pause();
      second.currentTime = 0;
      assert(Math.abs(offset() - midway) < 0.1, "连续切换从起点重播");
      assert(first.playState === "idle", "旧动画未取消");
      results.push("连续切换从当前像素接管");

      const forward = await pauseAt(0.45);
      const reversalStart = offset();
      flushSync(() => swipe.selectValue("b"));
      const reversed = await pauseAt(0);
      assert(Math.abs(offset() - reversalStart) < 0.1, "反向切换发生回跳");
      assert(forward.playState === "idle", "反向切换保留了旧动画");
      reversed.finish();
      await frames();
      assert(Math.abs(offset() + 360) < 0.1, "动画结束未停靠");
      assert(
        track().getAnimations().length === 0 && track().style.willChange === "",
        "结束后残留动画层",
      );
      results.push("反向切换与结束清理");

      flushSync(() => swipe.selectValue("c"));
      await pauseAt(0.3);
      viewport().style.width = "420px";
      await frames();
      assert(Math.abs(offset() + 840) < 0.1, "宽度变化未重建活动页基准");
      assert(track().style.willChange === "", "宽度变化残留 will-change");
      results.push("宽度变化重新停靠");

      flushSync(() => swipe.selectValue("b"));
      const leaving = await pauseAt(0.3);
      const oldTrack = track();
      flushSync(() => setState((current) => ({ ...current, key: current.key + 1 })));
      await frames();
      assert(track() !== oldTrack && leaving.playState === "idle", "节点重绑未清理旧动画");
      assert(Math.abs(offset() + 420) < 0.1, "重绑未停靠到活动页");
      results.push("节点重绑清理并重新定位");

      // 路由未提交（onChange 不立即回写 value）时，resize 与再次点击都不能丢目的页。
      deferChanges = true;
      swipe.selectValue("c");
      await pauseAt(0.25);
      viewport().style.width = "400px";
      await frames();
      assert(Math.abs(offset() + 800) < 0.1, "提交前 resize 错误停靠到旧页");
      flushSync(() => setState((current) => ({ ...current, value: requestedValue })));
      await frames();
      assert(Math.abs(offset() + 800) < 0.1, "延迟提交丢失目的页定位");
      results.push("待提交目标在 resize 后仍保持正确");

      swipe.selectValue("b");
      await pauseAt(0.25);
      swipe.selectValue("c");
      assert(requestedValue === "c", "点回原页没有通知路由取消旧请求");
      const returned = await pauseAt(0.25);
      returned.finish();
      await frames();
      assert(Math.abs(offset() + 800) < 0.1, "点回原页未回到原位");
      results.push("待提交时支持点回原页");

      deferChanges = false;
      flushSync(() => swipe.selectValue("a"));
      const across = await pauseAt(0.4);
      assert(offset() > -800 && offset() < 0, "非相邻切换没有平移中间帧");
      across.finish();
      await frames();
      assert(Math.abs(offset()) < 0.1, "非相邻切换未正确落位");
      results.push("非相邻页签保持连续平移");

      stubReducedMotion(true);
      flushSync(() => swipe.selectValue("b"));
      await frames();
      assert(
        track().getAnimations().length === 0 && Math.abs(offset() + 400) < 0.1,
        "减少动态效果未立即落位",
      );
      results.push("尊重减少动态效果");

      return { platform: navigator.userAgent, passed: results };
    } finally {
      ui.dispose();
      window.matchMedia = oldMatchMedia;
    }
  });
}
