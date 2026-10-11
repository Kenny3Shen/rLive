// 在 Windows 主窗口验证真实 HUD 的信息切换与平移动画，不取流、不更改页面或设备视口。
// playwright-cli -s=room-hud-title run-code --filename=tests/room-hud-identity.browser.js
async (page) => {
  return page.evaluate(async () => {
    const { setupHarness, assert, frames, until } = await import("/tests/browser/harness.js");
    const { PlayerFullscreenHud, playerHudTitleOnly } = await import(
      "/src/features/room/PlayerFullscreenHud.tsx"
    );
    const harness = await setupHarness({
      style: "position:fixed;left:0;top:0;width:390px;background:#111;z-index:9999",
    });
    const { h, render, query } = harness;
    let backCount = 0;
    const props = {
      roomTitle: "测试直播间",
      roomUserName: "回归测试主播",
      siteId: "bilibili",
      roomId: "123456",
      roomOnline: 12345,
      compact: true,
      onBack: () => { backCount += 1; },
      backLabel: "返回上一页",
      roomActions: [{ id: "share", label: "分享", icon: () => null, onSelect: () => {} }],
    };
    const draw = (titleOnly, roomTitle = props.roomTitle) => {
      render(h(PlayerFullscreenHud, { ...props, titleOnly, roomTitle }));
    };
    const read = () => {
      const line = query("[data-room-identity-line]");
      return {
        text: line.textContent,
        avatar: Boolean(line.querySelector('[data-slot="avatar"]')),
        track: line.firstElementChild,
        overflowing: line.dataset.overflowing === "true",
      };
    };
    try {
      for (const mobile of [false, true]) {
        for (const portrait of [false, true]) {
          for (const fullscreen of [false, true]) {
            const titleOnly = playerHudTitleOnly(mobile, portrait, fullscreen);
            draw(titleOnly);
            await frames();
            const state = read();
            assert(state.text.includes(props.roomTitle), "标题必须保留");
            assert(state.avatar === !titleOnly, "头像应随信息模式切换");
            for (const text of [props.roomUserName, props.roomId, "当前热度"]) {
              assert(state.text.includes(text) === !titleOnly, `信息显隐错误：${text}`);
            }
            assert(query('button[aria-label="返回上一页"]'), "返回按钮不应消失");
            assert(query('button[aria-label="更多房间操作"]'), "更多操作不应消失");
          }
        }
      }

      // 长标题在仅标题模式仍可平移；恢复短标题必须清理旧动画与偏移。
      draw(true, "这是一条需要横向平移才能完整展示的直播间长标题".repeat(4));
      await until(() => read().overflowing, "长标题未重新测量溢出");
      const longTitleState = read();
      assert(!longTitleState.avatar, "长标题平移轨道不能混入头像");
      if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
        await until(() => read().track.getAnimations().length === 1, "长标题未启动平移动画");
      }
      draw(true);
      await until(() => !read().overflowing, "短标题仍残留溢出状态");
      assert(read().track.getAnimations().length === 0, "短标题仍残留旧平移动画");
      assert(read().track.style.transform === "", "短标题仍残留位移");
      query('button[aria-label="返回上一页"]').click();
      assert(backCount === 1, "仅标题模式的返回按钮未响应");
      return { passed: ["8 种平台/方向/全屏组合", "长短标题切换与动画清理", "返回按钮可用"] };
    } finally {
      harness.dispose();
    }
  });
}
