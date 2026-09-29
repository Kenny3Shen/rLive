// VOD 发现页「刷新获取新推送」的性能采样（Windows 主窗口 / 真实 WebView2）。
//
// 目的：把「点一次刷新到新一批卡片可交互」拆成可分别度量的阶段 —— IPC 往返、
// 数据落地到提交、React 提交与布局、封面图片重新解码 —— 而不是只给一个总数。
// 不替换 IPC、网络或组件，只在真实页面上埋观测点。
//
// 用法（先停在 /video 页，页签/分区随意，脚本不改路由与设置）：
//   playwright-cli -s=rwin attach --cdp=http://127.0.0.1:9223
//   playwright-cli -s=rwin eval 'window.__vodRefreshConfig = {rounds:5}'
//   playwright-cli -s=rwin --raw run-code --filename=tests/vod-refresh-performance.browser.js > .playwright-cli/vod-refresh.json
//
// 结果同时留在 window.__vodRefreshResult（汇总）与 window.__vodRefreshRounds（逐轮原始事件）。
async (page) => {
  const config = await page.evaluate(() => {
    if (!window.__TAURI_INTERNALS__) throw new Error("请连接真实 Tauri 主窗口");
    if (location.pathname !== "/video") throw new Error(`请先停在 /video 发现页，当前是 ${location.pathname}`);
    return { rounds: window.__vodRefreshConfig?.rounds ?? 5 };
  });

  const client = await page.context().newCDPSession(page);
  const errors = [];
  const onError = (error) => errors.push({ message: error.message, stack: error.stack });
  page.on("pageerror", onError);
  const round1 = (value) => Math.round(value * 10) / 10;

  try {
    await client.send("Network.enable");
    // 请求观测：每次刷新会重取推荐/热门首页，并把整屏封面重新走一遍图片代理。
    const requests = new Map();
    const ipc = [];
    let captureRequests = false;
    client.on("Network.requestWillBeSent", (event) => {
      const match = /^(https?:\/\/(?:ipc\.localhost|127\.0\.0\.1)(?::\d+)?)(\/[^?#]*)/.exec(
        event.request.url,
      );
      if (!match || event.request.method === "OPTIONS") return;
      requests.set(event.requestId, {
        url: match[1] + match[2],
        method: event.request.method,
        epoch: event.wallTime * 1000,
        monotonic: event.timestamp * 1000,
      });
    });
    client.on("Network.responseReceived", (event) => {
      const row = requests.get(event.requestId);
      if (!row) return;
      row.status = event.response.status;
      row.mime = event.response.mimeType;
      row.diskCache = event.response.fromDiskCache ?? false;
      row.fromServiceWorker = event.response.fromServiceWorker ?? false;
    });
    client.on("Network.loadingFinished", (event) => {
      const row = requests.get(event.requestId);
      if (!row) return;
      row.totalMs = round1(event.timestamp * 1000 - row.monotonic);
      row.bytes = event.encodedDataLength;
      if (captureRequests) ipc.push({ ...row, t: row.epoch });
    });
    client.on("Network.loadingFailed", (event) => {
      const row = requests.get(event.requestId);
      if (!row) return;
      row.error = event.errorText;
      row.totalMs = round1(event.timestamp * 1000 - row.monotonic);
      if (captureRequests) ipc.push({ ...row, t: row.epoch });
    });

    await page.evaluate(() => {
      const rows = [];
      const cleanups = [];
      const log = (kind, values = {}) => rows.push({ kind, at: performance.now(), ...values });

      // IPC 观测：包住页面自己的 fetch，只记 ipc.localhost 的命令往返。
      const fetchOriginal = window.fetch;
      window.fetch = async function (input) {
        const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const url = new URL(raw, location.href);
        if (url.hostname !== "ipc.localhost") return fetchOriginal.apply(this, arguments);
        const command = decodeURIComponent(url.pathname.slice(1));
        const start = performance.now();
        try {
          const response = await fetchOriginal.apply(this, arguments);
          log("ipc-response", { command, ms: performance.now() - start, status: response.status });
          return response;
        } catch (error) {
          log("ipc-error", { command, ms: performance.now() - start });
          throw error;
        }
      };

      // 长任务：刷新期间主线程被 React 提交 / 布局 / 解码占用的直接证据。
      const tasks = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) log("longtask", { at: entry.startTime, ms: entry.duration });
      });
      tasks.observe({ type: "longtask" });

      // 卡片数量与身份变化：新一批卡片进入 DOM 的时刻，就是「刷新完成」。
      const cardIds = () =>
        [...document.querySelectorAll("button[data-page-scroll-anchor^='video:']")]
          .map((card) => card.getAttribute("data-page-scroll-anchor"))
          .join("|");
      const cardCount = () =>
        document.querySelectorAll("button[data-page-scroll-anchor^='video:']").length;
      const grid = () =>
        document.querySelector('[data-slot="video-masonry"]') ??
        document.querySelector('[data-slot="video-masonry-item"]')?.parentElement ??
        null;
      let lastIds = cardIds();
      let lastCount = cardCount();
      const observer = new MutationObserver(() => {
        const ids = cardIds();
        const count = cardCount();
        if (ids !== lastIds) {
          // 记下每次变化的条数：刷新会先清空（0 条 → 骨架屏）再回填，
          // 只看「变了」会把清空那一刻当成刷新完成。
          log("cards-changed", { count, previous: lastCount });
          lastIds = ids;
          lastCount = count;
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      // 封面图片：刷新会把整屏 <img> 重新走一遍本机图片代理。
      const imgObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!/\/img(\?|$)/.test(entry.name)) continue;
          log("img", {
            ms: Math.round(entry.duration * 10) / 10,
            transferSize: entry.transferSize,
            decodedBodySize: entry.decodedBodySize,
          });
        }
      });
      imgObserver.observe({ type: "resource", buffered: false });

      window.__vodRefreshProbe = {
        rows,
        dispose() {
          tasks.disconnect();
          observer.disconnect();
          imgObserver.disconnect();
          window.fetch = fetchOriginal;
          delete window.__vodRefreshProbe;
        },
      };
    });

    const refreshButton = page.getByRole("button", { name: /^刷新/ });
    if ((await refreshButton.count()) !== 1) {
      throw new Error("未找到唯一的刷新按钮（需要桌面端 /video 发现页）");
    }
    const countCards = () =>
      page.evaluate(
        () => document.querySelectorAll("button[data-page-scroll-anchor^='video:']").length,
      );

    const rounds = [];
    for (let index = 0; index < config.rounds; index++) {
      // 每轮先把探针事件清空，再点刷新；等待新一批卡片（身份或数量变化）落地。
      const before = await page.evaluate(() => {
        window.__vodRefreshProbe.rows.length = 0;
        return [...document.querySelectorAll("button[data-page-scroll-anchor^='video:']")].map(
          (card) => card.getAttribute("data-page-scroll-anchor"),
        );
      });
      ipc.length = 0;
      captureRequests = true;
      await page.evaluate(() => {
        window.__vodRefreshProbe.rows.push({ kind: "click", at: performance.now() });
      });
      await refreshButton.click();
      // 刷新完成的判据：卡片身份变化 **且** 刷新按钮不再 pending（按钮的 disabled
      // 由 `manualRefreshing` 驱动，它到查询落定才清）。
      let timedOut = false;
      try {
        await page.waitForFunction(
          (previous) => {
            const now = [...document.querySelectorAll("button[data-page-scroll-anchor^='video:']")].map(
              (card) => card.getAttribute("data-page-scroll-anchor"),
            );
            const changed = now.length !== previous.length || now.some((id, i) => id !== previous[i]);
            const button = document.querySelector('[data-slot="refresh-fab"]');
            return changed && button && !button.disabled;
          },
          before,
          { timeout: 30_000 },
        );
      } catch {
        timedOut = true;
      }
      // 图片与后续长任务在按钮恢复之后才陆续落地，因此捕获窗口要一直开到它们静默。
      await page.waitForTimeout(500);
      await page
        .waitForFunction(
          () => {
            const images = [...document.querySelectorAll("button[data-page-scroll-anchor^='video:'] img")];
            return images.length > 0 && images.every((img) => img.complete);
          },
          null,
          { timeout: 15_000 },
        )
        .catch(() => undefined);
      captureRequests = false;
      const capture = await page.evaluate(() => {
        const rows = window.__vodRefreshProbe.rows;
        const click = rows.find((row) => row.kind === "click");
        return {
          events: rows.map(({ at, ...row }) => ({ ...row, t: Math.round((at - click.at) * 10) / 10 })),
          cards: document.querySelectorAll("button[data-page-scroll-anchor^='video:']").length,
          // 图片是否真的重新解码：`complete` 与 `naturalWidth` 是浏览器的事实。
          images: [...document.querySelectorAll("button[data-page-scroll-anchor^='video:'] img")]
            .slice(0, 40)
            .map((img) => ({ complete: img.complete, width: img.naturalWidth })),
        };
      });
      rounds.push({ round: index + 1, timedOut, ...capture, network: ipc.map(({ epoch, ...row }) => row) });
      // 轮次之间留出间隔，避免连续点击被 `manualRefreshing` 吃掉。
      await page.waitForTimeout(600);
    }

    const summarize = (events) => {
      const click = 0;
      const changes = events.filter((event) => event.kind === "cards-changed");
      // 刷新会先清空再回填：完成时刻是**最后一次**变化（回填到位）。
      const cardsChanged = changes.at(-1);
      const cleared = changes.find((event) => event.count === 0);
      const ipcResponses = events.filter((event) => event.kind === "ipc-response");
      const listIpc = ipcResponses.filter((event) => event.command === "video_get_recommend");
      const zoneIpc = ipcResponses.filter((event) => event.command === "video_zone_list");
      const images = events.filter((event) => event.kind === "img");
      const longtasks = events.filter((event) => event.kind === "longtask");
      return {
        clearedMs: cleared ? cleared.t : null,
        cardsChangedMs: cardsChanged ? cardsChanged.t : null,
        cardChanges: changes.map((event) => ({ t: event.t, count: event.count })),
        listIpcMs: listIpc.length ? Math.max(...listIpc.map((event) => event.ms)) : null,
        listIpcStartMs: listIpc.length ? Math.min(...listIpc.map((event) => event.t - event.ms)) : null,
        zoneIpcMs: zoneIpc.length ? Math.max(...zoneIpc.map((event) => event.ms)) : null,
        imageCount: images.length,
        imageTotalMs: round1(images.reduce((sum, event) => sum + event.ms, 0)),
        imageMaxMs: images.length ? Math.max(...images.map((event) => event.ms)) : null,
        imageDecodedBytes: images.reduce((sum, event) => sum + (event.decodedBodySize ?? 0), 0),
        longTaskCount: longtasks.length,
        longTaskTotalMs: round1(longtasks.reduce((sum, event) => sum + event.ms, 0)),
        longTaskMaxMs: longtasks.length ? round1(Math.max(...longtasks.map((event) => event.ms))) : null,
      };
    };

    const summary = rounds.map((round) => ({
      round: round.round,
      timedOut: round.timedOut,
      cards: round.cards,
      imagesLoaded: round.images.filter((image) => image.complete && image.width > 0).length,
      ...summarize(round.events),
      // 上游 IPC 各命令的完整往返（含页面侧排队）。
      ipc: round.network
        .filter((row) => row.url.includes("ipc.localhost") && row.method !== "OPTIONS")
        .map((row) => ({ url: row.url, status: row.status, totalMs: row.totalMs, bytes: row.bytes })),
      // 封面图片：刷新会重挂所有卡片，图片因此整屏重新走一遍本机图片代理。
      // `diskCache` 为 true 说明后端缓存命中，网络耗时仍会计入（本地回环）。
      images: round.network
        .filter((row) => /\/img(\?|$)/.test(row.url))
        .map((row) => ({ totalMs: row.totalMs, bytes: row.bytes, diskCache: row.diskCache })),
      imageTotals: {
        count: round.network.filter((row) => /\/img(\?|$)/.test(row.url)).length,
        sumMs: round1(
          round.network
            .filter((row) => /\/img(\?|$)/.test(row.url))
            .reduce((sum, row) => sum + (row.totalMs ?? 0), 0),
        ),
        diskCacheHits: round.network.filter((row) => /\/img(\?|$)/.test(row.url) && row.diskCache)
          .length,
        bytes: round.network
          .filter((row) => /\/img(\?|$)/.test(row.url))
          .reduce((sum, row) => sum + (row.bytes ?? 0), 0),
      },
    }));

    const median = (values) => {
      const sorted = values.filter((value) => value != null).sort((a, b) => a - b);
      if (!sorted.length) return null;
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[middle] : round1((sorted[middle - 1] + sorted[middle]) / 2);
    };

    const result = {
      page: await page.evaluate(() => ({
        url: location.href,
        userAgent: navigator.userAgent,
        devicePixelRatio,
        viewport: { width: innerWidth, height: innerHeight },
      })),
      config,
      errors,
      rounds: summary,
      medians: {
        cardsChangedMs: median(summary.map((round) => round.cardsChangedMs)),
        listIpcMs: median(summary.map((round) => round.listIpcMs)),
        imageTotalMs: median(summary.map((round) => round.imageTotalMs)),
        imageMaxMs: median(summary.map((round) => round.imageMaxMs)),
        longTaskTotalMs: median(summary.map((round) => round.longTaskTotalMs)),
      },
    };

    await page.evaluate((payload) => {
      window.__vodRefreshResult = payload;
      window.__vodRefreshRounds = payload.rounds;
    }, result);
    return result;
  } finally {
    await page.evaluate(() => window.__vodRefreshProbe?.dispose()).catch(() => {});
    page.off("pageerror", onError);
    await client.detach();
  }
}
