// VOD 详情侧栏的左右滑动切页签：复用直播侧栏那一套 `useHorizontalSwipe({ layout: "track" })`，
// 因此这里测的是「接线是否正确」而不是算法本身（算法在 tests/horizontal-swipe.test.ts）。
//
// 关键回归点是动态页签集合：PGC 只有分集+评论、单 P 无选集、没有弹幕数据时无弹幕页签。
// 条带按下标平移，一旦把全集而不是可见集合喂给 hook，第二页之后就整体错位 ——
// 那是看不见内容、只见空白的失效方式，必须逐组合验证停靠位置。
//
// 夹具用真实 hook + 真实条带几何，面板换成带高内容的桩：断言横向停靠、跟手中间帧、
// 相邻提交、非活动面板 inert、纵向滚动不被横滑抢占，以及按钮点击在滑动后被抑制。
// 先启动 vite（bun run dev）并打开预览页，再执行：
//   playwright-cli -s=video-sidebar-track open http://127.0.0.1:1420/
//   playwright-cli -s=video-sidebar-track run-code --filename=tests/video-sidebar-track.browser.js
async (page) => {
  await page.waitForFunction(() =>
    performance
      .getEntriesByType("resource")
      .some((item) => new URL(item.name).pathname.endsWith("/deps/react-dom_client.js")),
  );

  return await page.evaluate(async () => {
    const { setupHarness, assert, frames, settleAnimations } =
      await import("/tests/browser/harness.js");
    // 带查询参数绕过模块缓存，每次运行都取当前源码。
    const { useHorizontalSwipe } = await import(
      `/src/shared/hooks/useHorizontalSwipe.ts?sidebar-track=${Date.now()}`
    );

    const WIDTH = 320;
    const HEIGHT = 240;
    // 与 VideoSidebar 的四种实际组合一一对应。
    const COMBINATIONS = {
      pgc: ["episodes", "comments"],
      ugcPlain: ["related", "comments", "danmaku"],
      ugcMultiPart: ["related", "comments", "danmaku", "parts"],
      ugcNoDanmaku: ["related", "comments"],
    };

    const ui = await setupHarness({
      strict: false,
      style: `position:fixed;left:0;top:0;width:${WIDTH}px;height:${HEIGHT}px;z-index:1000;background:var(--background)`,
    });
    const { React, h, flushSync } = ui;

    let setTabs;
    let setActive;
    let swipe;
    let changes = [];

    function Harness() {
      const [tabs, updateTabs] = React.useState(COMBINATIONS.ugcMultiPart);
      const [active, updateActive] = React.useState(tabs[0]);
      setTabs = updateTabs;
      setActive = updateActive;
      // 与 VideoSidebar 同一套参数：items 是**可见**页签，layout 为 track。
      swipe = useHorizontalSwipe({
        items: tabs,
        value: active,
        onChange: (value) => {
          changes.push(value);
          updateActive(value);
        },
        enabled: true,
        layout: "track",
      });
      return h(
        "div",
        {
          "data-sidebar-surface": true,
          "data-horizontal-swipe-surface": true,
          style: { display: "flex", flexDirection: "column", height: "100%", touchAction: "pan-y" },
          onPointerDownCapture: swipe.onPointerDownCapture,
          onPointerMoveCapture: swipe.onPointerMoveCapture,
          onPointerUpCapture: swipe.onPointerUpCapture,
          onPointerCancelCapture: swipe.onPointerCancelCapture,
          onClickCapture: swipe.onClickCapture,
        },
        h(
          "div",
          {
            "data-sidebar-viewport": true,
            style: { position: "relative", flex: 1, overflow: "hidden" },
          },
          h(
            "div",
            {
              ref: swipe.bindPage,
              "data-sidebar-track": true,
              style: { display: "flex", height: "100%", width: `${tabs.length * 100}%` },
            },
            tabs.map((value) =>
              h(
                "div",
                {
                  key: value,
                  role: "tabpanel",
                  "aria-hidden": value === active ? undefined : true,
                  inert: value === active ? undefined : true,
                  "data-panel": value,
                  style: {
                    width: `${100 / tabs.length}%`,
                    flexShrink: 0,
                    minWidth: 0,
                    overflowY: "auto",
                    overscrollBehavior: "contain",
                  },
                },
                // 高内容：纵向必须仍然可以滚动。
                h("div", { style: { height: "900px" } }, value),
                h(
                  "button",
                  {
                    type: "button",
                    "data-panel-button": value,
                    onClick: () => {
                      changes.push(`click:${value}`);
                    },
                  },
                  "行",
                ),
              ),
            ),
          ),
        ),
      );
    }

    const track = () => ui.query("[data-sidebar-track]");
    const surface = () => ui.query("[data-sidebar-surface]");
    const panel = (value) => ui.query(`[data-panel="${value}"]`);
    const offset = () => new DOMMatrixReadOnly(getComputedStyle(track()).transform).m41;
    /** 条带停在第 index 页时的偏移。 */
    const restFor = (index) => -index * WIDTH;
    const settleTrack = () => settleAnimations(track());

    let pointerId = 1;
    const send = (type, x, y, target = surface()) => {
      target.dispatchEvent(
        new PointerEvent(type, {
          pointerId,
          pointerType: "touch",
          isPrimary: true,
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }),
      );
    };
    /** 一次横向拖动：分步移动让 hook 能锁轴并采样。 */
    const drag = async (fromX, toX, y = HEIGHT / 2, { release = true } = {}) => {
      pointerId += 1;
      send("pointerdown", fromX, y);
      const steps = 6;
      for (let step = 1; step <= steps; step += 1) {
        send("pointermove", fromX + ((toX - fromX) * step) / steps, y);
        await frames();
      }
      if (release) send("pointerup", toX, y);
      return () => send("pointerup", toX, y);
    };

    const results = [];
    const oldMatchMedia = window.matchMedia;
    window.matchMedia = (query) =>
      query === "(prefers-reduced-motion: reduce)"
        ? { matches: false }
        : oldMatchMedia.call(window, query);

    try {
      ui.render(h(Harness));
      await frames();
      assert(Math.abs(offset() - restFor(0)) < 0.5, "初始条带没有停靠到第一个页签");
      assert(panel("comments") !== null, "非活动页签没有常驻挂载");
      assert(panel("comments").hasAttribute("inert"), "非活动页签没有 inert");
      assert(!panel("related").hasAttribute("inert"), "活动页签被错误地标成 inert");
      results.push("四页签：常驻挂载、停靠首页、非活动 inert");

      // 跟手：拖到一半时条带必须处在两页之间，而不是等松手才动。
      const release = await drag(WIDTH - 40, 40, HEIGHT / 2, { release: false });
      const midway = offset();
      assert(midway < restFor(0) && midway > restFor(1), `拖动没有跟手中间帧：${midway}`);
      release();
      await frames();
      results.push("拖动跟手");

      await new Promise((resolve) => window.setTimeout(resolve, 500));
      assert(changes.includes("comments"), `左滑没有提交到下一个页签：${changes.join(",")}`);
      assert(Math.abs(offset() - restFor(1)) < 0.5, `提交后没有停靠到第二页：${offset()}`);
      assert(panel("comments").hasAttribute("inert") === false, "提交后活动页签仍是 inert");
      results.push("左滑提交到相邻页签并停靠");

      // 纵向拖动交还给面板滚动：hook 必须放手，不能 preventDefault 吃掉它。
      const scroller = panel("comments");
      scroller.scrollTop = 0;
      pointerId += 1;
      send("pointerdown", WIDTH / 2, HEIGHT - 20, scroller);
      let verticalDefaultPrevented = false;
      for (let step = 1; step <= 5; step += 1) {
        const event = new PointerEvent("pointermove", {
          pointerId,
          pointerType: "touch",
          isPrimary: true,
          clientX: WIDTH / 2,
          clientY: HEIGHT - 20 - step * 12,
          bubbles: true,
          cancelable: true,
        });
        scroller.dispatchEvent(event);
        verticalDefaultPrevented ||= event.defaultPrevented;
        await frames();
      }
      send("pointerup", WIDTH / 2, HEIGHT - 80, scroller);
      await frames();
      assert(!verticalDefaultPrevented, "纵向拖动被横滑抢占（阻止了默认滚动）");
      assert(Math.abs(offset() - restFor(1)) < 0.5, "纵向拖动移动了横向条带");
      scroller.scrollTop = 120;
      assert(scroller.scrollTop === 120, "面板层无法纵向滚动");
      results.push("纵向滚动归面板自己，横滑不抢占");

      // 滑动后的合成 click 必须被抑制，否则手指扫过列表会顺手点开一行。
      changes = [];
      await drag(40, WIDTH - 40);
      panel("comments").querySelector("[data-panel-button]")?.click();
      const suppressed = !changes.includes("click:comments");
      assert(suppressed, "滑动后紧接的 click 没有被抑制");
      await new Promise((resolve) => window.setTimeout(resolve, 500));
      results.push("滑动后抑制误触 click");

      // 点击切页签走 selectValue：与拖动同一条提交路径。
      changes = [];
      flushSync(() => swipe.selectValue("danmaku"));
      await new Promise((resolve) => window.setTimeout(resolve, 500));
      assert(changes.includes("danmaku"), "点击切换没有通知状态更新");
      assert(Math.abs(offset() - restFor(2)) < 0.5, `点击切换没有停靠到第三页：${offset()}`);
      results.push("点击切换与拖动同路径");

      // 动态页签集合：每种组合都要停靠到自己下标，喂全集会在这里错位。
      for (const [name, tabs] of Object.entries(COMBINATIONS)) {
        const target = tabs[tabs.length - 1];
        flushSync(() => {
          setTabs(tabs);
          setActive(target);
        });
        await settleTrack();
        const expected = restFor(tabs.length - 1);
        assert(
          Math.abs(offset() - expected) < 0.5,
          `${name} 组合（${tabs.join("/")}）停靠错位：期望 ${expected}，实际 ${offset()}`,
        );
        assert(
          ui.query(`[data-panel="${target}"]`).hasAttribute("inert") === false,
          `${name} 组合的活动页签被标成 inert`,
        );
      }
      results.push("PGC / 单 P / 多 P / 无弹幕四种页签集合各自停靠正确");

      // 页签消失时（弹幕数据迟到又撤销）回退到第一项，条带按新数组重新停靠。
      flushSync(() => {
        setTabs(COMBINATIONS.ugcNoDanmaku);
        setActive(COMBINATIONS.ugcNoDanmaku[0]);
      });
      await settleTrack();
      assert(Math.abs(offset() - restFor(0)) < 0.5, "页签集合缩小后没有重新停靠");
      results.push("页签集合变化后重新停靠");

      return { platform: navigator.userAgent, passed: results };
    } finally {
      ui.dispose();
      window.matchMedia = oldMatchMedia;
    }
  });
};
