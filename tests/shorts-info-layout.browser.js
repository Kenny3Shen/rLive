// 在 Vite 预览页测量短视频页画面底部浮层的位置与显隐（IPC 为本地桩）：
// playwright-cli -s=shorts-layout run-code --filename=tests/shorts-info-layout.browser.js
//
// 验证三件事：
//   1. 信息贴播放器左下角、评论按钮贴右下角（改前两者收在居中的 512px 容器里）；
//   3. 点「隐藏视频信息」时评论按钮一起消失；
//   4. 底部控制行三个按钮的图标尺寸（改前 16px，现 20px）。
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
  await page.goto(`${origin}/shorts`);
  await page.reload();
  await page.waitForSelector('[data-slot="shorts-info-float"]', { timeout: 15000 });
  await settle(800);

  const measure = () =>
    page.evaluate(() => {
      const float = document.querySelector('[data-slot="shorts-info-float"]');
      const avatar = float?.querySelector("img, span[class*='rounded-full']");
      const infoBlock = float?.firstElementChild;
      const comment = [...(float?.querySelectorAll("button") ?? [])].find((b) =>
        (b.getAttribute("aria-label") ?? "").startsWith("评论"),
      );
      const viewport = document.querySelector('[data-slot="shorts-viewport"]');
      const bottomBar = document.querySelector('[data-slot="shorts-bottom-bar"]');
      const controlRow = bottomBar?.querySelector(".max-w-lg") ?? bottomBar;
      const controlButtons = [...(controlRow?.querySelectorAll("button") ?? [])].filter(
        (b) => b.className.includes("size-10"),
      );
      const rect = (node) => {
        if (!node) return null;
        const { x, y, width, height } = node.getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        viewport: rect(viewport),
        float: rect(float),
        infoBlock: rect(infoBlock),
        comment: rect(comment),
        seek: rect(document.querySelector('[data-slot="shorts-seek"]')),
        controlRow: rect(controlRow),
        iconSizes: controlButtons.map((button) => {
          const svg = button.querySelector("svg");
          const box = svg?.getBoundingClientRect();
          return box ? Math.round(box.width) : null;
        }),
        commentButtonCount: comment ? 1 : 0,
      };
    });

  const report = {};
  report.desktop = await measure();

  /* ---------- 1. 左下角 / 右下角 ---------- */
  const d = report.desktop;
  assert(d.infoBlock && d.comment, "桌面：信息块与评论按钮都应存在");
  // 左边缘贴住播放器左侧（`px-2` = 8px）。
  assert(
    Math.abs(d.infoBlock.x - d.viewport.x - 8) < 2,
    `信息块应贴播放器左下角，实测 x=${d.infoBlock.x}（视口 ${d.viewport.x}）`,
  );
  // 右边缘贴住播放器右侧。
  const commentRight = d.comment.x + d.comment.width;
  const viewportRight = d.viewport.x + d.viewport.width;
  assert(
    Math.abs(viewportRight - commentRight - 8) < 2,
    `评论按钮应贴播放器右下角，实测右边距 ${viewportRight - commentRight}`,
  );
  // 信息在最左、评论在最右 —— 两者之间必须拉开，而不是挤在中间的一条。
  assert(
    d.comment.x - (d.infoBlock.x + d.infoBlock.width) > 100,
    "信息块与评论按钮应分居两侧，实测间距太小",
  );

  /* ---------- 4. 底栏图标 20px ---------- */
  assert(
    d.iconSizes.length === 3,
    `底栏应有 3 个开关按钮，实测 ${d.iconSizes.length}`,
  );
  assert(
    d.iconSizes.every((size) => size === 20),
    `底栏图标应为 20px，实测 ${d.iconSizes.join("/")}`,
  );

  /* ---------- 3. 隐藏信息时评论按钮一起消失 ---------- */
  await page.click('button[aria-label="隐藏视频信息与评论按钮"]');
  await settle(400);
  const hidden = await measure();
  report.hidden = hidden;
  assert(hidden.float === null, "隐藏后整块浮层（含渐变垫底）都应消失");
  assert(hidden.commentButtonCount === 0, "隐藏后评论按钮不应还在");
  assert(
    hidden.comment === null,
    "隐藏后评论按钮应一起消失（改前它会留在右下角）",
  );

  // 再点一次要能恢复。
  await page.click('button[aria-label="显示视频信息与评论按钮"]');
  await settle(400);
  const restored = await measure();
  report.restored = restored;
  assert(restored.commentButtonCount === 1 && restored.float, "再次点击应恢复信息与评论按钮");

  return report;
}
