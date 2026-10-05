// 调占比的帧合并、样式隔离和几何回归。在真实主窗口挂独立 root，不依赖视频网络。
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
      const previews = [];
      const commits = [];
      let setEnabled;
      let rerender;
      function Harness() {
        const containerRef = React.useRef(null);
        const detailsRef = React.useRef(null);
        const [enabled, updateEnabled] = React.useState(true);
        const [share, setShare] = React.useState(null);
        const [, update] = React.useState(0);
        setEnabled = updateEnabled;
        rerender = () => update((x) => x + 1);
        const commit = (percent) => {
          commits.push(percent);
          writeDetailsShare(containerRef.current, percent);
          clearDetailsResizing(containerRef.current);
          setShare(Number(percent.toFixed(3)));
        };
        const handlers = useDetailsResize({
          enabled,
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
              className: "relative flex min-h-0 min-w-0 flex-none flex-col",
            },
            h("div", { style: { height: 300 } }, "舞台内容"),
          ),
          h(
            "aside",
            { ref: detailsRef, className: "flex min-h-0 flex-1 flex-col" },
            h(
              "div",
              {
                "data-vod-details-handle": true,
                ...handlers,
                style: { height: 44, flexShrink: 0 },
              },
              "抓手",
            ),
            h(
              "div",
              { "data-test-descendant": true, style: { overflow: "auto", flex: 1 } },
              Array.from({ length: 1000 }, (_, index) => h("p", { key: index }, `评论 ${index}`)),
            ),
          ),
        );
      }
      const frame = () => ui.query("[data-video-details-frame]");
      const handle = () => ui.query("[data-vod-details-handle]");
      const send = (type, y, x = 100) =>
        handle().dispatchEvent(
          new PointerEvent(type, {
            pointerId: 71,
            pointerType: "touch",
            isPrimary: true,
            clientX: x,
            clientY: y,
            bubbles: true,
            cancelable: true,
          }),
        );
      const assertGeometry = () => {
        const total = frame().getBoundingClientRect().height;
        const stage = ui.query("[data-video-player-frame]").getBoundingClientRect().height;
        const details = ui.query("aside").getBoundingClientRect().height;
        assert(Math.abs(stage + details - total) < 0.5, "舞台与侧栏未铺满容器");
        assert(stage >= 401 / (16 / 9) - 0.5, "舞台被压到满宽 16:9 以下");
      };
      const passed = [];
      try {
        ui.render(h(Harness));
        // 合成事件没有浏览器的 active pointer，补上指针捕获行为。
        let captured = false;
        handle().setPointerCapture = () => {
          captured = true;
        };
        handle().hasPointerCapture = () => captured;
        handle().releasePointerCapture = () => {
          captured = false;
        };
        await frames();
        send("pointerdown", 400);
        for (let i = 1; i <= 30; i++) send("pointermove", 400 + i * 2);
        assert(previews.length === 0, "同帧 pointermove 立即重复触发布局");
        await frames();
        assert(previews.length === 1, "同帧事件没有合并成一次最新预览");
        assert(frame().dataset.vodDetailsResizing === "true", "未标记拖动状态");
        assertGeometry();
        const parentShare = getComputedStyle(frame())
          .getPropertyValue("--vod-details-share")
          .trim();
        const childShare = getComputedStyle(ui.query("[data-test-descendant]"))
          .getPropertyValue("--vod-details-share")
          .trim();
        assert(
          childShare === "30%" && childShare !== parentShare,
          "高频 CSS 变量仍在向评论/播放器子树继承",
        );
        const before = frame().style.getPropertyValue("--vod-details-share");
        flushSync(rerender);
        assert(
          frame().style.getPropertyValue("--vod-details-share") === before,
          "普通 React 提交覆盖拖动预览",
        );
        passed.push("30 次同帧移动合并一次；变量不继承到 1000 条评论，React 提交不打断预览");

        send("pointermove", 480);
        flushSync(() => send("pointerup", 500));
        const final = frame().style.getPropertyValue("--vod-details-share");
        await frames();
        assert(previews.length === 1 && commits.length === 1, "松手后旧预览仍在执行");
        assert(
          frame().style.getPropertyValue("--vod-details-share") === final,
          "旧预览覆盖最终坐标",
        );
        assert(!captured && !frame().hasAttribute("data-vod-details-resizing"), "松手未清理状态");
        assertGeometry();
        passed.push("释放同步提交最终位置，并取消未执行的预览");

        send("pointerdown", 400);
        send("pointermove", 350);
        flushSync(() => send("pointercancel", 350));
        await frames();
        assert(previews.length === 1 && commits.length === 2, "取消未提交最新位置/遗留预览");
        assert(!captured, "取消未释放指针");
        assertGeometry();
        passed.push("pointercancel 保留最新拖动结果，不遗留预览");

        const count = previews.length;
        send("pointerdown", 400);
        send("pointermove", 400, 200);
        send("pointerup", 400, 200);
        await frames();
        assert(previews.length === count && commits.length === 2, "横向翻页被占比手势抢走");
        passed.push("横向手势不触发调占比");

        send("pointerdown", 400);
        flushSync(() => {
          send("pointermove", -2000);
          send("pointerup", -2000);
        });
        await frames();
        assertGeometry();
        assert(
          Math.abs(
            ui.query("[data-video-player-frame]").getBoundingClientRect().height - 401 / (16 / 9),
          ) < 0.5,
          "拖动上限没有停在 16:9",
        );
        ui.host.style.height = "600px";
        await frames();
        assertGeometry();
        assert(
          parseFloat(frame().style.getPropertyValue("--vod-details-share")) < 63,
          "容器变矮没有收回超限占比",
        );
        send("pointerdown", 400);
        flushSync(() => {
          send("pointermove", 2000);
          send("pointerup", 2000);
        });
        await frames();
        assert(
          parseFloat(frame().style.getPropertyValue("--vod-details-share")) === 20,
          "下限不是 20%",
        );
        assertGeometry();
        passed.push("上下限与容器变矮后的收回仍正确，总高度不留缝");

        send("pointerdown", 400);
        send("pointermove", 350);
        flushSync(() => setEnabled(false));
        await frames();
        assert(previews.length === count && !captured, "禁用后旧预览仍执行或指针仍被捕获");
        flushSync(() => setEnabled(true));
        send("pointerdown", 400);
        send("pointermove", 350);
        ui.dispose();
        await frames();
        assert(previews.length === count && !captured, "卸载后仍执行预览或未释放指针");
        passed.push("禁用及卸载均取消待执行帧");
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
