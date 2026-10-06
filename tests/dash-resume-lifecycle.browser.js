// 真实 DASH 引擎回归：续播直接加载目标分片，同一媒体重建后不得残留旧监听。
// 在 Vite dev 页（可用 Windows 主窗口）执行：
// playwright-cli -s=rwin run-code --filename=tests/dash-resume-lifecycle.browser.js
async (page) => {
  const origin = page.url().match(/^https?:\/\/[^/]+/)[0];
  const originalUrl = page.url();
  const errors = [];
  const requests = [];
  let injectedFailures = 0;
  const segmentPattern = "**/tests/assets/shorts-dash/chunk-0-00004.m4s";
  const failOnce = async (route) => {
    if (injectedFailures === 0) {
      injectedFailures++;
      await route.fulfill({ status: 503, body: "临时分片错误" });
    } else {
      await route.continue();
    }
  };
  const onError = (error) => errors.push(error.message);
  const onRequest = (request) => {
    if (request.url().includes("/tests/assets/shorts-dash/")) requests.push(request.url());
  };
  await page.goto(`${origin}/settings`);
  page.on("pageerror", onError);
  page.on("request", onRequest);
  await page.route(segmentPattern, failOnce);
  try {
    const result = await page.evaluate(async () => {
      const { createVideoJsPlayer, loadVideoJsModules, videoJsDashBufferSettings } =
        await import("/src/features/room/player/videoJsPlayer.ts");
      const modules = await loadVideoJsModules("dash");
      const media = document.createElement("video");
      media.muted = true;
      document.body.append(media);
      const until = async (predicate, label) => {
        const deadline = performance.now() + 12000;
        while (!predicate()) {
          if (performance.now() > deadline) throw new Error(label);
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      };
      let player;
      const positions = [];
      const terminalErrors = [];
      try {
        for (const startTime of [6, 4, 6]) {
          player = createVideoJsPlayer(modules, {
            video: media,
            kind: "dash",
            url: `${location.origin}/tests/assets/shorts-dash/out.mpd`,
            startTime,
            dash: videoJsDashBufferSettings("warm"),
          });
          player.on("error", (error) => terminalErrors.push(String(error?.message ?? error)));
          await until(
            () => media.readyState >= 3 && media.currentTime >= startTime,
            `续播未定位到 ${startTime}s`,
          );
          positions.push(media.currentTime);
          player.destroy();
          player = null;
          // 复用媒体的下一会话还会继续产生这些事件；旧引擎必须已经解绑。
          for (const type of ["seeking", "seeked", "progress", "timeupdate"]) {
            media.dispatchEvent(new Event(type));
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return { positions, terminalErrors };
      } finally {
        player?.destroy();
        media.remove();
      }
    });
    if (errors.length) throw new Error(`DASH 清理后残留监听：${errors.join("; ")}`);
    if (result.terminalErrors.length)
      throw new Error(`分片恢复后不应报终止错误：${result.terminalErrors}`);
    if (injectedFailures !== 1) throw new Error("未覆盖分片临时失败后的重试");
    if (requests.some((url) => url.includes("chunk-0-00001.m4s"))) {
      throw new Error("续播不应先下载 0 秒分片");
    }
    return {
      passed: true,
      ...result,
      injectedFailures,
      requests: requests.map((url) => url.replace(origin, "")),
    };
  } finally {
    page.off("pageerror", onError);
    page.off("request", onRequest);
    await page.unroute(segmentPattern, failOnce);
    await page.goto(originalUrl);
  }
}
