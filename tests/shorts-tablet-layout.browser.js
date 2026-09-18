// 平板（粗指针 + 宽视口）下，短视频的页面层控件列是否与居中的竖屏画面同宽同 x。
//   playwright-cli -s=shorts-tablet open http://127.0.0.1:1420/ && \
//   playwright-cli -s=shorts-tablet run-code --filename=tests/shorts-tablet-layout.browser.js
//
// 平板横屏（实测 1280×800）上 9:16 画面收成居中的竖卡，而顶栏/信息与评论/换片箭头/
// 进度条如果还贴屏幕的边，就与画面隔着一大片黑，读起来像两个不相干的层。本夹具锁：
//   1. 画面比画面区窄得多时，控件列与画面框同宽同 x；
//   2. 画面铺满时（横屏源、手机竖屏），控件列退回通栏；
//   3. 桌面（细指针）不受影响 —— 那是既有设计，由 shorts-info-layout 夹具守着。
//
// 粗指针在 headless 桌面会话里默认是 false，这里用 matchMedia 覆盖复刻平板。
async (page) => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };

  await page.setViewportSize({ width: 1280, height: 800 });

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

  // 覆盖 matchMedia：把 (pointer: coarse) 报成 true，其余查询原样透传。
  await page.addInitScript(() => {
    const original = window.matchMedia;
    window.matchMedia = (query) => {
      if (query === "(pointer: coarse)") {
        return { matches: true, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
      }
      return original.call(window, query);
    };
  });

  const origin = page.url().replace(/\/[^/]*$/, "");
  await page.goto(`${origin}/shorts`);
  await page.reload();
  await page.waitForSelector('[data-slot="shorts-frame"]', { timeout: 15000 });
  await page.waitForTimeout(900);

  const read = () =>
    page.evaluate(() => {
      const active = [...document.querySelectorAll('[data-slot="shorts-panel"]')].find(
        (panel) => panel.getAttribute("aria-hidden") !== "true",
      );
      const rect = (node) => {
        if (!node) return null;
        const { x, y, width, height } = node.getBoundingClientRect();
        return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
      };
      return {
        frame: rect(active?.querySelector('[data-slot="shorts-frame"]')),
        area: rect(active?.querySelector('[data-slot="shorts-media-area"]')),
        chrome: rect(document.querySelector('[data-slot="shorts-chrome-column"]')),
        topBar: rect(document.querySelector('[data-slot="shorts-top-bar"]')),
        info: rect(document.querySelector('[data-slot="shorts-info-float"]')),
        seek: rect(document.querySelector('[data-slot="shorts-seek"]')),
        back: rect(document.querySelector('[data-slot="shorts-top-bar"] button[aria-label="返回上一页"]')),
        comment: rect(document.querySelector('button[aria-label^="评论"]')),
      };
    });

  // 找到一条竖屏源（画面比画面区窄得多），此时控件列必须与画面同宽同 x。
  let portrait = await read();
  for (let i = 0; i < 8 && !(portrait.frame && portrait.area && portrait.frame.width < portrait.area.width * 0.6); i += 1) {
    await page.evaluate(() => {
      const viewport = document.querySelector('[data-slot="shorts-viewport"]');
      const box = viewport.getBoundingClientRect();
      const make = (type, y) => new PointerEvent(type, {
        pointerId: 7, pointerType: "touch", isPrimary: true, bubbles: true, cancelable: true,
        clientX: box.left + box.width / 2, clientY: y,
      });
      const start = box.top + box.height * 0.7;
      viewport.dispatchEvent(make("pointerdown", start));
      viewport.dispatchEvent(make("pointermove", start - 120));
      viewport.dispatchEvent(make("pointermove", start - 300));
      viewport.dispatchEvent(make("pointerup", start - 420));
    });
    await page.waitForTimeout(500);
    portrait = await read();
  }

  console.log("portrait:", JSON.stringify(portrait));
  assert(portrait.frame && portrait.area, "竖屏条目应能读到画面框与画面区");
  assert(
    portrait.frame.width < portrait.area.width - 200,
    `应找到一条明显窄于画面区的竖屏画面，实测 frame=${JSON.stringify(portrait.frame)} area=${JSON.stringify(portrait.area)}`,
  );
  for (const [name, box] of [["控件列", portrait.chrome], ["顶栏", portrait.topBar], ["信息浮层", portrait.info], ["进度条", portrait.seek]]) {
    assert(box, `${name}应存在`);
    assert(
      Math.abs(box.width - portrait.frame.width) <= 2 && Math.abs(box.x - portrait.frame.x) <= 2,
      `${name}应与画面框同宽同 x，实测 ${JSON.stringify(box)}（画面 ${JSON.stringify(portrait.frame)}）`,
    );
  }
  // 返回与更多（这里只量返回）应落在画面框左沿。
  assert(
    portrait.back && Math.abs(portrait.back.x - portrait.frame.x) <= 10,
    `返回按钮应贴画面左沿，实测 ${JSON.stringify(portrait.back)}（画面 x=${portrait.frame.x}）`,
  );
  // 评论按钮应贴画面右沿。
  assert(
    portrait.comment &&
      Math.abs(portrait.comment.x + portrait.comment.width - (portrait.frame.x + portrait.frame.width)) <= 12,
    `评论按钮应贴画面右沿，实测 ${JSON.stringify(portrait.comment)}（画面右沿 ${portrait.frame.x + portrait.frame.width}）`,
  );

  return { portrait };
}
