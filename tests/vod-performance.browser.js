// Windows Debug 主窗口的真实 VOD 加载采样；不替换 IPC、网络或媒体引擎。
// 先停在视频历史页，指定要点击的卡片可访问名称（正则表达式）：
// playwright-cli -s=rwin eval 'window.__vodPerformanceConfig = {cardName: "^27:11 选哪个？iPhone"}'
// playwright-cli -s=rwin --raw run-code --filename=tests/vod-performance.browser.js > .playwright-cli/vod-result.json
// 正常播放会更新观看历史；固定续播位置应在采样前准备。本脚本不改写历史或设置。
// 完整 CPU profile 留在 window.__vodPerformanceProfile，可另行导出为 .cpuprofile。
async (page) => {
  const config = await page.evaluate(() => {
    if (!window.__TAURI_INTERNALS__) throw new Error("请连接真实 Tauri 主窗口");
    return window.__vodPerformanceConfig;
  });
  if (!config?.cardName) throw new Error("请先设置 window.__vodPerformanceConfig.cardName");
  if (await page.locator("video").count()) throw new Error("请先返回视频历史页再采样");
  const card = page.getByRole("button", { name: new RegExp(config.cardName) });
  if ((await card.count()) !== 1) throw new Error("cardName 必须只匹配一张视频卡片");
  const client = await page.context().newCDPSession(page);
  const requests = new Map();
  const pendingBodies = [];
  const errors = [];
  let info = null;
  let profiling = false;
  const onError = (error) => errors.push({ message: error.message, stack: error.stack });
  page.on("pageerror", onError);
  const round = (value) => Math.round(value * 10) / 10;
  try {
    await client.send("Network.enable");
    client.on("Network.requestWillBeSent", (event) => {
      // playwright-cli 的 run-code 沙箱不保证提供 Node 全局 URL。
      const match = /^(https?:\/\/(?:ipc\.localhost|127\.0\.0\.1)(?::\d+)?)(\/[^?#]*)/.exec(event.request.url);
      if (!match || match[2] === "/img" || event.request.method === "OPTIONS") return;
      requests.set(event.requestId, {
        url: match[1] + match[2],
        method: event.request.method,
        range: event.request.headers.Range ?? event.request.headers.range,
        epoch: event.wallTime * 1000,
        monotonic: event.timestamp * 1000,
      });
    });
    client.on("Network.responseReceived", (event) => {
      const row = requests.get(event.requestId);
      if (!row) return;
      const timing = event.response.timing;
      Object.assign(row, {
        status: event.response.status,
        // Tauri 自定义协议没有 receiveHeadersStart；使用 receiveHeadersEnd。
        headersMs: timing
          ? round(timing.receiveHeadersStart >= 0 ? timing.receiveHeadersStart : timing.receiveHeadersEnd)
          : null,
        diskCache: event.response.fromDiskCache ?? false,
      });
    });
    client.on("Network.loadingFinished", (event) => {
      const row = requests.get(event.requestId);
      if (!row) return;
      row.totalMs = round(event.timestamp * 1000 - row.monotonic);
      row.bytes = event.encodedDataLength;
      if (row.url.endsWith("/video_get_play_info")) {
        pendingBodies.push(client.send("Network.getResponseBody", { requestId: event.requestId })
          .then((body) => {
            if (body.base64Encoded) throw new Error("播放信息响应为意外的二进制编码");
            info = JSON.parse(body.body);
          }).catch((error) => errors.push({ message: `读取播放信息失败：${error.message}` })));
      }
    });
    client.on("Network.loadingFailed", (event) => {
      const row = requests.get(event.requestId);
      if (row) Object.assign(row, {
        totalMs: round(event.timestamp * 1000 - row.monotonic),
        error: event.errorText,
      });
    });
    await page.evaluate(() => {
      const rows = [];
      const cleanups = [];
      const log = (kind, values = {}) => rows.push({ kind, at: performance.now(), ...values });
      const fetchOriginal = window.fetch;
      const currentTimeOriginal = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime");
      window.fetch = async function (input) {
        const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const url = new URL(raw, location.href);
        if (url.hostname !== "ipc.localhost") return fetchOriginal.apply(this, arguments);
        const start = performance.now();
        try {
          const response = await fetchOriginal.apply(this, arguments);
          log("ipc-fetch-response", { command: decodeURIComponent(url.pathname.slice(1)), ms: performance.now() - start, status: response.status });
          return response;
        } catch (error) {
          log("ipc-fetch-error", { command: url.pathname.slice(1), ms: performance.now() - start });
          throw error;
        }
      };
      Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
        ...currentTimeOriginal,
        set(value) {
          log("set-currentTime", { time: value, ready: this.readyState });
          return currentTimeOriginal.set.call(this, value);
        },
      });
      const click = () => log("click");
      document.addEventListener("click", click, { capture: true, once: true });
      const observed = new WeakSet();
      const observer = new MutationObserver(() => {
        for (const video of document.querySelectorAll("video")) {
          if (observed.has(video)) continue;
          observed.add(video);
          log("video-created");
          for (const kind of ["loadstart", "loadedmetadata", "loadeddata", "playing", "waiting", "seeking", "seeked", "error"]) {
            const handler = () => log(kind, { time: video.currentTime, ready: video.readyState });
            video.addEventListener(kind, handler);
            cleanups.push(() => video.removeEventListener(kind, handler));
          }
          const frame = video.requestVideoFrameCallback((_, metadata) => log("first-frame", { time: metadata.mediaTime }));
          cleanups.push(() => video.cancelVideoFrameCallback(frame));
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      const tasks = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) log("longtask", { at: entry.startTime, ms: entry.duration });
      });
      tasks.observe({ type: "longtask" });
      window.__vodPerformanceProbe = {
        rows,
        dispose() {
          tasks.disconnect();
          observer.disconnect();
          cleanups.forEach((cleanup) => cleanup());
          document.removeEventListener("click", click, true);
          window.fetch = fetchOriginal;
          Object.defineProperty(HTMLMediaElement.prototype, "currentTime", currentTimeOriginal);
          delete window.__vodPerformanceProbe;
        },
      };
    });
    await client.send("Profiler.enable");
    await client.send("Profiler.start");
    profiling = true;
    await card.click();
    let timeout = false;
    try {
      await page.waitForFunction(() => {
        const rows = window.__vodPerformanceProbe.rows;
        return rows.some((row) => row.kind === "playing") && rows.some((row) => row.kind === "first-frame");
      }, null, { timeout: config.timeoutMs ?? 45000 });
    } catch { timeout = true; }
    const { profile } = await client.send("Profiler.stop");
    profiling = false;
    await Promise.all(pendingBodies);
    const captured = await page.evaluate(() => {
      const rows = window.__vodPerformanceProbe.rows;
      const click = rows.find((row) => row.kind === "click");
      if (!click) throw new Error("未捕获到卡片点击");
      return {
        clickEpoch: performance.timeOrigin + click.at,
        events: rows.map(({ at, ...row }) => ({ ...row, t: Math.round((at - click.at) * 10) / 10 })),
        userAgent: navigator.userAgent,
        video: { time: document.querySelector("video")?.currentTime, ready: document.querySelector("video")?.readyState },
      };
    });
    const telemetry = info?.session_ids ? await page.evaluate(async (ids) => {
      const result = {};
      for (const [track, sessionId] of Object.entries(ids)) {
        result[track] = await window.__TAURI_INTERNALS__.invoke("stream_proxy_telemetry", { sessionId });
      }
      return result;
    }, info.session_ids) : null;
    const frames = new Map(profile.nodes.map((node) => [node.id, node.callFrame]));
    const cpu = new Map();
    for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
      const frame = frames.get(profile.samples[i]);
      const key = `${frame.functionName || "(anonymous)"} @ ${frame.url.split("?")[0]}`;
      cpu.set(key, (cpu.get(key) ?? 0) + profile.timeDeltas[i] / 1000);
    }
    const { clickEpoch, ...capture } = captured;
    const result = {
      ...capture, timeout, info, telemetry, errors,
      network: [...requests.values()].map(({ epoch, monotonic, ...row }) => ({ ...row, t: round(epoch - clickEpoch) })),
      cpuTop: [...cpu].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([frame, ms]) => ({ frame, ms: round(ms) })),
    };
    await page.evaluate(({ profile, result }) => {
      window.__vodPerformanceProfile = profile;
      window.__vodPerformanceResult = result;
      document.querySelector("video")?.pause();
    }, { profile, result });
    return result;
  } finally {
    if (profiling) await client.send("Profiler.stop").catch(() => {});
    await page.evaluate(() => window.__vodPerformanceProbe?.dispose()).catch(() => {});
    page.off("pageerror", onError);
    await client.detach();
  }
}
