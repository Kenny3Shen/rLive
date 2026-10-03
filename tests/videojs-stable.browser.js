// Windows 主窗口 CDP：验证真实 HLS + Rust 代理、软切源、稳定版 PiP API 与清理。
// playwright-cli -s=rwin run-code --filename=tests/videojs-stable.browser.js
// 使用官方公开演示源；不代表所有平台 CDN 或 Android WebView 均已验收。
async (page) => {
  return await page.evaluate(async () => {
    const { setupHarness, assert, until, frames } = await import("/tests/browser/harness.js");
    const { invokeCmd } = await import("/src/shared/api/tauri.ts");
    const { createVideoJsPlayer, loadVideoJsModules } =
      await import("/src/features/room/player/videoJsPlayer.ts");
    const { requestPlayerAutoplay } = await import("/src/features/room/player/autoplay.ts");
    const { VideoJsPlayerProvider, VideoJsContainer, VideoJsVideo, useVideoJsPiP, useVideoJsPlayer } =
      await import("/src/features/room/player/videoJsControls.tsx");

    assert(window.__TAURI_INTERNALS__, "必须在 Tauri 主窗口运行");
    const ui = await setupHarness({
      style: "position:fixed;inset:40px auto auto 40px;width:480px;height:270px;z-index:9999",
    });
    const { h, createRef } = ui;
    const ref = createRef();
    let pip;
    let paused;
    let player;
    let current = true;
    const sessionId = `videojs-stable-test:${crypto.randomUUID()}`;
    const source = "https://stream.mux.com/BV3YZtogl89mg9VcNBhhnHm02Y34zI1nlMuMQfAbl3dM.m3u8";
    const passed = [];
    const errors = [];
    const onUnhandled = (event) => errors.push(String(event.reason));
    window.addEventListener("unhandledrejection", onUnhandled);

    function Probe() {
      pip = useVideoJsPiP();
      paused = useVideoJsPlayer((state) => state.paused);
      return null;
    }

    try {
      ui.render(h(VideoJsPlayerProvider, null,
        h(VideoJsContainer, { controls: null, style: { width: "100%", height: "100%" } },
          h(VideoJsVideo, { ref, muted: true, playsInline: true, style: { width: "100%", height: "100%" } }),
          h(Probe),
        ),
      ));
      await frames();
      const media = ref.current;
      assert(media, "StrictMode 后媒体仍应挂载");
      const proxy = () => invokeCmd("stream_proxy_start", {
        sessionId, url: source, headers: {}, hls: true,
      });
      const local = await proxy();
      player = createVideoJsPlayer(await loadVideoJsModules("hls"), {
        video: media, kind: "hls", isLive: false, url: local,
        hls: { maxBufferLength: 10, backBufferLength: 5 },
      });
      requestPlayerAutoplay(player, media, () => current);
      await until(() => media.currentTime > 0.2 && media.videoWidth > 0 && !media.paused,
        "官方 HLS 演示源未出帧", 25_000);
      assert(player.getHlsCore()?.isMse(), "应使用真实 hls.js MSE 引擎");
      assert(paused === false, "React store 应反映播放状态");
      passed.push("StrictMode 下真实 HLS 经 Rust 代理出帧，store 与媒体一致");

      player.pause();
      await until(() => paused === true, "暂停状态未同步");
      const next = await proxy();
      await player.switchSource(`${next}?switch=stable`, "hls");
      assert(media.paused, "暂停期间软切源不能擅自恢复播放");
      assert(ref.current === media, "软切源应复用媒体节点");
      await player.play();
      await until(() => !media.paused && media.currentTime > 0.2, "切源后未继续播放", 15_000);
      passed.push("真实 HLS 软切源复用媒体，保留暂停意图并可恢复播放");

      await until(() => pip?.pictureInPictureAvailability === "available", "PiP 未就绪");
      assert(pip.isPictureInPicture === false, "稳定版 PiP 状态字段不正确");
      const originalRequest = media.requestPictureInPicture;
      let rejected = false;
      media.requestPictureInPicture = () => {
        rejected = true;
        return Promise.reject(new DOMException("测试浏览器策略拒绝", "NotAllowedError"));
      };
      try {
        await pip.requestPictureInPicture();
        assert(rejected, "应调用媒体 PiP API");
        assert(!media.paused, "PiP 失败不能打断播放");
      } finally {
        media.requestPictureInPicture = originalRequest;
      }
      await frames();
      assert(errors.length === 0, `不应产生未处理拒绝：${errors.join(", ")}`);
      passed.push("稳定版 PiP 状态可订阅，策略拒绝被捕获且不打断播放");
      return { passed, dimensions: [media.videoWidth, media.videoHeight] };
    } finally {
      current = false;
      player?.destroy();
      player?.destroy();
      const media = ref.current;
      ui.dispose();
      await invokeCmd("stream_proxy_stop", { sessionId });
      window.removeEventListener("unhandledrejection", onUnhandled);
      assert(!media || (media.paused && !media.getAttribute("src")), "销毁必须暂停并释放媒体源");
    }
  });
}
