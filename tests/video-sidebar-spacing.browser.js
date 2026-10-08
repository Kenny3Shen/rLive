// 播放页侧栏「相关视频」页签里的卡片间距契约。
//
// 这一栏里并排着三种卡片：UP 主信息卡、选集 / 合集 / 分集卡、相关视频行卡。
// 它们曾各自带一套外边距，于是同一栏里出现三种缝宽与两种左右内缩：
//
//   信息卡 → 选集卡   16px（`py-2` + `pt-2`）
//   选集卡 → 相关视频  6px（`pt-1.5`）
//   相关视频卡之间     4px（`gap-1`）
//   信息卡 / 选集卡内缩 10px（`px-2.5`），相关视频 12px（`px-3`）
//
// 现在由卡片列（`SidebarCardStack`）统一给缝宽与内缩：横向一律 12px、纵向一律 8px，
// 页签栏到第一张卡的距离也取同一档。断言的是渲染后的几何而不是类名字符串 ——
// 把缝宽改回旧值、或让某张卡片重新自带宽高，这里都会失败。
//
// 只桩 IPC，不访问真实站点（相关视频列表刻意给满，让三种卡片同时在场）。
// 用法：playwright-cli -s=spacing run-code --filename=tests/video-sidebar-spacing.browser.js
// oxlint-disable-next-line no-unused-expressions -- run-code 要求顶层函数表达式。
async (page) => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const origin = page.url().match(/^https?:\/\/[^/]+/)?.[0] ?? "http://localhost:1420";
  await page.addInitScript(() => {
    window.isTauri = true;
    let nextCallback = 1;
    const related = [1, 2, 3].map((index) => ({
      bvid: `BVrelated${index}`,
      aid: String(900 + index),
      cid: 9000 + index,
      title: `相关视频 ${index}`,
      cover: "",
      author: "别的UP",
      author_face: null,
      duration: 30 * index,
      view: index * 100,
      danmaku: index,
      reply: index,
      pubdate: 0,
      rcmd_reason: null,
      dimension: null,
    }));
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => nextCallback++,
      unregisterCallback: () => {},
      invoke: async (command) => {
        if (command === "settings_get") {
          // 首屏会先读设置；返回 null 会让整页停在「无法读取当前设置」。
          return {
            has_saved_settings: true,
            settings: {
              theme: "system",
              legacy_player_skin: null,
              default_site: "bilibili",
              disabled_site_ids: [],
              proxy_mode: "auto",
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
              hidden_home_entry_ids: [],
              video_recommend_api: "app",
              video_next_episode_preload: false,
              video_blocked_uploaders: [],
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
        if (command === "video_get_archive") {
          // 同时带分 P 与合集：两张选集卡同框，逐张检查内缩与间隙。
          return {
            bvid: "BVspacing",
            aid: "1",
            cid: 11,
            title: "间距测试稿件",
            cover: "",
            desc: "",
            tags: [],
            author: "间距UP",
            author_face: null,
            author_mid: "1",
            author_fans: 100,
            author_videos: 2,
            view: 1,
            danmaku: 1,
            pubdate: 0,
            reply: 1,
            pages: [1, 2].map((index) => ({
              page: index,
              cid: index * 10,
              part: `分 P ${index}`,
              duration: 60,
            })),
            ugc_season: {
              title: "间距合集",
              episodes: [1, 2].map((index) => ({
                bvid: `BVspacing${index}`,
                cid: index * 100,
                aid: String(index),
                title: `合集第 ${index} 期`,
                duration: 60,
              })),
            },
          };
        }
        // PGC：`video_season` 换成真实剧集，信息卡与分集卡两张同框。
        if (command === "video_get_season") {
          return {
            season_id: "1",
            title: "间距剧集",
            cover: "",
            evaluate: "简介",
            episodes: [1, 2].map((index) => ({
              ep_id: String(index * 100),
              bvid: `BVepisode${index}`,
              cid: index * 100,
              aid: String(index),
              title: String(index),
              long_title: `剧集 ${index}`,
              cover: "",
              duration: 60,
            })),
          };
        }
        if (command === "video_get_related") return { has_more: false, items: related };
        if (command === "video_get_comments")
          return { items: [], has_more: false, next: 0, all_count: 0 };
        if (command === "video_get_danmaku") return { segment_index: 0, entries: [] };
        if (command === "video_get_play_info") throw "测试环境不取流";
        if (command === "danmaku_favorite_list" || command === "danmaku_send_history_list") return [];
        return null;
      },
    };
  });

  const oldViewport = page.viewportSize();

  /** 等卡面就位后串成一列，量出相邻缝宽与左右内缩。 */
  const measure = async (readyCheck) => {
    await page.evaluate(async (check) => {
      const { until, frames } = await import("/tests/browser/harness.js");
      await until(() => eval(check), "侧栏卡片未全部就位", 15000);
      // 换 P / 切集都会程序化滚动，先让动画与滚动都停下再量几何。
      await frames();
    }, readyCheck);
    return page.evaluate(() => {
      const aside = document.querySelector("aside[aria-label=视频详情]");
      const asideRect = aside.getBoundingClientRect();
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return {
          top: Math.round(r.top * 10) / 10,
          bottom: Math.round(r.bottom * 10) / 10,
          left: Math.round(r.left * 10) / 10,
          right: Math.round(r.right * 10) / 10,
        };
      };
      // 卡面从上到下：信息卡（UGC 是 UP 卡、PGC 是当前剧集信息卡）、选集/合集/分集卡、
      // 相关视频行卡。信息卡取卡壳而不是外面的定位壳，缝宽才是视觉上的那一档。
      const infoCard =
        document.querySelector("section[aria-label^='UP 主信息'] > div") ??
        document.querySelector("section[aria-label='当前剧集信息'] [data-slot=card]");
      const selectionCards = [...document.querySelectorAll("[data-slot=video-selection-card]")];
      const relatedCards = [...document.querySelectorAll("[data-slot=video-related-list] .rounded-xl")];
      const surfaces = [
        { label: "info-card", box: box(infoCard) },
        ...selectionCards.map((card, index) => ({ label: `selection-card-${index}`, box: box(card) })),
        ...relatedCards.map((card, index) => ({ label: `related-card-${index}`, box: box(card) })),
      ];
      const gaps = surfaces.slice(1).map((surface, index) => ({
        from: surfaces[index].label,
        to: surface.label,
        gap: Math.round((surface.box.top - surfaces[index].box.bottom) * 10) / 10,
      }));
      // 左右内缩：各卡面到自己侧栏边缘的距离（侧栏自带 1px 左描边，右缘没有）。
      const insets = surfaces.map((surface) => ({
        label: surface.label,
        left:
          Math.round((surface.box.left - asideRect.left - parseFloat(getComputedStyle(aside).borderLeftWidth)) * 10) / 10,
        right: Math.round((asideRect.right - surface.box.right) * 10) / 10,
      }));
      // 页签栏到第一张卡的距离：与卡片缝隙同一档。
      const tabBar = document.querySelector("aside[aria-label=视频详情] [role=tablist]")?.parentElement;
      return {
        asideWidth: Math.round(asideRect.width),
        topGap: tabBar
          ? Math.round((surfaces[0].box.top - tabBar.getBoundingClientRect().bottom) * 10) / 10
          : null,
        gaps,
        insets,
      };
    });
  };

  /** 断言一档缝宽 + 一档内缩；`expectRelated` 决定相关视频列表是否必须满三条。 */
  const assertRhythm = (name, measured, expectRelated) => {
    // 1. 相邻卡片之间一档缝宽：8px。旧实现分别是 16 / 6 / 4px，任何一处漏改
    //    都会在这里以「某条缝宽不等于 8」暴露出来。
    for (const entry of measured.gaps) {
      assert(
        Math.abs(entry.gap - 8) <= 0.5,
        `${name}: ${entry.from} → ${entry.to} 的间距应为 8px（实测 ${entry.gap}）`,
      );
    }
    // 2. 页签栏到第一张卡也是同一档：栏首不留另一套留白。
    assert(
      measured.topGap !== null && Math.abs(measured.topGap - 8) <= 0.5,
      `${name}: 页签栏到第一张卡的间距应为 8px（实测 ${measured.topGap}）`,
    );
    // 3. 所有卡面左右内缩一致：12px。旧实现信息卡与选集卡是 10px、相关视频是 12px。
    for (const entry of measured.insets) {
      assert(
        Math.abs(entry.left - 12) <= 0.5 && Math.abs(entry.right - 12) <= 0.5,
        `${name}: ${entry.label} 的左右内缩应同为 12px（实测 ${entry.left} / ${entry.right}）`,
      );
    }
    // 4. 相关视频卡之间也走同一档：它们是同一列表里的兄弟，不存在「组内更紧」。
    if (expectRelated) {
      const relatedGaps = measured.gaps.filter((entry) => entry.to.startsWith("related-card-"));
      assert(
        relatedGaps.length >= 2,
        `${name}: 相关视频卡不足三张，列表内间距未被覆盖（实测 ${relatedGaps.length} 条）`,
      );
    }
  };

  try {
    // 移动端 390 与桌面侧栏两档：内缩写死在卡片列上，两处必须给出同一档缝宽。
    const report = {};
    for (const viewport of [
      { name: "mobile", width: 390, height: 844 },
      { name: "desktop", width: 1440, height: 900 },
    ]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      // UGC：信息卡 + 选集卡 + 合集卡 + 满三条相关视频卡同时在场。
      await page.goto(
        `${origin}/video/play?bvid=BVspacing&cid=11&aid=1&title=%E9%97%B4%E8%B7%9D`,
        { waitUntil: "domcontentloaded", timeout: 20000 },
      );
      const ugc = await measure(`!!document.querySelector("section[aria-label^='UP 主信息'] > div") &&
        document.querySelectorAll("[data-slot=video-selection-card]").length === 2 &&
        document.querySelectorAll("[data-slot=video-related-list] .rounded-xl").length === 3`);
      // PGC：当前剧集信息卡 + 分集卡两张同框；PGC 不取相关视频流，列表自然为空。
      await page.goto(`${origin}/video/play?ep_id=100&cid=100&aid=1&title=%E9%97%B4%E8%B7%9D`, {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });
      const pgc = await measure(`!!document.querySelector("section[aria-label='当前剧集信息'] [data-slot=card]") &&
        document.querySelectorAll("[data-slot=video-selection-card]").length === 1`);
      report[viewport.name] = { ugc, pgc };
      assertRhythm(`${viewport.name} UGC`, ugc, true);
      assertRhythm(`${viewport.name} PGC`, pgc, false);
    }
    return { passed: true, ...report };
  } finally {
    if (oldViewport) await page.setViewportSize(oldViewport);
  }
}
