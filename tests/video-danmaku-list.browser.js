// VideoDanmakuList 虚拟化与跟随回归：普通 Chromium + Vite dev，不连 Tauri 主窗口、不请求真实站点。
//   bun run dev --port 1430 --strictPort --host 127.0.0.1
//   playwright-cli -s=vdl open http://127.0.0.1:1430/
//   playwright-cli -s=vdl run-code --filename=tests/video-danmaku-list.browser.js
// 覆盖：DOM 行数有界且无 content-visibility、跟随行居中、播放推进重新居中、用户滚动停跟随、
// 「回到当前进度」恢复、seek 重新武装、非活动页签零行、点击条目回调毫秒位置。
// oxlint-disable-next-line no-unused-expressions -- playwright-cli 读取并执行函数表达式。
async (page) => {
  await page.waitForFunction(() =>
    performance.getEntriesByType("resource").some((entry) => entry.name.includes("/deps/react-dom_client.js")),
  );
  return page.evaluate(async () => {
    await import("/src/styles.css");
    const { setupHarness, assert, frames, until } = await import("/tests/browser/harness.js");
    const { VideoDanmakuList } = await import("/src/features/video/VideoDanmakuList.tsx");
    const { createPlaybackClock } = await import("/src/features/video/videoPlaybackClock.ts");
    const ui = await setupHarness({ style: "position:fixed;left:0;top:0;width:360px;height:480px;z-index:1000;background:var(--background)" });
    const { h } = ui;
    const passed = [];
    // 6 000 条、每 100ms 一条：与真实高密度稿件同量级（BV1Js411o76u P1 为 5 876 条）。
    let entries = Array.from({ length: 6000 }, (_, index) => ({
      id: `e${index}`,
      progressMs: index * 100,
      mode: "scroll",
      color: index % 7 === 0 ? "#ff6699" : "",
      content: `第 ${index} 条测试弹幕`,
      pool: 0,
    }));
    const clock = createPlaybackClock(300); // 跟随行 = 第 2999 条（最后一条 <300s 的）
    const seeks = [];
    const render = (active) => ui.render(h("div", { style: { height: 480 } },
      h(VideoDanmakuList, { entries, clock, loading: false, onSeek: (ms) => { seeks.push(ms); clock.set(ms / 1000); }, active })));
    const viewport = () => ui.query('[data-slot="video-danmaku-list"]');
    const rows = () => [...viewport().querySelectorAll("li[data-index]")];
    const rowAt = (index) => viewport().querySelector(`li[data-index="${index}"]`);
    const centered = (index) => {
      const row = rowAt(index);
      if (!row) return false;
      const v = viewport().getBoundingClientRect();
      const r = row.getBoundingClientRect();
      return Math.abs(r.top + r.height / 2 - (v.top + v.height / 2)) <= r.height;
    };
    const followButton = () => ui.host.querySelector('button[aria-label="回到当前进度"]');
    try {
      render(true);
      await until(() => centered(2999), "初始跟随行未居中");
      const count = rows().length;
      assert(count > 0 && count <= 40, `DOM 行数应有界，实际 ${count}`);
      assert(rows().every((row) => getComputedStyle(row).contentVisibility !== "auto"), "仍有行使用 content-visibility:auto");
      assert(ui.query('ol[data-count="6000"]'), "data-count 未报告总条数");
      passed.push(`6000 条仅挂 ${count} 行，跟随行居中`);

      // 未来条目淡化边界：跟随行之后的第一行为 future。
      assert(rowAt(3001)?.className.includes("opacity-55") && !rowAt(2999).className.includes("opacity-55"), "未来条目淡化边界错误");
      passed.push("已出现 / 未来条目边界正确");

      for (let seconds = 300.25; seconds <= 302; seconds += 0.25) {
        clock.set(seconds);
        await frames();
      }
      await until(() => centered(3019), "正常播放推进后未重新居中");
      await frames();
      await frames();
      assert(centered(3019) && !followButton(), "居中后发生回弹或误停跟随");
      passed.push("正常播放推进重新居中且保持稳定");

      viewport().dispatchEvent(new WheelEvent("wheel", { deltaY: 200, bubbles: true }));
      viewport().scrollTop -= 2000;
      await frames();
      await until(() => Boolean(followButton()), "用户滚动后未出现回到当前进度");
      const parked = viewport().scrollTop;
      // 正常播放按 timeupdate 约 0.25s 一步推进；单步超过 1.5s 会被判为 seek 而重新跟随。
      for (let seconds = 302.25; seconds <= 304; seconds += 0.25) {
        clock.set(seconds);
        await frames();
      }
      assert(Math.abs(viewport().scrollTop - parked) < 2, "停止跟随后播放推进仍拉动列表");
      assert(followButton(), "正常播放推进不应恢复跟随");
      passed.push("用户滚动停跟随，正常播放推进不拉回");

      followButton().click();
      await until(() => centered(3039) && !followButton(), "回到当前进度未恢复居中");
      passed.push("回到当前进度恢复跟随");

      viewport().dispatchEvent(new WheelEvent("wheel", { deltaY: 200, bubbles: true }));
      viewport().scrollTop += 3000;
      await until(() => Boolean(followButton()), "第二次滚动未停跟随");
      clock.set(100); // 大幅后退：seek
      await until(() => centered(999) && !followButton(), "seek 后未重新武装跟随");
      passed.push("seek 重新武装跟随");

      viewport().dispatchEvent(new WheelEvent("wheel", { deltaY: 1, bubbles: true }));
      await until(() => Boolean(followButton()), "点击条目前未停跟随");
      const target = rowAt(1001)?.querySelector("button");
      assert(target, "找不到可点击的条目");
      target.click();
      assert(seeks.at(-1) === 100100, `点击条目回调位置错误：${seeks.at(-1)}`);
      // 仅跳 0.1s，低于 seek 判定阈值，必须由点击行为自己恢复跟随。
      await until(() => centered(1000) && !followButton(), "停止跟随后点击条目未恢复");
      passed.push("停止跟随后点击条目回调毫秒位置并恢复跟随");

      render(false);
      await frames();
      assert(rows().length === 0, `非活动页签仍挂载 ${rows().length} 行`);
      clock.set(200);
      await frames();
      render(true);
      await until(() => centered(1999), "重新激活后未居中到当前进度");
      passed.push("非活动页签零行，重新激活后居中");

      // 停跟随的阅读锚点：活动与非活动期间分段前插都按稳定 key 保位。
      viewport().dispatchEvent(new WheelEvent("wheel", { deltaY: 200, bubbles: true }));
      viewport().scrollTop += 1000;
      await until(() => Boolean(followButton()), "保位测试未停跟随");
      await frames();
      const anchor = rows().find((row) => row.getBoundingClientRect().top > viewport().getBoundingClientRect().top + 30);
      assert(anchor, "找不到阅读锚点");
      const anchorId = anchor.dataset.entryId;
      const anchorTop = anchor.getBoundingClientRect().top;
      const keptAnchor = () => {
        const row = viewport().querySelector(`[data-entry-id="${anchorId}"]`);
        return row && Math.abs(row.getBoundingClientRect().top - anchorTop) <= 2;
      };
      for (const activeDuringInsert of [true, false]) {
        render(activeDuringInsert);
        await frames();
        entries = [
          ...Array.from({ length: 12 }, (_, index) => ({ ...entries[0], id: `prepend-${activeDuringInsert}-${index}`, progressMs: 0 })),
          ...entries,
        ];
        render(activeDuringInsert);
        await frames();
        if (!activeDuringInsert) assert(rows().length === 0, "后台前插意外挂载行");
        render(true);
        await until(keptAnchor, `${activeDuringInsert ? "活动" : "非活动"}期间前插后阅读行漂移`);
        await frames();
        assert(keptAnchor() && followButton(), "前插后阅读锚点回弹或意外恢复跟随");
      }
      passed.push("活动 / 非活动期间前插分段均保留阅读行，且不恢复跟随");

      entries = [...entries, { ...entries.at(-1), id: "appended", progressMs: 600000 }];
      render(true);
      await frames();
      assert(keptAnchor() && followButton(), "尾部追加拉动阅读位置");
      passed.push("尾部追加不拉动停止跟随的阅读位置");

      return { passed };
    } finally {
      ui.dispose();
    }
  });
}
