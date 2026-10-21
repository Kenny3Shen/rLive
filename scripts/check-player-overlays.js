// 在真实主窗口运行：playwright-cli -s=rwin run-code --filename=scripts/check-player-overlays.js
// 先进入直播播放页，或带章节的短视频；不创建页面、不替换 IPC、不伪造章节。
async function checkPlayerOverlays(page) {
  const path = await page.evaluate(() => location.pathname);
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };

  if (path.startsWith("/room/")) {
    await page.waitForFunction(() => document.querySelector("video")?.readyState >= 2);
    // 持续失败避免自动恢复抢先关闭弹窗，覆盖真正的宿主失败分支。
    await page.evaluate(() => {
      window.__rliveOverlayErrorProbe = setInterval(() => {
        document.querySelector("video")?.dispatchEvent(
          new ErrorEvent("error", {
            error: { message: "回归验证：视频格式暂不支持", code: 4 },
          }),
        );
      }, 300);
    });
    try {
      await page.waitForFunction(() =>
        document.querySelector('[role="alertdialog"]')?.textContent?.includes("回归验证"),
      );
      const state = await page.evaluate(() => ({
        documentModal: document.querySelector('[role="alertdialog"]')?.getAttribute("aria-modal"),
        inertTabs: [...document.querySelectorAll('[role="tab"]')].some((tab) =>
          tab.closest("[inert]"),
        ),
      }));
      assert(state.documentModal !== "true", "播放错误不应锁住整个页面");
      assert(!state.inertTabs, "播放错误不应让侧栏 Tab 变成 inert");
      for (const name of ["设置", "关注", "弹幕"]) {
        await page.getByRole("tab", { name, exact: true }).click();
        await page.waitForFunction(
          (label) =>
            document.querySelector('[role="tab"][aria-selected="true"]')?.textContent === label,
          name,
        );
      }
      return { result: "播放错误弹窗打开时三个侧栏 Tab 均可切换" };
    } finally {
      await page.evaluate(() => {
        clearInterval(window.__rliveOverlayErrorProbe);
        delete window.__rliveOverlayErrorProbe;
      });
      const close = page
        .getByRole("alertdialog")
        .getByRole("button", { name: "关闭", exact: true });
      if (await close.isVisible()) await close.click({ timeout: 3_000 });
    }
  }

  assert(path.startsWith("/shorts/bilibili"), "请先进入直播播放页，或带章节的 B 站短视频");
  const cdp = await page.context().newCDPSession(page);
  const results = [];
  try {
    for (const [width, height, side] of [
      [390, 844, "bottom"],
      [700, 390, "right"],
    ]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await page.waitForFunction(() => matchMedia("(max-width: 767px)").matches);
      const pill = page.locator('[data-slot="player-chapter-pill"]');
      await pill.waitFor({ state: "visible" });
      await pill.click();
      const drawer = page.locator('[data-slot="drawer-content"]');
      await drawer.waitFor({ state: "visible" });
      const state = await drawer.evaluate((element) => ({
        side: element.getAttribute("data-side"),
        scoped: element.hasAttribute("data-scoped"),
        inDock: Boolean(element.closest('[data-slot="shorts-comments-dock"]')),
        dockHeight: document
          .querySelector('[data-slot="shorts-comments-dock"]')
          ?.getBoundingClientRect().height,
        height: element.getBoundingClientRect().height,
        chapters: element.querySelectorAll('[role="listitem"]').length,
      }));
      assert(state.side === side, "章节抽屉方向应跟随竖屏/横屏");
      assert(!state.scoped && !state.inDock, "章节不应继承评论 dock 的局部作用域");
      assert(state.dockHeight === 0, "此用例需要评论关闭、dock 高度为 0");
      assert(state.height > 0 && state.chapters > 1, "章节抽屉应显示可选择的列表");
      const choice = drawer.getByRole("listitem").nth(1).getByRole("button");
      const target = await choice.evaluate((button) =>
        button
          .querySelector("span")
          .textContent.trim()
          .split(":")
          .reduce((time, part) => time * 60 + Number(part), 0),
      );
      const media = page.locator('video:not([tabindex="-1"])');
      const before = await media.evaluate((video) => video.paused);
      await choice.click();
      await drawer.waitFor({ state: "hidden" });
      await page.waitForFunction((time) => {
        const video = document.querySelector('video:not([tabindex="-1"])');
        return video && Math.abs(video.currentTime - time) < 3;
      }, target);
      const after = await media.evaluate((video) => video.paused);
      assert(before === after, "选择章节不应改变播放/暂停状态");
      results.push({ viewport: { width, height }, ...state, seekTarget: target });
    }
    return { result: "评论关闭时竖屏/横屏章节抽屉均可展开、选择并收起", results };
  } finally {
    await page.keyboard.press("Escape");
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await cdp.detach();
  }
}
