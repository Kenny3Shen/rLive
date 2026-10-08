// 真实主窗口中的内容滑动、原生滚动让行、帧合并与清理回归（无需视频网络）。
// playwright-cli -s=rwin run-code --filename=tests/details-resize-motion.browser.js
async (page) => {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 401,
      height: 757,
      deviceScaleFactor: 1,
      mobile: false,
    });
    return await page.evaluate(async () => {
      const { setupHarness, assert, frames } = await import("/tests/browser/harness.js");
      const { useDetailsResize, writeDetailsShare, clearDetailsResizing } =
        await import("/src/shared/hooks/useDetailsResize.ts");
      const ui = await setupHarness({
        style: "position:fixed;inset:0;z-index:1000;background:var(--background)",
      });
      const { React, h, flushSync } = ui;
      const previews = [],
        commits = [],
        passed = [];
      let setEnabled, setRatio, rerender;
      function Harness() {
        const containerRef = React.useRef(null),
          detailsRef = React.useRef(null);
        const [enabled, updateEnabled] = React.useState(true);
        const [ratio, updateRatio] = React.useState(401 / 400);
        const [share, setShare] = React.useState(null);
        const [, update] = React.useState(0);
        setEnabled = updateEnabled;
        setRatio = updateRatio;
        rerender = () => update((x) => x + 1);
        const commit = (percent) => {
          commits.push(percent);
          writeDetailsShare(containerRef.current, percent);
          clearDetailsResizing(containerRef.current);
          setShare(Number(percent.toFixed(3)));
        };
        const bindContent = useDetailsResize({
          enabled,
          aspectRatio: ratio,
          containerRef,
          detailsRef,
          onPreview: (percent) => {
            previews.push(percent);
            writeDetailsShare(containerRef.current, percent);
          },
          onCommit: commit,
          onClamp: commit,
        });
        return h(
          "main",
          {
            ref: containerRef,
            "data-video-details-frame": true,
            "data-vod-details-share": share === null ? undefined : "true",
            className: "flex h-full min-h-0 flex-col",
            style: share === null ? undefined : { "--vod-details-share": `${share}%` },
          },
          h(
            "div",
            {
              "data-video-player-frame": true,
              className: "relative flex min-h-0 flex-none flex-col aspect-[var(--stage-ar,16/9)] max-lg:max-h-[70%]",
              style: { "--stage-ar": String(ratio) },
            },
            h("div", null, "舞台"),
          ),
          h(
            "aside",
            { ref: detailsRef, className: "flex min-h-0 flex-1 flex-col" },
            h("div", { "data-test-tabs": true, style: { height: 44, flexShrink: 0 } }, "Tab 栏"),
            h(
              "div",
              {
                ref: bindContent,
                "data-test-content": true,
                style: { minHeight: 0, flex: 1, overflow: "clip" },
              },
              h(
                "div",
                { "data-test-scroll": true, style: { height: "100%", overflow: "auto" } },
                h("input", { "data-test-input": true }),
                Array.from({ length: 1000 }, (_, i) => h("p", { key: i }, `评论 ${i}`)),
              ),
            ),
          ),
        );
      }
      const frame = () => ui.query("[data-video-details-frame]");
      const scroll = () => ui.query("[data-test-scroll]");
      const send = (
        type,
        y,
        { x = 100, target = scroll(), cancelable = true, multiple = false } = {},
      ) => {
        const touch = new Touch({ identifier: 71, target, clientX: x, clientY: y });
        const touches = type === "touchend" || type === "touchcancel" ? [] : [touch];
        if (multiple) touches.push(new Touch({ identifier: 72, target, clientX: 150, clientY: y }));
        const event = new TouchEvent(type, {
          touches,
          targetTouches: touches,
          changedTouches: [touch],
          bubbles: true,
          cancelable,
        });
        target.dispatchEvent(event);
        return event.defaultPrevented;
      };
      const gesture = async (from, to, options) => {
        send("touchstart", from, options);
        send("touchmove", to, options);
        flushSync(() => send("touchend", to, options));
        await frames();
      };
      const geometry = () => {
        const total = frame().getBoundingClientRect().height;
        const stage = ui.query("[data-video-player-frame]").getBoundingClientRect().height;
        const details = ui.query("aside").getBoundingClientRect().height;
        assert(Math.abs(stage + details - total) < 0.5, "舞台与侧栏未铺满容器");
        assert(stage >= 401 / (16 / 9) - 0.5, "舞台被压到满宽 16:9 以下");
      };
      try {
        ui.render(h(Harness));
        await frames();
        send("touchstart", 400);
        for (let i = 1; i <= 30; i++) send("touchmove", 400 - i * 2);
        assert(previews.length === 0, "同帧移动立即重复触发布局");
        await frames();
        assert(previews.length === 1, "30 次移动没有合并为一次预览");
        const before = frame().style.getPropertyValue("--vod-details-share");
        flushSync(rerender);
        assert(
          frame().style.getPropertyValue("--vod-details-share") === before,
          "React 提交覆盖预览",
        );
        assert(
          getComputedStyle(scroll()).getPropertyValue("--vod-details-share").trim() === "30%",
          "变量继承到了评论子树",
        );
        geometry();
        send("touchmove", 320);
        flushSync(() => send("touchend", 320));
        await frames();
        assert(previews.length === 1 && commits.length === 1, "结束后旧预览仍在执行");
        assert(!frame().hasAttribute("data-vod-details-resizing"), "结束未清理预览标记");
        passed.push("同帧合并、非继承变量、React 重渲染及释放清理");

        const noResize = commits.length;
        await gesture(400, 350, { target: ui.query("[data-test-tabs]") });
        await gesture(400, 350, { target: ui.query("[data-test-input]") });
        await gesture(400, 400, { x: 200 });
        send("touchstart", 400);
        send("touchmove", 400, { x: 250 });
        send("touchend", 400, { x: 250 });
        assert(commits.length === noResize, "Tab、输入控件或横滑被调占比接管");
        passed.push("Tab 栏、输入控件与横向手势不调占比");

        await gesture(400, -2000);
        geometry();
        assert(scroll().scrollTop > 0, "上限剩余位移未滚动内容");
        const atMax = frame().style.getPropertyValue("--vod-details-share");
        send("touchstart", 400);
        assert(!send("touchmove", 350), "上限处仍抢占原生滚动");
        send("touchend", 350);
        assert(
          frame().style.getPropertyValue("--vod-details-share") === atMax,
          "上限继续上滑改变占比",
        );
        send("touchstart", 400);
        assert(!send("touchmove", 440), "未到顶部就抢占下滑滚动");
        scroll().scrollTop = 0;
        assert(!send("touchmove", 480, { cancelable: false }), "不可取消的原生滚动仍被接管");
        send("touchend", 480);
        assert(
          frame().style.getPropertyValue("--vod-details-share") === atMax,
          "原生滚动中偷偷改了占比",
        );
        await gesture(400, 480);
        assert(
          parseFloat(frame().style.getPropertyValue("--vod-details-share")) < parseFloat(atMax),
          "顶部下滑未缩小侧栏",
        );
        passed.push("上滑先扩大、边界位移滚内容；保留原生滚动，下滑到顶才缩小");

        scroll().scrollTop = 0;
        await gesture(400, 2000);
        assert(
          Math.abs(ui.query("[data-video-player-frame]").getBoundingClientRect().height - 400) < 0.5,
          "下滑未硬停在原始400px舞台",
        );
        await gesture(400, 2000);
        assert(
          Math.abs(ui.query("[data-video-player-frame]").getBoundingClientRect().height - 400) < 0.5,
          "再次下滑越过原始布局",
        );
        scroll().scrollTop = 80;
        send("touchstart", 400);
        assert(!send("touchmove", 440), "原始占比下限仍抢占内容下滑滚动");
        send("touchend", 440);
        scroll().scrollTop = 0;
        await gesture(400, -2000);
        ui.host.style.height = "600px";
        await frames();
        geometry();
        assert(
          parseFloat(frame().style.getPropertyValue("--vod-details-share")) < 63,
          "容器变矮未收回超限占比",
        );
        passed.push("原始画幅恢复下限、尺寸变化收回与总高度守恒");

        scroll().scrollTop = 0;
        send("touchstart", 400);
        send("touchmove", 450);
        ui.host.style.height = "1200px";
        await frames();
        assert(!frame().hasAttribute("data-vod-details-resizing"), "尺寸变化未终止旧手势");
        assert(
          Math.abs(ui.query("[data-video-player-frame]").getBoundingClientRect().height - 400) < 0.5,
          "容器变高未按新下限恢复原始舞台",
        );
        const resized = frame().style.getPropertyValue("--vod-details-share");
        send("touchmove", 550);
        send("touchend", 550);
        assert(frame().style.getPropertyValue("--vod-details-share") === resized, "旧手势仍按旧尺寸提交");
        ui.host.style.height = "600px";
        await frames();
        flushSync(() => setRatio(6));
        await frames();
        assert(parseFloat(frame().style.getPropertyValue("--vod-details-share")) > 85, "超宽画幅被85%兜底截断");
        assert(
          Math.abs(ui.query("[data-video-player-frame]").getBoundingClientRect().height - 401 / 6) < 0.5,
          "画幅变化未重算原始布局下限",
        );
        await gesture(400, 2000);
        assert(
          Math.abs(ui.query("[data-video-player-frame]").getBoundingClientRect().height - 401 / 6) < 0.5,
          "超宽画幅下滑越过原始布局",
        );
        flushSync(() => setRatio(401 / 400));
        await frames();
        geometry();
        passed.push("手势中尺寸变化立即收口，画幅变化与超过85%的原始占比正确");

        scroll().scrollTop = 0;
        send("touchstart", 400);
        send("touchmove", 450);
        flushSync(() => send("touchcancel", 450));
        await frames();
        assert(!frame().hasAttribute("data-vod-details-resizing"), "touchcancel 未清理");
        const count = previews.length;
        send("touchstart", 400);
        send("touchmove", 450);
        flushSync(() => setEnabled(false));
        await frames();
        assert(
          previews.length === count && !frame().hasAttribute("data-vod-details-resizing"),
          "禁用遗留预览",
        );
        flushSync(() => setEnabled(true));
        send("touchstart", 400);
        send("touchmove", 450);
        ui.dispose();
        await frames();
        assert(previews.length === count, "卸载后仍执行预览");
        passed.push("取消、禁用和卸载清理");
        return { passed };
      } finally {
        ui.dispose();
      }
    });
  } finally {
    await client.send("Emulation.clearDeviceMetricsOverride");
    await client.detach();
  }
}
