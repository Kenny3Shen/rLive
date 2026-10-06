// 在 Windows Debug 主窗口执行，不导航离开应用、不依赖站点网络。
// playwright-cli -s=motion run-code --filename=tests/system-motion.browser.js
async (page) => {
  const cdp = await page.context().newCDPSession(page);
  const results = [];
  try {
    for (const viewport of [
      { width: 1280, height: 800, mobile: false },
      { width: 360, height: 732, mobile: true },
      { width: 844, height: 390, mobile: true },
    ]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1 });
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: viewport.mobile });
      for (const reducedMotion of ["no-preference", "reduce"]) {
        await page.emulateMedia({ reducedMotion });
        const passed = await page.evaluate(async (reduced) => {
          if (!window.__TAURI_INTERNALS__) throw new Error("必须在 Tauri 主窗口运行");
          const { setupHarness, assert, frames, until } = await import("/tests/browser/harness.js");
          const { PagePan } = await import("/src/shared/motion/PagePan.tsx");
          const { Dialog, DialogContent, DialogTitle } =
            await import("/src/components/ui/dialog.tsx");
          const { Drawer, DrawerContent, DrawerTitle } =
            await import("/src/components/ui/drawer.tsx");
          const ui = await setupHarness({
            style:
              "position:fixed;inset:80px 12px auto;height:180px;z-index:1000;background:var(--background);overflow:hidden",
          });
          const { h } = ui;
          const passed = [];
          const x = (element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).m41;
          const finish = async (element) => {
            for (const animation of element.getAnimations({ subtree: true })) animation.finish();
            await frames();
          };
          try {
            // 保留 full 默认值，仅通过真实 OS 媒体查询覆盖；不能只 stub matchMedia。
            assert(document.documentElement.dataset.motion === "full", "完整动态默认值被修改");
            const renderPage = (key, direction = 1, enabled = true, axis = "horizontal") =>
              ui.render(
                h(PagePan, { panKey: key, direction, enabled, axis }, h("button", null, key)),
              );
            const layers = () => [...ui.query('[data-slot="page-pan"]').children];
            const pause = (progress) => {
              for (const layer of layers()) {
                for (const animation of layer.getAnimations()) {
                  animation.pause();
                  animation.currentTime = Number(animation.effect.getTiming().duration) * progress;
                }
              }
            };
            renderPage("a");
            renderPage("b");
            if (reduced) {
              assert(layers().length === 1, "减少动态效果时 PagePan 仍保留离场层");
              assert(layers()[0].getAnimations().length === 0, "减少动态效果时仍创建页面动画");
            } else {
              pause(0.25);
              await frames();
              const [a, b] = layers();
              const aStart = x(a);
              const bStart = x(b);
              assert(bStart > 0 && bStart < b.clientWidth * 1.1, "页面没有中间帧");
              assert(a.inert && a.getAttribute("aria-hidden") === "true", "离场页面仍可键盘聚焦");
              renderPage("a", -1);
              pause(0);
              const [bLeaving, aReturning] = layers();
              assert(bLeaving === b && aReturning === a, "反向导航重新挂载了页面");
              assert(Math.abs(x(bLeaving) - bStart) < 0.5, "离场页反向时跳回原点");
              assert(Math.abs(x(aReturning) - aStart) < 0.5, "返回页没有从当前像素接管");
              pause(0.2);
              const current = x(aReturning);
              renderPage("c", -1);
              pause(0);
              const [leaving, incoming] = layers();
              assert(Math.abs(x(leaving) - current) < 0.5, "连续跳转丢失当前像素");
              assert(
                Math.abs(x(leaving) - x(incoming) - incoming.clientWidth * 1.1) < 0.5,
                "全新目标页未接在离场页旁边",
              );
              await finish(ui.host);
              assert(layers().length === 1, "动画结束没有清理离场层");
              assert(layers()[0].style.willChange === "", "动画结束残留 will-change");
              assert(layers()[0].getAnimations().length === 0, "动画结束残留 Animation");
              renderPage("d");
              pause(0.2);
              renderPage("e", 1, false);
              assert(layers().length === 1 && x(layers()[0]) === 0, "禁用导航未清理中断状态");
            }
            passed.push(reduced ? "页面减少动态效果" : "页面连续/反向接管、节点复用与清理");
            if (!reduced) {
              ui.render(null);
              renderPage("v0", 1, true, "vertical");
              renderPage("v1", 1, true, "vertical");
              pause(0.3);
              const y = (element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).m42;
              const [a, b] = layers();
              const before = [y(a), y(b)];
              renderPage("v0", -1, true, "vertical");
              pause(0);
              assert(
                Math.abs(y(layers()[0]) - before[1]) < 0.5 &&
                  Math.abs(y(layers()[1]) - before[0]) < 0.5,
                "纵向导航反向时回跳",
              );
              await finish(ui.host);
              assert(layers().length === 1 && y(layers()[0]) === 0, "纵向导航未清理并归位");
              passed.push("纵向导航反向接管与清理");
            }

            // 真正的 Base UI 弹层：中间帧反向关闭必须继续当前位置而不是重播。
            for (const drawer of [false, true]) {
              const Root = drawer ? Drawer : Dialog;
              const Content = drawer ? DrawerContent : DialogContent;
              const Title = drawer ? DrawerTitle : DialogTitle;
              const selector = drawer
                ? '[data-slot="drawer-content"]'
                : '[data-slot="dialog-content"]';
              const overlaySelector = drawer
                ? '[data-slot="drawer-overlay"]'
                : '[data-slot="dialog-overlay"]';
              const render = (open) =>
                ui.render(h(Root, { open }, h(Content, null, h(Title, null, "动效回归"))));
              render(false);
              render(true);
              await until(
                () => document.querySelector(selector)?.getAnimations().length > 0,
                "弹层没有入场动画",
              );
              const popup = document.querySelector(selector);
              if (!reduced) {
                for (const animation of popup.getAnimations()) {
                  animation.pause();
                  animation.currentTime = Number(animation.effect.getTiming().duration) * 0.35;
                }
                const before = getComputedStyle(popup);
                const position = {
                  transform: before.transform,
                  scale: before.scale,
                  opacity: before.opacity,
                };
                render(false);
                const after = getComputedStyle(popup);
                assert(
                  after.transform === position.transform && after.scale === position.scale,
                  "弹层关闭时从起点重播",
                );
                assert(
                  Math.abs(Number(after.opacity) - Number(position.opacity)) < 0.01,
                  "弹层反向时透明度跳变",
                );
                assert(
                  popup.isConnected && popup.hasAttribute("data-ending-style"),
                  "弹层退出未保留生命周期",
                );
                assert(getComputedStyle(popup).pointerEvents === "none", "退出弹层仍吞指针");
              } else {
                const style = getComputedStyle(popup);
                assert(style.transitionProperty === "opacity", "减少动态效果未退化为淡化");
                assert(
                  style.transform === "none" && (!drawer ? style.scale === "1" : true),
                  "减少动态效果仍在缩放/移动",
                );
                render(false);
                assert(getComputedStyle(popup).transform === "none", "减少动态效果退出时仍有位移");
              }
              const overlay = document.querySelector(overlaySelector);
              assert(
                getComputedStyle(overlay).transitionDuration ===
                  getComputedStyle(popup).transitionDuration,
                "遮罩与弹层退出不同步",
              );
              await finish(popup);
              await until(() => !popup.isConnected, "弹层退出未卸载");
            }
            passed.push(
              reduced ? "Dialog/Drawer 仅淡化并正常卸载" : "Dialog/Drawer 中途关闭连续、遮罩同拍",
            );

            // 菜单方向和减少动态效果的选择器优先级必须在实际 CSS 级联上验证。
            for (const className of ["motion-popup", "motion-tooltip"]) {
              for (const side of ["top", "bottom", "left", "right", "inline-start", "inline-end"]) {
                ui.render(
                  h("div", { className, "data-side": side, "data-starting-style": "" }, "菜单"),
                );
                const popup = ui.host.firstElementChild;
                const style = getComputedStyle(popup);
                if (reduced) {
                  assert(
                    style.transform === "none" && style.transitionProperty === "opacity",
                    `${className}/${side} 未减少空间动效`,
                  );
                } else {
                  assert(style.transform !== "none" && style.opacity === "0", "菜单初始帧丢失");
                }
              }
            }
            passed.push("六方向菜单的初始/减少动态效果样式");
            return passed;
          } finally {
            ui.dispose();
          }
        }, reducedMotion === "reduce");
        // 真正按住 Button：合成 pointerdown 不会激活 CSS :active。
        await page.evaluate(async () => {
          const { setupHarness } = await import("/tests/browser/harness.js");
          const { Button } = await import("/src/components/ui/button.tsx");
          const ui = await setupHarness({
            style: "position:fixed;left:100px;top:100px;z-index:1000",
          });
          ui.render(ui.h(Button, { id: "system-motion-press" }, "按压回归"));
          window.__motionPressFixture = ui;
        });
        try {
          const button = page.locator("#system-motion-press");
          const box = await button.boundingBox();
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.down();
          await page.evaluate((reduced) => {
            const button = document.querySelector("#system-motion-press");
            for (const animation of button.getAnimations()) animation.finish();
            const style = getComputedStyle(button);
            if (style.transitionDuration !== "0.08s") throw new Error("按压反馈没有使用快速时长");
            const scale = new DOMMatrixReadOnly(style.transform).m11;
            if (reduced ? scale !== 1 : !(scale < 1 && scale >= 0.97))
              throw new Error("按压缩放或减少动态效果不正确");
          }, reducedMotion === "reduce");
          await page.mouse.up();
          await page.evaluate(() => {
            const button = document.querySelector("#system-motion-press");
            for (const animation of button.getAnimations()) animation.finish();
            const style = getComputedStyle(button);
            if (
              style.transitionDuration !== "0.22s" ||
              new DOMMatrixReadOnly(style.transform).m11 !== 1
            ) {
              throw new Error("松开未平滑归位");
            }
          });
          passed.push("真实按下/松开的时长、缩放与无障碍覆盖");
        } finally {
          await page.mouse.up();
          await page.evaluate(() => {
            window.__motionPressFixture?.dispose();
            delete window.__motionPressFixture;
          });
        }
        results.push({ viewport, reducedMotion, passed });
      }
    }
    return { passed: results };
  } finally {
    await page.emulateMedia({ reducedMotion: null });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await cdp.detach();
  }
}
