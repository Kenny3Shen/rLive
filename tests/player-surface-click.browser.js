// 画面点按只能有一个所有者：Video.js 皮肤不挂声明式原生手势，播放页统一走
// `usePlayerStageTapGestures`（官方 `useTapGesture` / `useDoubleTapGesture` 的封装）。
// 夹具为两套皮肤（vod / live）各挂一份真实 VideoJsContainer + VideoJsVideo，并直接
// 调用那个真实钩子 —— 不再复刻播放页的手写判定，否则钩子本身坏掉时夹具依然会通过。
// 媒体元素用本地桩（`paused` / `play` / `pause` 全部记账），因此「识别器与皮肤各切一次」
// 会直接表现为双击后出现两次 play/pause。
//
// 断言的是移动端触摸语义（两页统一）：单击切换 HUD（隐藏时唤出、已可见时收起），
// 不动播放状态；双击播放/暂停且不泄漏成单击，也不再兼职全屏。桌面鼠标沿用点画面暂停、
// 双击全屏，因此夹具在页面内合成 `pointerType: "touch"` 的 pointer 事件（见下方 `tap`），
// 不走鼠标路径。
// 先启动 vite（bun run dev）并打开预览页，再执行：
//   playwright-cli -s=player-surface-click open http://127.0.0.1:1420/
//   playwright-cli -s=player-surface-click run-code --filename=tests/player-surface-click.browser.js
async (page) => {
  const VARIANTS = ["vod", "live"];

  await page.waitForFunction(() =>
    performance
      .getEntriesByType("resource")
      .some((item) => new URL(item.name).pathname.endsWith("/deps/react-dom_client.js")),
  );

  await page.evaluate(
    async ({ variants }) => {
      const { setupHarness, touchTap } = await import("/tests/browser/harness.js");
      const { VideoJsContainer, VideoJsPlayerProvider, VideoJsVideo } =
        await import("/src/features/room/player/videoJsControls.tsx");
      // 被测对象本体：播放页共用的舞台点按封装。
      const { usePlayerStageTapGestures } =
        await import("/src/shared/hooks/usePlayerStageTapGestures.ts");

      const state = {};
      const mounts = [];

      for (const [index, variant] of variants.entries()) {
        // Video.js player 是一次性外部实例，StrictMode 双挂载会重建它并让下面取到的
        // media ref 失效，因此这里退出 StrictMode。
        const ui = await setupHarness({ strict: false });
        mounts.push(ui);
        const { h, createRef } = ui;
        const videoRef = createRef();
        const variantState = {
          paused: false,
          plays: 0,
          pauses: 0,
          taps: 0,
          doubleTaps: 0,
          reveals: 0,
          hides: 0,
          // chrome 当前可见性，与两页 `controlsVisibleRef` 同一角色：切换语义要读它。
          chromeVisible: false,
          fullscreens: 0,
          // 滑动确认后置位的抑制标志，与播放页 `suppressClickRef` 同一角色：
          // 识别器的延迟回调必须读得到它。
          suppressed: false,
        };
        state[variant] = variantState;

        /** 与各播放页的 togglePlayback 同构。 */
        const togglePlayback = () => {
          const media = videoRef.current;
          if (!media) return;
          if (media.paused) void Promise.resolve(media.play()).catch(() => {});
          else media.pause();
        };

        // 钩子要求 Player 上下文，因此绑定发生在 VideoJsContainer 的子树内。
        function StageGestures() {
          usePlayerStageTapGestures({
            // 单击切换 chrome：隐藏时唤出、已可见时收起，两条路径都不碰播放状态。
            // 与两页的 `toggleControls` 同构。
            onTap: () => {
              variantState.taps += 1;
              if (variantState.chromeVisible) {
                variantState.hides += 1;
                variantState.chromeVisible = false;
                return;
              }
              variantState.reveals += 1;
              variantState.chromeVisible = true;
            },
            onDoubleTap: () => {
              variantState.doubleTaps += 1;
              togglePlayback();
            },
            shouldIgnore: () => variantState.suppressed,
          });
          return null;
        }

        ui.render(
          h(
            VideoJsPlayerProvider,
            null,
            h(
              VideoJsContainer,
              {
                variant,
                controls: null,
                [`data-surface-click-stage-${variant}`]: "",
                style: {
                  position: "fixed",
                  left: index * 500,
                  top: 0,
                  width: 480,
                  height: 270,
                  background: "#111",
                  zIndex: 999,
                },
              },
              h(
                "div",
                {
                  [`data-surface-click-surface-${variant}`]: "",
                  style: { position: "absolute", inset: 0 },
                },
                h(VideoJsVideo, {
                  ref: videoRef,
                  [`data-surface-click-video-${variant}`]: "",
                  style: { position: "absolute", inset: 0, width: "100%", height: "100%" },
                }),
              ),
              h(StageGestures),
            ),
          ),
        );

        /** 媒体桩：`paused` 与 play/pause 全部记账，供断言识别每一次切换。 */
        const media = videoRef.current;
        if (!media) throw new Error("播放器未挂载媒体元素");
        Object.defineProperties(media, {
          paused: { configurable: true, get: () => variantState.paused },
          play: {
            configurable: true,
            value: () => {
              variantState.plays += 1;
              variantState.paused = false;
              media.dispatchEvent(new Event("play"));
              return Promise.resolve();
            },
          },
          pause: {
            configurable: true,
            value: () => {
              variantState.pauses += 1;
              variantState.paused = true;
              media.dispatchEvent(new Event("pause"));
            },
          },
        });
      }

      const tap = (variant) => {
        const surface = document.querySelector(`[data-surface-click-surface-${variant}]`);
        if (!surface) throw new Error(`未找到 ${variant} 画面`);
        touchTap(surface);
      };

      window.__playerSurfaceClick = {
        state,
        tap,
        dispose: () => {
          for (const ui of mounts) ui.dispose();
          delete window.__playerSurfaceClick;
        },
      };
    },
    { variants: VARIANTS },
  );

  const passed = [];
  const readState = (variant) =>
    page.evaluate((name) => window.__playerSurfaceClick.state[name], variant);
  const setSuppressed = (variant, value) =>
    page.evaluate(
      ({ name, next }) => {
        window.__playerSurfaceClick.state[name].suppressed = next;
      },
      { name: variant, next: value },
    );
  const tap = (variant, times = 1) =>
    page.evaluate(
      ({ name, count }) => {
        for (let index = 0; index < count; index += 1) window.__playerSurfaceClick.tap(name);
      },
      { name: variant, count: times },
    );

  try {
    for (const variant of VARIANTS) {
      const surface = page.locator(`[data-surface-click-surface-${variant}]`);
      await surface.waitFor({ state: "visible" });
      /**
       * 等满双击判定窗口后核对累计计数。断言累计值而非增量：多出来的那次切换
       * 无论发生在哪一步都会一直显形。
       */
      const settle = async (label, expected) => {
        await page.waitForTimeout(600);
        const current = await readState(variant);
        for (const [key, value] of Object.entries(expected)) {
          if (current[key] !== value) {
            throw new Error(`${variant} ${label}：${key} 期望 ${value}，实际 ${current[key]}`);
          }
        }
      };

      // 单击唤出 chrome：播放状态一动不动（plays / pauses / paused 全不变）。
      await tap(variant);
      await settle("单击显示 HUD", {
        taps: 1,
        reveals: 1,
        hides: 0,
        chromeVisible: true,
        pauses: 0,
        plays: 0,
        paused: false,
      });

      // 已可见时再点收起（真机反馈：只唤不收无法把 HUD 点掉），仍然不碰播放状态。
      await tap(variant);
      await settle("再次单击隐藏 HUD", {
        taps: 2,
        reveals: 1,
        hides: 1,
        chromeVisible: false,
        pauses: 0,
        plays: 0,
        paused: false,
      });

      // 双击恰好切换一次播放状态，且不泄漏成单击（taps 不涨）。
      await tap(variant, 2);
      await settle("双击暂停", {
        taps: 2,
        doubleTaps: 1,
        pauses: 1,
        plays: 0,
        paused: true,
        fullscreens: 0,
      });

      // 再双击回到播放：仍是一次切换，方向相反。
      await tap(variant, 2);
      await settle("再双击继续", {
        taps: 2,
        doubleTaps: 2,
        pauses: 1,
        plays: 1,
        paused: false,
      });

      // 滑动确认后的抑制必须在识别器的延迟回调里生效：抬手时置位太晚，
      // 单击回调要等满双击窗口才跑，那时按压状态已经清理。
      await setSuppressed(variant, true);
      await tap(variant);
      await settle("滑动后抑制点按", {
        taps: 2,
        doubleTaps: 2,
        pauses: 1,
        plays: 1,
        paused: false,
      });
      await setSuppressed(variant, false);

      passed.push(
        `${variant} 皮肤：单击切换 HUD（唤出/收起各一次）不动播放状态，双击恰好切换一次播放（不泄漏单击、不切全屏），抑制标志否决延迟回调`,
      );
    }

    return { passed };
  } finally {
    await page.evaluate(() => window.__playerSurfaceClick?.dispose());
  }
};
