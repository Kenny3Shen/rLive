// 换片过渡必须是连续动画，而不是硬切。
// playwright-cli -s=shorts-settle run-code --filename=tests/shorts-settle-continuity.browser.js
//
// 回归的真 bug：视口高度 `ResizeObserver` 每次换片都重建、且把「已应用高度」从 0 起算，
// 它的首次回调被当成真实的高度变化，刚好取消掉刚启动的收尾动画 —— 观感就是
// 「先瞬间跳过去、再滑一下」（硬切 + 补滑）。这里按一次 ↓ 并逐帧采样条带位移：
// 必须读到中途帧（硬切只会读到起点与终点），且终点停在下一屏。
//
// 注意：本夹具刻意只做「采样」这一件事，不混入点击隐藏/显示信息浮层的步骤。
// 实测（在干净 HEAD 上同样复现）点过信息开关之后再跑任何含 `await` 的 `page.evaluate`
// 都会让渲染进程空转、`page.evaluate` 永久挂起；把采样单独拆出来可稳定通过。
async (page) => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const settle = (ms = 500) => page.waitForTimeout(ms);

  await page.addInitScript(() => {
    // `isTauri()` 读 `window.isTauri`；缺了它 `invokeCmd` 会直接抛「未连接客户端」。
    window.isTauri = true;
    let nextCallback = 1;
    const storyItems = [
      {
        bvid: "BV1a",
        aid: "1",
        cid: 41_855_094_127,
        title: "竖屏第一条：这是一条比较长的标题用来观察折行与最大宽度",
        cover: "http://i0.hdslb.com/bfs/storyff/a.jpg",
        author: "测试 UP 主",
        author_face: null,
        author_fans: 11389,
        duration: 93,
        view: 187_172,
        danmaku: 24,
        pubdate: 1_789_292_152,
        rcmd_reason: null,
        dimension: { width: 1080, height: 1920, rotate: 0 },
      },
      {
        bvid: "BV1b",
        aid: "2",
        cid: 41_855_094_128,
        title: "竖屏第二条",
        cover: "http://i0.hdslb.com/bfs/storyff/b.jpg",
        author: "另一个 UP",
        author_face: null,
        author_fans: 520,
        duration: 61,
        view: 1024,
        danmaku: 3,
        pubdate: 1_789_292_200,
        rcmd_reason: null,
        dimension: { width: 1080, height: 1920, rotate: 0 },
      },
    ];
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => nextCallback++,
      unregisterCallback: () => {},
      invoke: async (command) => {
        (window.__calls ??= []).push(command);
        if (command === "settings_get") {
          // 首屏会先读设置；返回 null 会让整页停在「无法读取当前设置」。
          return {
            has_saved_settings: true,
            settings: {
              theme: "system",
              legacy_player_skin: null,
              default_site: "bilibili",
              disabled_site_ids: [],
              proxy: null,
              danmaku_opacity: 0.8,
              danmaku_font_stroke: 0.0,
              danmaku_font_size: 20,
              danmaku_speed: 100,
              danmaku_area: 0.25,
              danmaku_filter_gifts: true,
              danmaku_merge_window_seconds: 10,
              super_chat_enabled: true,
              danmaku_shield_words: [],
              danmaku_blocked_users: [],
              quality_level: "high",
              playback_soft_switch_enabled: true,
              room_card_preview_enabled: true,
              dynamic_background_enabled: true,
              danmaku_send_enabled: false,
              asr_enabled: false,
              asr_provider: "auto",
              asr_vad_enabled: true,
              asr_punctuation_enabled: true,
              asr_speaker_diarization_enabled: false,
              asr_hotwords: [],
              asr_window_seconds: 0.2,
              asr_font_size: 20,
              asr_translation_enabled: false,
              asr_translation_from: "auto",
              asr_translation_to: "zh-CN",
              iptv_custom_m3u_url: null,
              legacy_recording_continue_after_leave: false,
              recording_include_danmaku: true,
              recording_auto_split_minutes: 0,
              recording_max_concurrent: 2,
              ffmpeg_rw_timeout_seconds: 10,
              ffmpeg_reconnect_delay_max_seconds: 8,
              ffmpeg_hls_segment_retry_count: 5,
              recording_ass: {
                resolution_width: 1920,
                resolution_height: 1080,
                font_name: "Microsoft YaHei",
                font_size: 36,
                opacity_percent: 80,
                outline: 2.0,
                shadow: 0.0,
                bold: false,
                scroll_duration_seconds: 12,
                display_area_percent: 25,
                overflow_policy: "delay",
                max_delay_seconds: 5,
                merge_window_seconds: 10,
                filter_gifts: true,
                show_super_chat: true,
                shield_rules: [],
                shield_regex: false,
              },
            },
          };
        }
        if (command === "video_get_story") return { has_more: true, items: storyItems };
        if (command === "video_get_comments") {
          return { items: [], has_more: false, next: 0, all_count: 0 };
        }
        if (command === "video_get_archive") {
          return {
            bvid: "BV1a",
            title: "竖屏第一条",
            desc: "简介",
            tags: [],
            author: "测试 UP 主",
            author_face: null,
            author_fans: 11389,
            author_videos: 12,
            view: 1,
            danmaku: 1,
            pubdate: 1,
          };
        }
        if (command === "video_get_danmaku") {
          return { segment_index: 0, entries: [] };
        }
        if (command === "danmaku_favorite_list" || command === "danmaku_send_history_list") return [];
        if (command === "video_get_play_info") throw "测试环境不取流";
        return null;
      },
    };
  });
  // 端口不写死：用已打开页面（Vite 预览页）的 origin。
  const origin = page.url().replace(/\/[^/]*$/, "");
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${origin}/shorts`);
  await page.reload();
  await page.waitForSelector('[data-slot="shorts-track"]', { timeout: 15000 });
  await settle(800);

  const viewportHeight = await page.evaluate(
    () => document.querySelector('[data-slot="shorts-viewport"]').getBoundingClientRect().height,
  );

  const offsets = await page.evaluate(async () => {
    const track = document.querySelector('[data-slot="shorts-track"]');
    const read = () => {
      const computed = getComputedStyle(track).transform;
      if (!computed || computed === "none") return 0;
      try {
        return new DOMMatrixReadOnly(computed).m42;
      } catch {
        return 0;
      }
    };
    const frames = [];
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    for (let i = 0; i < 25; i++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      frames.push(read());
    }
    return frames;
  });

  const report = { viewportHeight, frames: offsets.map((value) => Math.round(value)) };
  const mid = offsets.filter((value) => value < -1 && value > offsets.at(-1) + 1);
  assert(mid.length >= 1, `换片应读作连续动画（存在中途帧），实测轨迹 ${JSON.stringify(report.frames)}`);
  const end = offsets.at(-1);
  assert(
    end < -1 && Math.abs(end + viewportHeight) < 2,
    `换片应停在下一屏，实测终点 ${end}（视口高 ${viewportHeight}）`,
  );
  return report;
}
