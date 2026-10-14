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
      const { setupHarness, assert, frame: nextFrame, frames } = await import("/tests/browser/harness.js");
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
        { x = 100, target = scroll(), cancelable = true, multiple = false, time = performance.now() } = {},
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
        // `timeStamp` 是只读的合成值，速度采样读的是它：用 `defineProperty` 摆到
        // 指定时刻，才能在不真的等墙钟的前提下造出确定的手指速度。
        Object.defineProperty(event, "timeStamp", { value: time });
        target.dispatchEvent(event);
        return event.defaultPrevented;
      };
      const gesture = async (from, to, options) => {
        send("touchstart", from, options);
        send("touchmove", to, options);
        flushSync(() => send("touchend", to, options));
        await frames();
      };
      /**
       * 带速度的甩动：以 `velocity`（px/ms，向上为负）匀速走完 `distance`，采样间隔 16ms。
       * `end()` 里的速度估算读的就是这些事件的时间戳，因此步数由距离与速度反推
       * （至少 5 步，让位移能跨过 10px 的锁定距离）。
       */
      const fling = async (from, distance, velocity) => {
        const steps = Math.max(5, Math.ceil(Math.abs(distance / velocity) / 16));
        const start = performance.now();
        send("touchstart", from, { time: start });
        for (let i = 1; i <= steps; i += 1) {
          const elapsed = i * 16;
          send("touchmove", from + (distance * i) / steps, { time: start + elapsed });
        }
        flushSync(() => send("touchend", from + distance, { time: start + steps * 16 }));
        await frames();
      };
      /**
       * 等到惯性自己停下（速度低于阈值后 `stopMomentum` 会提交）。
       *
       * 按墙钟而不是帧数：`τ = 325ms` 下速度从 1px/ms 衰减到 0.02 的停止阈值要
       * 约 1.3s，而 120Hz 屏上帧数是它的两倍。真机（Windows 主窗口）也可能跑在
       * 120Hz 上，固定帧数会假失败。
       */
      const settleMomentum = async (timeoutMs = 6000) => {
        const deadline = performance.now() + timeoutMs;
        while (performance.now() < deadline) {
          const before = commits.length;
          await nextFrame();
          if (commits.length > before) return true;
        }
        return false;
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
        // 末段保持慢速（2px / 一帧 ≈ 0.1px/ms，低于 0.3 的惯性启动阈值），
        // 这一段要验证的是同帧合并与释放清理，不接惯性；甩动另有用例。
        send("touchmove", 338);
        flushSync(() => send("touchend", 338));
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
        await frames();

        /*
          锁定距离内的表态。合成器按**第一个 touchmove 是否被 preventDefault**
          决定手势归属，而锁定距离（10px）与合成器的触摸 slop 同量级：逐帧 3~4px
          的慢速滑动等攒够 10px 时，后续 touchmove 早已被标成 `cancelable === false`，
          整次拖动因此被判成原生滚动丢掉 —— 真机表现为「切换页签或点开信息卡标题
          后，第一次滑动不改侧栏高度」，只有首帧就跨过 10px 的大幅滑动才正常。

          夹具合成的 TouchEvent 不经合成器，测不出取消状态，但可以直接验证修复所
          依赖的契约：pending 阶段的移动在**真能改变占比**时必须 `preventDefault`
          以抢下归属，而在到达边界或本就不该调整时不能抢（否则吞掉原生滚动）。
        */
        // 先摆回默认布局，否则上一段留在 `--vod-details-share` 上的值会遮住结果。
        // 只能靠下滑恢复：占比是持久状态，没有别的「重置」入口。
        scroll().scrollTop = 0;
        await gesture(400, 2000);
        await gesture(400, 2000);
        const pendingShare = Number.parseFloat(
          frame().style.getPropertyValue("--vod-details-share"),
        );
        const pendingStage = ui.query("[data-video-player-frame]").getBoundingClientRect().height;
        const pendingPreviews = previews.length;
        const pendingCommits = commits.length;
        // 首帧 4px：纵向占优且能改变占比 → 必须当场拦下默认行为，但不得预览或提交。
        send("touchstart", 400);
        assert(
          send("touchmove", 396),
          "未越锁定距离时未认领手势，合成器会把整次拖动判给原生滚动",
        );
        assert(previews.length === pendingPreviews, "锁定距离内就开始预览");
        assert(
          Number.parseFloat(frame().style.getPropertyValue("--vod-details-share")) === pendingShare,
          "锁定距离内就改了占比",
        );
        // 斜向移动（横向占优）不拦：这次手势归页签横滑。
        send("touchend", 396);
        send("touchstart", 400);
        assert(!send("touchmove", 396, { x: 130 }), "横向占优的按压被调占比拦下");
        send("touchend", 396, { x: 130 });
        // 下滑要先滚回内容顶部：此时位移归原生滚动，pending 阶段同样不能拦。
        scroll().scrollTop = 200;
        send("touchstart", 400);
        assert(!send("touchmove", 404), "内容下滑滚回顶部时被调占比拦下");
        send("touchend", 404);
        assert(previews.length === pendingPreviews, "pending 阶段产出了预览");
        assert(commits.length === pendingCommits, "pending 阶段发生了提交");
        assert(
          Math.abs(
            ui.query("[data-video-player-frame]").getBoundingClientRect().height - pendingStage,
          ) < 0.5,
          "pending 阶段改了舞台高度",
        );
        passed.push("锁定距离内只在真能改占比时认领，不预览不提交");

        /*
          首次进入播放页的真实时序：手指先落下，画幅要等媒体报出
          `videoWidth/videoHeight` 才可知（`enabled` 依赖它）。

          从前监听器按 `enabled` 绑定，这一整次拖动会在启用那一刻被丢掉 ——
          正是「首次进入视频页，侧栏自适应高度有时不触发」的根因。
          这里逐帧模拟：按下 → 小幅移动 → 启用（画幅到位）→ 继续移动 → 抬起。
        */
        // 先摆回默认布局，否则上一段留在 `--vod-details-share` 上的值会遮住结果。
        // 只能靠下滑恢复：占比是持久状态，没有别的「重置」入口。
        scroll().scrollTop = 0;
        await gesture(400, 2000);
        await gesture(400, 2000);
        const restoredShare = frame().style.getPropertyValue("--vod-details-share");
        const restoredStage = ui.query("[data-video-player-frame]").getBoundingClientRect().height;
        // 原始舞台高 = min(容器宽 / 画幅, 容器高 × 70%) = min(401 / (401/400), 757 × 0.7) = 400。
        assert(
          Math.abs(restoredStage - 400) < 1,
          `未回到原始布局，无法量接管帧：${restoredShare} / ${restoredStage}`,
        );
        const baselineShare = Number.parseFloat(restoredShare || "30");
        flushSync(() => setEnabled(false));
        await frames();
        const disabledPreviews = previews.length;
        // 按下时还没启用：按以前的实现这次按压根本不会被记下。
        send("touchstart", 400);
        // 越过 10px 锁定距离，确认纵向意图（此时仍未启用）。
        send("touchmove", 386);
        assert(
          previews.length === disabledPreviews,
          "未启用时就开始调整占比",
        );
        flushSync(() => setEnabled(true));
        await frames();
        // 启用后的第一个 touchmove 必须当场接管，而不是等下一位移累积。
        assert(send("touchmove", 340), "启用后的首个移动未认领手势");
        await frames();
        const afterResume = Number.parseFloat(frame().style.getPropertyValue("--vod-details-share"));
        assert(
          afterResume > baselineShare && afterResume < baselineShare + 20,
          `接管帧追溯应用了按下以来的总位移（应在 ${baselineShare}–${baselineShare + 20} 之间）：${afterResume}`,
        );
        assert(previews.length > disabledPreviews, "接管后未产出预览");
        const commitsBeforeResume = commits.length;
        send("touchmove", 300);
        flushSync(() => send("touchend", 300));
        await frames();
        // 这一段位移跨了 `setEnabled(true)` 与两帧等待，末段速度已过惯性阈值：
        // 提交会发生在惯性停下时，这里等到它落定（没接惯性则当场就已提交）。
        await settleMomentum();
        assert(commits.length > commitsBeforeResume, "跨越启用的手势未提交");
        assert(!frame().hasAttribute("data-vod-details-resizing"), "跨越启用的手势未清理标记");
        passed.push("画幅/启用晚于按下时手势能接着进行，且接管帧不追溯总位移");

        /*
          松手后的惯性。侧栏占比是持久状态、没有原生滚动的回弹，快速上滑后
          直接硬停会读作「甩出去半截又被人拽住」；这里验证三件事：

          1. 快速上滑（≥ 0.3px/ms）松手后占比继续变大，且是渐停而不是一帧到位；
          2. 慢速松手不接惯性（否则每次微调都会自己溜一段）；
          3. 惯性未停时再按下：当场停住并提交当时的位置，新手势从该位置接着走，
             不会弹回甩出前的起点。
        */
        scroll().scrollTop = 0;
        await gesture(400, 2000);
        await gesture(400, 2000);
        const flingStart = Number.parseFloat(
          frame().style.getPropertyValue("--vod-details-share") || "30",
        );
        const flingCommits = commits.length;
        // 上滑：速度 -1px/ms（1000px/s），5 步共 80px。
        await fling(400, -80, -1);
        assert(commits.length === flingCommits, "甩动在抬手前就提交了");
        const afterRelease = Number.parseFloat(frame().style.getPropertyValue("--vod-details-share"));
        assert(afterRelease > flingStart, `甩动后占比未变大：${flingStart} → ${afterRelease}`);
        // 渐停：头几帧还在动，不是一帧到位。
        const momentumFrames = [];
        for (let i = 0; i < 4; i += 1) {
          await nextFrame();
          momentumFrames.push(
            Number.parseFloat(frame().style.getPropertyValue("--vod-details-share")),
          );
        }
        assert(
          momentumFrames.some((value, i) => i > 0 && value > momentumFrames[i - 1] + 1e-6),
          `惯性没有逐帧推进：${JSON.stringify(momentumFrames)}`,
        );
        assert(await settleMomentum(), "惯性未自行停下并提交");
        const settledShare = Number.parseFloat(frame().style.getPropertyValue("--vod-details-share"));
        // 总位移约 v₀·τ = 1 × 325 = 325px，即 325 / 757 × 100 ≈ 43 个百分点；
        // 上限 70.2% 会先截住它，因此只断言「确实跑出了远大于一次甩动的位移」。
        assert(
          settledShare > afterRelease + 3,
          `惯性总位移过小：${afterRelease} → ${settledShare}`,
        );
        assert(!frame().hasAttribute("data-vod-details-resizing"), "惯性结束后未清理预览标记");
        passed.push("快速上滑松手后惯性继续推进并渐停提交");

        // 慢速松手：不接惯性。
        scroll().scrollTop = 0;
        await gesture(400, 2000);
        await gesture(400, 2000);
        const slowCommits = commits.length;
        // 0.1px/ms 低于 0.3 的启动阀值；40px 走 400ms，跨过锁定距离但不快。
        await fling(400, -40, -0.1);
        await frames();
        assert(commits.length > slowCommits, "慢速拖动未提交");
        const slowSettled = Number.parseFloat(frame().style.getPropertyValue("--vod-details-share"));
        for (let i = 0; i < 30; i += 1) await nextFrame();
        assert(
          Number.parseFloat(frame().style.getPropertyValue("--vod-details-share")) === slowSettled,
          "慢速松手后仍在自行推进",
        );
        passed.push("慢速松手不接惯性");

        // 惯性未停时再按下：立即停住并提交，新手势从当时的位置接着走。
        scroll().scrollTop = 0;
        await gesture(400, 2000);
        await gesture(400, 2000);
        await fling(400, -80, -1);
        await nextFrame();
        const midMomentum = Number.parseFloat(frame().style.getPropertyValue("--vod-details-share"));
        const midCommits = commits.length;
        send("touchstart", 400);
        assert(commits.length > midCommits, "再次按下时未提交惯性位置");
        const stoppedAt = Number.parseFloat(frame().style.getPropertyValue("--vod-details-share"));
        assert(
          stoppedAt >= midMomentum,
          `按下后位置倒退了：${midMomentum} → ${stoppedAt}`,
        );
        // 惯性已经停下：不再有新预览。
        const previewsAtPress = previews.length;
        for (let i = 0; i < 10; i += 1) await nextFrame();
        assert(previews.length === previewsAtPress, "按下后惯性仍在跑");
        // 新手势从停下位置继续（向上拖 40px ≈ +5.3 个百分点）。
        send("touchmove", 360);
        flushSync(() => send("touchend", 360));
        await frames();
        const afterSecondDrag = Number.parseFloat(frame().style.getPropertyValue("--vod-details-share"));
        assert(
          afterSecondDrag > stoppedAt,
          `新手势未从惯性停下位置继续：${stoppedAt} → ${afterSecondDrag}`,
        );
        passed.push("惯性期间再按下立即停住并提交，新手势从该位置继续");

        send("touchstart", 400);
        send("touchmove", 450);
        // 基准取**当前**条数：上面的新用例也会产出预览，不能用更早的 `count`。
        const beforeUnmount = previews.length;
        ui.dispose();
        await frames();
        assert(previews.length === beforeUnmount, "卸载后仍执行预览");
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
