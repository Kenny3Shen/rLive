// Windows 主窗口：真实 React/Query/槽位 hook；用可控 DASH 适配器与 IPC 测资源所有权。
// playwright-cli -s=rwin run-code --filename=tests/shorts-playback-lifecycle.browser.js
async (page) => {
  const patches = [
    [
      "**/src/shared/api/tauri.ts*",
      "/src/shared/api/tauri.ts",
      "async function invokeCmd(cmd, args) {",
      "if (window.__shortsInvoke) return window.__shortsInvoke(cmd, args);",
    ],
    [
      "**/src/features/room/player/videoJsPlayer.ts*",
      "/src/features/room/player/videoJsPlayer.ts",
      "async function loadVideoJsModules(kind) {",
      "if (window.__shortsModules) return window.__shortsModules;",
    ],
  ];
  for (const [pattern] of patches) await page.unroute(pattern);
  await page.reload();
  for (const [pattern, path, signature, injection] of patches) {
    const source = await page.evaluate(async (path) => (await fetch(path)).text(), path);
    if (!source.includes(signature)) throw new Error(`测试注入点已改变：${path}`);
    await page.route(pattern, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: source.replace(signature, `${signature}\n${injection}`),
      }),
    );
  }
  try {
    await page.goto(`${page.url().match(/^https?:\/\/[^/]+/)[0]}/settings`);
    return await page.evaluate(async () => {
      const { setupHarness, dependencyUrl, until, frames, assert } =
        await import("/tests/browser/harness.js");
      const { QueryClient, QueryClientProvider } = await import(
        dependencyUrl("@tanstack_react-query")
      );
      const { useShortsPlaybackSlot } = await import("/src/features/shorts/useShortsPlayback.ts");
      const harness = await setupHarness();
      const { h, React } = harness;
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const stopped = [];
      const issued = [];
      const players = [];
      let serial = 0;
      let late;
      let state;
      let media;
      class Dash extends EventTarget {
        handlers = new Map();
        engine = {
          on: (name, fn) => this.handlers.set(name, fn),
          off: (name) => this.handlers.delete(name),
        };
        source = null;
        destroyed = false;
        constructor() {
          super();
          players.push(this);
        }
        attach() {}
        set src(src) {
          this.source = { ...this.source, src };
        }
        destroy() {
          this.destroyed = true;
        }
      }
      window.__shortsModules = { DashAdapter: Dash };
      const info = () => {
        const id = `test-${++serial}`;
        const value = {
          mpd_url: `http://localhost/${id}.mpd`,
          video_url: "",
          audio_url: "",
          duration: 60,
          quality: 80,
          quality_label: "测试",
          codecs: "avc1",
          accept_quality: [],
          audio_only: false,
          session_ids: { video: `${id}-v`, audio: `${id}-a`, mpd: `${id}-m` },
        };
        issued.push(value);
        return value;
      };
      const original = window.__TAURI_INTERNALS__.invoke;
      window.__shortsInvoke = async (command, args) => {
        if (command === "video_get_play_info") {
          if (args.request.cid === 3)
            return new Promise((resolve) => {
              late = () => resolve(info());
            });
          return info();
        }
        if (command === "video_stop_play") {
          stopped.push(args.sessionIds.mpd);
          return;
        }
        if (command === "video_history_add") return;
        return original(command, args);
      };
      const item = (id) => ({
        bvid: `BVtest${id}`,
        cid: id,
        aid: String(id),
        title: "测试",
        cover: "",
        author: "测试",
        duration: 60,
        view: 0,
        danmaku: 0,
        pubdate: 0,
      });
      function Slot({ id, mode, allowed }) {
        const ref = React.useRef(null);
        state = useShortsPlaybackSlot({
          item: React.useMemo(() => item(id), [id]),
          slotId: "a",
          videoRef: ref,
          mode,
          mediaAllowed: allowed,
        });
        return h("video", {
          ref: (node) => {
            ref.current = node;
            if (node) media = node;
          },
        });
      }
      const render = (id, mode = "warm", allowed = true) =>
        harness.render(h(QueryClientProvider, { client }, h(Slot, { id, mode, allowed })));
      try {
        render(1);
        await until(() => players.some((p) => !p.destroyed), "未创建播放器");
        const player = players.findLast((p) => !p.destroyed);
        Object.defineProperty(media, "readyState", { configurable: true, value: 1 });
        media.dispatchEvent(new Event("loadedmetadata"));
        await frames();
        assert(!state.ready, "元数据不能放行邻居媒体");
        Object.defineProperty(media, "readyState", { configurable: true, value: 3 });
        media.dispatchEvent(new Event("canplay"));
        await until(() => state.ready, "canplay 未就绪");
        assert(
          player.source.engine.dashJs.streaming.scheduling.scheduleWhilePaused === false,
          "预热到 canplay 后仍调度",
        );
        render(1, "play");
        await frames();
        assert(
          player.source.engine.dashJs.streaming.buffer.bufferTimeDefault === 18,
          "提升后未恢复正常预算",
        );
        render(1, "warm", false);
        await frames();
        assert(
          player.source.engine.dashJs.streaming.scheduling.scheduleWhilePaused === false,
          "已附着邻居未受门控",
        );
        const previousUrl = player.source.src;
        render(2, "warm");
        await until(
          () => player.source.src !== previousUrl && player.source.src === issued.at(-1).mpd_url,
          "未换到新媒体源",
        );
        assert(players.filter((p) => !p.destroyed).length === 1, "换片重建或泄漏了播放器");
        player.handlers.get("error")({ error: { message: "第二条媒体错误" } });
        await until(() => state.error === "第二条媒体错误", "换源后的错误被旧 token 吞掉");
        render(3);
        await until(() => !!late, "没有在途取流");
        harness.dispose();
        late();
        await until(
          () => issued.every((i) => stopped.includes(i.session_ids.mpd)),
          "卸载/迟到结果仍有未释放会话",
        );
        assert(
          players.every((p) => p.destroyed),
          "卸载未销毁播放器",
        );
        assert(new Set(stopped).size === stopped.length, "代理被重复释放");
        return {
          passed: true,
          issued: issued.length,
          stopped: stopped.length,
          players: players.length,
        };
      } finally {
        harness.dispose();
        client.clear();
        delete window.__shortsInvoke;
        delete window.__shortsModules;
      }
    });
  } finally {
    for (const [pattern] of patches) await page.unroute(pattern);
    await page.reload();
  }
}
