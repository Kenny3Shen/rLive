// 短视频槽位提升回归（Windows 主窗口或其他 Vite dev 页）：
//   bun run dev 后
//   playwright-cli run-code --filename=tests/shorts-promotion-buffer.browser.js
//
// 场景：预热槽位缓冲到 `canplay` 后闸门置 `paused`（禁新增分片调度），随后被提升为
// 活动槽位。dash.js 的 `scheduleWhilePaused: false` 在 `ScheduleController._schedule`
// 里**清掉调度定时器**并直接返回；把该设置改回 `true` 只是改一个值，定时器不会重建，
// 而唯一自愈路径（`PLAYBACK_STARTED` 且该设置为假）不覆盖「解除闸门时媒体仍暂停」的
// 短视频序列。少了显式补调度，媒体播完已缓冲的约 2 秒就永久停在 `waiting`：
// `buffered` 停在首片、`readyState` 掉回 2、`currentTime` 不再前进。
//
// 走真实 `useShortsPlaybackSlot`（含取流 → 附着 → 闸门 → 提升），只桩 IPC 与媒体源：
// 取流返回 `tests/assets/shorts-dash/out.mpd`（ffmpeg 生成的 10 秒 fMP4 DASH，
// 5 个 2 秒分片，无音轨）。夹具必须由本项目 Vite 服务提供（`/tests/assets/...`），
// 否则适配器会撞上跨域与 MIME 问题。样本重生成：
//   ffmpeg -f lavfi -i "testsrc2=size=160x90:rate=10:duration=10" -c:v libx264 \
//     -preset ultrafast -crf 40 -g 20 -keyint_min 20 -sc_threshold 0 -pix_fmt yuv420p \
//     -an -f dash -seg_duration 2 -use_template 0 -use_timeline 0 \
//     -init_seg_name 'init-$RepresentationID$.m4s' \
//     -media_seg_name 'chunk-$RepresentationID$-$Number%05d$.m4s' \
//     tests/assets/shorts-dash/out.mpd
async (page) => {
  const origin = page.url().match(/^https?:\/\/[^/]+/)[0];
  const tauri = "**/src/shared/api/tauri.ts*";
  const tauriPath = "/src/shared/api/tauri.ts";
  const signature = "async function invokeCmd(cmd, args) {";
  const mpd = `${origin}/tests/assets/shorts-dash/out.mpd`;

  await page.unroute(tauri);
  await page.goto(`${origin}/settings`);
  const source = await page.evaluate(async (path) => (await fetch(path)).text(), tauriPath);
  if (!source.includes(signature)) throw new Error(`测试注入点已改变：${tauriPath}`);
  await page.route(tauri, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: source.replace(
        signature,
        `${signature}\nif (window.__shortsPromoteInvoke) return window.__shortsPromoteInvoke(cmd, args);`,
      ),
    }),
  );
  await page.reload();
  try {
    return await page.evaluate(
      async (playUrl) => {
        window.__shortsPromoteInvoke = async (cmd) => {
          if (cmd === "video_get_play_info") {
            return {
              mpd_url: playUrl,
              video_url: "",
              audio_url: "",
              duration: 10,
              quality: 80,
              quality_label: "测试",
              codecs: "avc1",
              accept_quality: [],
              audio_only: false,
              session_ids: { video: "p-v", audio: "p-a", mpd: "p-m" },
            };
          }
          if (cmd === "video_stop_play" || cmd === "video_history_add") return;
          throw new Error(`未预期的命令 ${cmd}`);
        };
        const { setupHarness, until, dependencyUrl, assert } =
          await import("/tests/browser/harness.js");
        const harness = await setupHarness();
        const mod = await import("/src/features/shorts/useShortsPlayback.ts");
        const { QueryClient, QueryClientProvider } = await import(
          dependencyUrl("@tanstack_react-query")
        );
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const { h, React } = harness;
        let state;
        let media;
        const ITEM = {
          bvid: "BVprobe",
          cid: 9001,
          aid: "9001",
          title: "槽位提升回归",
          cover: "",
          author: "测试",
          duration: 10,
          view: 0,
          danmaku: 0,
          pubdate: 0,
        };
        function App({ mode }) {
          const ref = React.useRef(null);
          state = mod.useShortsPlaybackSlot({
            item: ITEM,
            slotId: "a",
            videoRef: ref,
            mode,
            mediaAllowed: true,
          });
          return h("video", {
            ref: (node) => {
              ref.current = node;
              if (node) media = node;
            },
            muted: true,
            playsInline: true,
          });
        }
        try {
          const render = (mode) =>
            harness.render(h(QueryClientProvider, { client }, h(App, { mode })));
          render("warm");
          await until(() => !!media, "媒体未挂载");
          // 与 `useShortsSlots` 的 `onReady` 同源：预热到位即禁调度。
          await until(() => state.ready, "预热未到 canplay", 15000);
          await new Promise((resolve) => setTimeout(resolve, 1200));
          const warmEnd = media.buffered.length ? media.buffered.end(0) : 0;
          assert(warmEnd > 0, "预热没有缓冲任何分片");
          assert(media.paused, "预热槽位不应开始播放");

          render("play");
          await until(() => media.currentTime > 0.3, "提升后未起播", 8000);
          await new Promise((resolve) => setTimeout(resolve, 5000));
          const finalEnd = media.buffered.length
            ? media.buffered.end(media.buffered.length - 1)
            : 0;
          assert(state.error === null, `提升后出现错误：${state.error}`);
          assert(media.currentTime > warmEnd + 0.5, "提升后没有播过预热缓冲的边界");
          assert(finalEnd > warmEnd + 1, `第二分片未续上：buffered 停在 ${warmEnd}s`);
          assert(media.readyState >= 3, `媒体停在等待状态：readyState=${media.readyState}`);
          return {
            passed: true,
            warmEnd,
            currentTime: Number(media.currentTime.toFixed(2)),
            finalEnd,
          };
        } finally {
          harness.dispose();
          client.clear();
          delete window.__shortsPromoteInvoke;
        }
      },
      mpd,
    );
  } finally {
    await page.unroute(tauri);
    await page.reload();
  }
}
