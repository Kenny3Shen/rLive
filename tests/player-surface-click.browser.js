// 画面点按只能有一个所有者：Video.js 皮肤不挂声明式原生手势，播放页统一走
// `usePlayerStageTapGestures`（官方 `useTapGesture` / `useDoubleTapGesture` 的封装）。
// 夹具为两套皮肤（vod / live）各挂一份真实 VideoJsContainer + VideoJsVideo，并直接
// 调用那个真实钩子 —— 不再复刻播放页的手写判定，否则钩子本身坏掉时夹具依然会通过。
// 媒体元素用本地桩（`paused` / `play` / `pause` 全部记账），因此「识别器与皮肤各切一次」
// 会直接表现为单击后出现两次 play/pause。
// 先启动 vite（bun run dev）并打开预览页，再执行：
//   playwright-cli -s=player-surface-click open http://127.0.0.1:1420/
//   playwright-cli -s=player-surface-click run-code --filename=tests/player-surface-click.browser.js
async (page) => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const VARIANTS = ["vod", "live"];

  await page.waitForFunction(() =>
    performance
      .getEntriesByType("resource")
      .some((item) => new URL(item.name).pathname.endsWith("/deps/react-dom_client.js")),
  );

  await page.evaluate(
    async ({ variants }) => {
      const dependencyUrl = (name) => {
        const resource = performance
          .getEntriesByType("resource")
          .find((item) => new URL(item.name).pathname.endsWith(`/deps/${name}.js`));
        if (!resource) throw new Error(`请先打开 Vite 预览页：未找到 ${name}`);
        return resource.name;
      };
      const { default: React } = await import(dependencyUrl("react"));
      const { default: ReactDOMClient } = await import(dependencyUrl("react-dom_client"));
      const { default: ReactDOM } = await import(dependencyUrl("react-dom"));
      const { VideoJsContainer, VideoJsPlayerProvider, VideoJsVideo } = await import(
        "/src/features/room/player/videoJsControls.tsx"
      );
      // 被测对象本体：播放页共用的舞台点按封装。
      const { usePlayerStageTapGestures } = await import(
        "/src/shared/hooks/usePlayerStageTapGestures.ts"
      );
      const { createElement: h, createRef } = React;
      const { flushSync } = ReactDOM;

      const state = {};
      const hosts = [];
      const roots = [];

      variants.forEach((variant, index) => {
        const host = document.createElement("div");
        document.body.append(host);
        hosts.push(host);
        const videoRef = createRef();
        state[variant] = {
          paused: false,
          plays: 0,
          pauses: 0,
          taps: 0,
          doubleTaps: 0,
          fullscreens: 0,
        };
        const variantState = state[variant];

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
            onTap: () => {
              variantState.taps += 1;
              togglePlayback();
            },
            onDoubleTap: () => {
              variantState.doubleTaps += 1;
              variantState.fullscreens += 1;
            },
          });
          return null;
        }

        const root = ReactDOMClient.createRoot(host);
        roots.push(root);
        flushSync(() =>
          root.render(
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
      });

      window.__playerSurfaceClick = {
        state,
        dispose: () => {
          flushSync(() => {
            for (const root of roots) root.unmount();
          });
          for (const host of hosts) host.remove();
          delete window.__playerSurfaceClick;
        },
      };
    },
    { variants: VARIANTS },
  );

  const passed = [];
  const state = (variant) =>
    page.evaluate((name) => window.__playerSurfaceClick.state[name], variant);

  try {
    for (const variant of VARIANTS) {
      const surface = page.locator(`[data-surface-click-surface-${variant}]`);
      await surface.waitFor({ state: "visible" });
      const box = await surface.boundingBox();
      const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

      // 1) 单击暂停：识别器等满双击窗口后只派发一次单击，业务侧一次切换即止。
      await page.mouse.click(center.x, center.y);
      await page.waitForTimeout(600);
      let current = await state(variant);
      assert(current.taps === 1, `${variant}：单击未到达画面（taps=${current.taps}）`);
      assert(
        current.pauses === 1 && current.plays === 0,
        `${variant}：单击切换次数不为 1（pause=${current.pauses}，play=${current.plays}）`,
      );
      assert(current.paused === true, `${variant}：单击后媒体未停在暂停态`);

      // 2) 再次单击继续播放：同样只有一次切换。
      await page.mouse.click(center.x, center.y);
      await page.waitForTimeout(600);
      current = await state(variant);
      assert(
        current.pauses === 1 && current.plays === 1,
        `${variant}：第二次单击切换次数异常（pause=${current.pauses}，play=${current.plays}）`,
      );
      assert(current.paused === false, `${variant}：第二次单击后媒体未继续播放`);

      // 3) 双击：只提交全屏意图，不得再泄漏出一次单击暂停。
      await page.mouse.dblclick(center.x, center.y);
      await page.waitForTimeout(600);
      current = await state(variant);
      assert(
        current.doubleTaps === 1,
        `${variant}：双击未到达画面（doubleTaps=${current.doubleTaps}）`,
      );
      assert(current.taps === 2, `${variant}：双击泄漏成单击（taps=${current.taps}）`);
      assert(
        current.pauses === 1 && current.plays === 1,
        `${variant}：双击泄漏成播放切换（pause=${current.pauses}，play=${current.plays}）`,
      );
      assert(
        current.fullscreens === 1,
        `${variant}：双击全屏意图不唯一（fullscreens=${current.fullscreens}）`,
      );

      passed.push(`${variant} 皮肤：单击只切换一次播放状态（停在暂停 → 继续），双击只切换全屏`);
    }

    return { passed };
  } finally {
    await page.evaluate(() => window.__playerSurfaceClick?.dispose());
  }
}
