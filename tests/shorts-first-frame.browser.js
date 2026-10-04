// 首帧生命周期回归：真实 ShortsStage + useShortsMediaPlaybackSlot + DASH 样本。
// 在 Windows 主窗口的 Vite dev 页运行：
//   playwright-cli run-code --filename=tests/shorts-first-frame.browser.js
// 不请求平台 IPC；只替换取流适配器，覆盖预热暂停、提升复用、换片遮挡与失败重试。
async (page) => {
  const origin = page.url().match(/^https?:\/\/[^/]+/)[0];
  await page.goto(`${origin}/settings`);
  return await page.evaluate(async () => {
    const { setupHarness, dependencyUrl, until, frames, assert } =
      await import("/tests/browser/harness.js");
    const { QueryClient, QueryClientProvider } = await import(
      dependencyUrl("@tanstack_react-query")
    );
    const { useShortsMediaPlaybackSlot } =
      await import("/src/features/shorts/useShortsPlayback.ts");
    const { ShortsStage } = await import("/src/features/shorts/ShortsStage.tsx");
    const harness = await setupHarness({ strict: false });
    const { h, React } = harness;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const pending = new Map();
    const source = {
      id: "first-frame-fixture",
      kind: "dash",
      key: (item) => item.id,
      canPlay: () => true,
      load: (item) =>
        new Promise((resolve, reject) => {
          pending.set(item.id, { resolve, reject });
        }),
      stop: async () => {},
      sessionId: (info) => info.id,
      url: (info) => info.url,
      duration: () => 10,
    };
    const items = ["first", "second"].map((id) => ({
      id,
      title: id,
      cover: "",
      dimension: { width: 160, height: 90, rotate: 0 },
    }));
    let state;
    let media;
    function App({ item, mode, mediaAllowed }) {
      const ref = React.useRef(null);
      state = useShortsMediaPlaybackSlot({
        source,
        item,
        videoRef: ref,
        slotId: "a",
        mode,
        mediaAllowed,
      });
      React.useLayoutEffect(() => {
        media = ref.current;
      });
      return h(
        "div",
        { className: "media-skin", style: { position: "relative", width: 360, height: 732 } },
        h(ShortsStage, {
          item,
          playback: state,
          videoRef: ref,
          mode,
          gestureActive: false,
          onSurfaceTap: state.togglePlay,
        }),
      );
    }
    const render = (item, mode = "warm", mediaAllowed = true) =>
      harness.render(h(QueryClientProvider, { client }, h(App, { item, mode, mediaAllowed })));
    const mask = () => harness.host.querySelector('[data-slot="shorts-first-frame-mask"]');
    const resolve = (item) => {
      pending.get(item.id).resolve({
        id: item.id,
        url: `${location.origin}/tests/assets/shorts-dash/out.mpd?item=${item.id}`,
      });
      pending.delete(item.id);
    };
    try {
      render(items[0]);
      await until(() => pending.has("first"), "首次取流没有开始");
      assert(!state.hasFrame && mask(), "首次取流前必须遮住原生海报");
      resolve(items[0]);
      // 预热只缓冲、不播放：暂停态下仍必须有帧回调把首帧交出来。
      await until(() => state.ready && state.hasFrame, "预热暂停时未收到真正的首帧", 15000);
      assert(media.paused && media.currentTime === 0 && !mask(), "预热帧应直接展示，不强行起播");
      assert(state.loading === false, "首帧已提交时不应仍在加载态");
      const originalMedia = media;

      render(items[0], "play");
      await until(() => media.currentTime > 0.2, "预热提升后未起播", 8000);
      assert(state.hasFrame && media === originalMedia && !mask(), "提升不应重置帧或重建媒体");
      media.dispatchEvent(new Event("waiting"));
      await frames();
      assert(state.hasFrame && !mask(), "播放中缓冲不应重新变黑");
      media.dispatchEvent(new Event("playing"));
      await frames();
      assert(state.hasFrame && !mask(), "恢复播放不应重新变黑");

      // 槽位里还留着上一条真实视频帧，但新条目的地址尚未返回。
      render(items[1], "warm", false);
      assert(!state.hasFrame && mask(), "换条目必须在首次提交时立刻遮住旧帧");
      await until(() => pending.has("second"), "新条目没有开始取流");
      assert(media === originalMedia && media.readyState >= 2, "夹具未保留可见的旧媒体帧");
      pending.get("second").reject(new Error("首帧测试取流失败"));
      pending.delete("second");
      await until(() => !!state.error, "取流失败未反映到槽位");
      assert(!state.hasFrame && mask(), "取流失败不能露出旧帧");
      state.retry();
      await until(() => pending.has("second"), "重试没有重新取流");
      resolve(items[1]);
      render(items[1], "warm", true);
      // 旧媒体在换源前就排队的帧事件不能直接撤掉黑底（源还没换到新地址）。
      media.dispatchEvent(new Event("loadeddata"));
      media.dispatchEvent(new Event("canplay"));
      await frames();
      assert(!state.hasFrame && mask(), "旧源的迟到帧事件不能当作新条目的首帧");
      await until(() => state.ready && state.hasFrame, "重试换源未收到新帧", 15000);
      assert(media === originalMedia && !mask(), "新帧到达后应移除黑底并继续复用槽位");
      return {
        passed: true,
        warmFrame: true,
        promotionKeptFrame: true,
        staleFrameMasked: true,
        retryRecovered: true,
      };
    } finally {
      harness.dispose();
      client.clear();
    }
  });
}
