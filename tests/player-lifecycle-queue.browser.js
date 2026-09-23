// P-02：在真实 React hook 与 VideoJsPlayer 包装层上验证实例级队列。
// 仅代理 IPC 与 HLS 引擎使用可控桩，不访问账号、CDN，也不验证媒体解码。
// Windows 主窗口：playwright-cli -s=rwin run-code --filename=tests/player-lifecycle-queue.browser.js
async (page) => {
  const ipcPattern = "**/src/shared/api/tauri.ts*";
  const playerPattern = "**/src/features/room/player/videoJsPlayer.ts*";
  const originalUrl = page.url();
  const origin = originalUrl.match(/^https?:\/\/[^/]+/)[0];
  const sources = await page.evaluate(async () => {
    return Promise.all([
      fetch("/src/shared/api/tauri.ts").then((response) => response.text()),
      fetch("/src/features/room/player/videoJsPlayer.ts").then((response) => response.text()),
    ]);
  });
  const inject = (source, signature, code) => {
    if (!source.includes(signature)) throw new Error(`生命周期夹具注入点已改变：${signature}`);
    return source.replace(signature, `${signature}\n${code}`);
  };
  await page.route(ipcPattern, (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: inject(
        sources[0],
        "async function invokeCmd(cmd, args) {",
        'if (window.__lifecycleQueue && cmd.startsWith("stream_proxy_")) return window.__lifecycleQueue.invoke(cmd, args);',
      ),
    }),
  );
  await page.route(playerPattern, (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: inject(
        sources[1],
        "async function loadVideoJsModules(kind) {",
        'if (window.__lifecycleQueue && kind === "hls") return { HlsJsAdapter: window.__lifecycleQueue.Adapter };',
      ),
    }),
  );

  try {
    await page.goto(`${origin}/settings`);
    await page.waitForFunction(() =>
      performance
        .getEntriesByType("resource")
        .some((entry) => new URL(entry.name).pathname.endsWith("/deps/react-dom_client.js")),
    );
    return await page.evaluate(async () => {
      const { setupHarness, until, frames, assert } = await import("/tests/browser/harness.js");
      const { useMediaLifecycle, LIVE_MEDIA_LIFECYCLE_PROFILE } =
        await import("/src/features/room/player/useWebPlayer.ts");
      const { useSettingsStore } = await import("/src/shared/stores/settingsStore.ts");
      const ui = await setupHarness(); // StrictMode 双 effect，同一实例的队列仍须稳定。
      const { React, h } = ui;
      const previousSoftSwitch = useSettingsStore.getState().playbackSoftSwitchEnabled;
      useSettingsStore.setState({ playbackSoftSwitchEnabled: true });
      const calls = [];
      const adapters = [];
      const proxies = new Map();
      const active = new Map();
      const ownerBySession = new Map();
      const gates = new Map();
      const apis = new Map();
      const mediaState = new WeakMap();
      const profile = { ...LIVE_MEDIA_LIFECYCLE_PROFILE, telemetry: false };
      const passed = [];
      const timings = {};
      let model = [];

      const source = (id, version) => ({
        url: `https://lifecycle.invalid/${id}/${version}.m3u8`,
        headers: {},
        source_id: `${id}:${version}`,
        label: "本地生命周期夹具",
        protocol: "hls",
        priority: 0,
      });
      const log = (type, details) => calls.push({ type, at: performance.now(), ...details });
      const starts = (id, version) =>
        calls.filter(
          (call) =>
            call.type === "start" && call.id === id && (!version || call.version === version),
        );
      const pauseIpc = (id, version) => {
        let resolve;
        const promise = new Promise((done) => {
          resolve = done;
        });
        const gate = { promise, resolve };
        gates.set(`${id}/${version}`, gate);
        return gate;
      };
      const invoke = async (cmd, args) => {
        if (cmd === "stream_proxy_start") {
          const [, id, file] = new URL(args.url).pathname.split("/");
          const version = file.replace(/\.m3u8$/, "");
          const session = args.sessionId;
          assert(
            !ownerBySession.has(session) || ownerBySession.get(session) === id,
            "代理 session 被另一实例接管",
          );
          ownerBySession.set(session, id);
          log("start", { id, version, session });
          await gates.get(`${id}/${version}`)?.promise;
          const url = `${location.origin}/__lifecycle_proxy/${proxies.size}`;
          proxies.set(url, { id, version, session });
          active.set(session, id);
          log("proxy-ready", { id, version, session });
          return url;
        }
        if (cmd === "stream_proxy_stop") {
          active.delete(args.sessionId);
          log("stop", { session: args.sessionId });
          return;
        }
        if (cmd === "stream_proxy_telemetry") return null;
        throw new Error(`未预期的代理命令：${cmd}`);
      };
      const ready = (adapter) => {
        if (adapter.destroyed) return;
        mediaState.get(adapter.media).ready = true;
        log("readied", adapter.info);
        adapter.media.dispatchEvent(new Event("canplay"));
      };
      class Adapter extends EventTarget {
        constructor() {
          super();
          this.destroyed = false;
          adapters.push(this);
        }
        attach(media) {
          this.media = media;
        }
        set source(value) {
          this.src = value.src;
        }
        set src(value) {
          const url = new URL(value);
          const info = proxies.get(`${url.origin}${url.pathname}`);
          assert(info, "适配器必须使用本实例代理 URL");
          this.info = info;
          mediaState.get(this.media).ready = false;
          log("adapter-source", info);
          this.media.dispatchEvent(new Event("loadstart"));
          if (!info.version.startsWith("stall")) queueMicrotask(() => ready(this));
        }
        destroy() {
          this.destroyed = true;
        }
      }
      window.__lifecycleQueue = { invoke, Adapter };

      function Player({ id, version, reload }) {
        const api = useMediaLifecycle({
          playUrl: source(id, version),
          sessionKey: id,
          reloadToken: reload,
          fullscreenOwner: false,
          initialMuted: true,
          profile,
        });
        apis.set(id, api);
        const attach = React.useCallback(
          (node) => {
            api.videoRef.current = node;
            if (!node) return;
            const state = { ready: false, paused: true };
            mediaState.set(node, state);
            Object.defineProperties(node, {
              readyState: { configurable: true, get: () => (state.ready ? 4 : 0) },
              paused: { configurable: true, get: () => state.paused },
              load: { configurable: true, value() {} },
              play: {
                configurable: true,
                value() {
                  state.paused = false;
                  node.dispatchEvent(new Event("play"));
                  if (state.ready) node.dispatchEvent(new Event("playing"));
                  return Promise.resolve();
                },
              },
              pause: {
                configurable: true,
                value() {
                  state.paused = true;
                  node.dispatchEvent(new Event("pause"));
                },
              },
            });
          },
          [api.videoRef],
        );
        return h("video", { key: api.mediaKey, ref: attach, "data-player": id });
      }
      const render = () =>
        ui.render(
          h(React.Fragment, null, ...model.map((item) => h(Player, { ...item, key: item.id }))),
        );
      const change = (id, version) => {
        model = model.map((item) => (item.id === id ? { ...item, version } : item));
        render();
      };
      const remove = (id) => {
        model = model.filter((item) => item.id !== id);
        render();
      };
      const currentAdapter = (id) =>
        adapters.findLast((adapter) => !adapter.destroyed && adapter.info?.id === id);
      const hasSource = (id, version) => currentAdapter(id)?.info.version === version;
      const idle = () => apis.size > 0 && model.every((item) => apis.get(item.id)?.mediaAvailable);
      const deadlineMs = 2000; // 仅控制流截止时间，远小于真实软切换的 12s 预算。
      try {
        // 一路代理 IPC 未返回，另外五路必须独立开始；同时检验 StrictMode 不重复开流。
        const blocked = pauseIpc("a", "initial");
        model = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id, version: "initial", reload: 0 }));
        render();
        await until(() => starts("a").length === 1, "A 未开始受控 IPC");
        const blockedAt = starts("a")[0].at;
        await until(
          () => model.slice(1).every(({ id }) => hasSource(id, "initial")),
          "A 的挂起 IPC 阻塞了其他播放器启动",
          deadlineMs,
        );
        timings.fiveAdaptersWhileABlockedMs = Math.round(performance.now() - blockedAt);
        assert(active.size === 5, "尚未返回的 A 不应登记为活动代理");
        assert(
          model.every(({ id }) => starts(id).length === 1),
          "StrictMode 或重渲染重复创建代理",
        );
        assert(
          new Set(calls.filter((call) => call.type === "start").map((call) => call.session))
            .size === 6,
          "六路代理 session 不独立",
        );
        passed.push("六路同时启动：一路 IPC 挂起不阻塞其他五路，StrictMode 下 session 独立");

        // 同实例发生硬重建仍须排在旧 start/stop 后，不能每次 render 换一个队列。
        const oldSession = starts("a")[0].session;
        model = model.map((item) => (item.id === "a" ? { ...item, reload: 1 } : item));
        render();
        await frames();
        assert(starts("a").length === 1, "同实例重渲染绕过了旧队列");
        blocked.resolve();
        await until(() => hasSource("a", "initial") && idle(), "迟到启动清理后未能重建 A");
        assert(starts("a").length === 2, "硬重建应只创建一个新 generation");
        assert(
          !adapters.some((adapter) => adapter.info?.session === oldSession),
          "迟到 generation 挂载了旧媒体",
        );
        const stopOld = calls.findIndex(
          (call) => call.type === "stop" && call.session === oldSession,
        );
        const newStart = calls.findIndex(
          (call) => call.type === "start" && call.session === starts("a")[1].session,
        );
        assert(stopOld >= 0 && stopOld < newStart, "旧代理未先清理就启动新 generation");
        assert(!active.has(oldSession), "旧 generation 代理泄漏");
        passed.push("队列跨重渲染保持稳定：迟到 generation 清理后再启动，不挂载旧媒体");

        // 真实 VideoJsPlayer.switchSource 挂起在 canplay，B 停止、G 启动和 C 切源仍可完成。
        const aMedia = apis.get("a").videoRef.current;
        const cMedia = apis.get("c").videoRef.current;
        change("a", "stall-switch");
        await until(() => hasSource("a", "stall-switch"), "A 未进入软切换等待");
        const stallAt = performance.now();
        const bSession = starts("b")[0].session;
        remove("b");
        model.push({ id: "g", version: "initial", reload: 0 });
        render();
        change("c", "second");
        await until(
          () => !active.has(bSession) && hasSource("g", "initial") && hasSource("c", "second"),
          "A 等待 canplay 阻塞了 B 停止、G 启动或 C 切源",
          deadlineMs,
        );
        assert(!mediaState.get(aMedia).ready, "A 应仍未 canplay，不能靠解除阻塞让测试通过");
        assert(apis.get("c").videoRef.current === cMedia, "C 的同协议切源意外硬重建");
        timings.otherLifecyclesWhileAWaitsMs = Math.round(performance.now() - stallAt);
        passed.push("A 不产生 canplay 时，B 停止、G 启动、C 软切换均不等待其 12s 超时");

        // 同实例的后续切源不再等前一次的 canplay；取消项不得发出 IPC。
        // 两次 change 中间不让微任务落地，第一次入队后就被取代。
        change("a", "superseded");
        change("a", "latest");
        await until(
          () => hasSource("a", "latest"),
          "同实例的新切源仍在等待前一次 canplay",
          deadlineMs,
        );
        // 结构证据：被阻塞的那次切源从未就绪，而它的 12s 预算远未到期。
        assert(
          !calls.some((call) => call.type === "readied" && call.version === "stall-switch"),
          "被阻塞的切源意外就绪，本用例不再能证明未等待",
        );
        assert(starts("a", "superseded").length === 0, "已取消的排队切源仍发出 IPC");
        assert(apis.get("a").videoRef.current === aMedia, "连续同协议切换丢失媒体所有权");
        assert(
          starts("a").every(
            (call, index) => index === 0 || call.session === starts("a")[1].session,
          ),
          "软切换意外创建新 generation",
        );
        ready(currentAdapter("a"));
        await frames();
        assert(apis.get("a").loadError === null, "切源就绪后仍留错误态");
        assert(apis.get("a").videoRef.current === aMedia, "切源提交后发生了硬回退");
        passed.push("连续切源不等前一次 canplay，跳过取消项并复用原媒体和 session");

        // 硬重建同样不得被未完成的 canplay 等待拖住。
        change("a", "stall-rebuild");
        await until(() => hasSource("a", "stall-rebuild"), "未进入受控等待");
        const beforeRebuild = starts("a").length;
        model = model.map((item) => (item.id === "a" ? { ...item, reload: 2 } : item));
        render();
        await until(
          () => starts("a").length > beforeRebuild && apis.get("a").videoRef.current !== aMedia,
          "硬重建被未完成的 canplay 等待阻塞",
          deadlineMs,
        );
        assert(
          !calls.some((call) => call.type === "readied" && call.version === "stall-rebuild"),
          "被阻塞的切源意外就绪",
        );
        passed.push("硬重建不等待上一次未完成的软切换，并重建媒体节点");

        change("a", "stall-exit");
        await until(() => hasSource("a", "stall-exit"), "退出前未进入受控等待");
        ui.dispose();
        await until(
          () => active.size === 0 && adapters.every((adapter) => adapter.destroyed),
          "退出后代理或适配器未清零",
          deadlineMs,
        );
        passed.push("等待中退出：真实包装层取消 canplay 等待，代理和适配器全部释放");
        return {
          passed,
          timings,
          starts: calls.filter((call) => call.type === "start").length,
          sessions: ownerBySession.size,
          active: active.size,
          liveAdapters: adapters.filter((adapter) => !adapter.destroyed).length,
          note: "耗时只属于受控 IPC/引擎桩，不是媒体首帧或实际提速指标",
        };
      } finally {
        ui.dispose();
        for (const gate of gates.values()) gate.resolve();
        // 放行迟到 IPC 后先让其取消/清理微任务落地，不能在 active 暂为空时提前撤桩。
        await frames();
        await until(() => active.size === 0, "夹具清理后仍有代理", 5000);
        delete window.__lifecycleQueue;
        useSettingsStore.setState({ playbackSoftSwitchEnabled: previousSoftSwitch });
      }
    });
  } finally {
    await page.unroute(ipcPattern);
    await page.unroute(playerPattern);
    await page.goto(originalUrl);
  }
}
