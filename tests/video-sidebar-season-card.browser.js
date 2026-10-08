// 播放页侧栏「合集」稿件的信息卡契约：
//
//   1. 在合集内连续切换稿件（含回到已缓存的稿件），UP 主信息卡始终只有一张。
//      UP 卡与选集区曾共用 `key={bvid}`：缓存命中时 `archive.bvid === bvid`，
//      同一 Fragment 里出现重复 key，React 删不掉旧节点，卡片越切越多；
//   2. 合集/选集区自成一张卡片（底色 + 描边 + 圆角），与下方相关视频分开；
//   3. 移动端（Android UA）选集卡片默认收起，评论与弹幕发送区底色一致。
//
// 只桩 IPC，不访问真实站点。
// 用法：playwright-cli -s=season run-code --filename=tests/video-sidebar-season-card.browser.js
// oxlint-disable-next-line no-unused-expressions -- run-code 要求顶层函数表达式。
async (page) => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const origin = page.url().match(/^https?:\/\/[^/]+/)?.[0] ?? "http://localhost:1420";
  await page.addInitScript(() => {
    // 移动端判据是 UA（`isMobileClient()`），不是视口宽度；经 sessionStorage 在 reload 间传递。
    const mobileUA = sessionStorage.getItem("__seasonCardMobileUA");
    if (mobileUA) Object.defineProperty(navigator, "userAgent", { get: () => mobileUA, configurable: true });
    window.isTauri = true;
    let nextCallback = 1;
    const episodes = [1, 2, 3].map((index) => ({
      bvid: `BVseason${index}`,
      cid: index * 100,
      title: `合集第 ${index} 期`,
      aid: String(index),
      duration: 60 * index,
      cover: "",
    }));
    const archiveOf = (bvid) => {
      const episode = episodes.find((entry) => entry.bvid === bvid) ?? episodes[0];
      return {
        bvid: episode.bvid,
        aid: episode.aid,
        cid: episode.cid,
        title: episode.title,
        cover: "",
        desc: "简介",
        tags: [],
        author: "合集UP",
        author_face: null,
        author_mid: "1",
        author_fans: 100,
        author_videos: 3,
        view: 1000,
        danmaku: 10,
        pubdate: 1735689600,
        reply: 5,
        pages: [],
        ugc_season: { title: "测试合集", episodes },
      };
    };
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => nextCallback++,
      unregisterCallback: () => {},
      invoke: async (command, args) => {
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
              // 缺这一项会让设置解析抛错，整页停在「无法读取当前设置」。
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
        if (command === "video_get_archive") return archiveOf(args?.bvid);
        if (command === "video_get_related") {
          return {
            has_more: false,
            items: [
              {
                bvid: "BVrelated1",
                aid: "99",
                cid: 9900,
                title: "相关视频",
                cover: "",
                author: "别的UP",
                author_face: null,
                duration: 30,
                view: 1,
                danmaku: 1,
                reply: 1,
                pubdate: 0,
                rcmd_reason: null,
                dimension: null,
              },
            ],
          };
        }
        if (command === "video_get_comments") return { items: [], has_more: false, next: 0, all_count: 0 };
        if (command === "video_get_danmaku") return { segment_index: 0, entries: [] };
        if (command === "video_get_play_info") throw "测试环境不取流";
        if (command === "danmaku_favorite_list" || command === "danmaku_send_history_list") return [];
        return null;
      },
    };
  });

  const oldViewport = page.viewportSize();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${origin}/video/play?bvid=BVseason1&cid=100&aid=1&title=x`, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    const upCards = () =>
      page.evaluate(
        () => document.querySelectorAll("aside[aria-label=视频详情] section[aria-label^='UP 主信息']").length,
      );
    const waitCurrent = (title) =>
      page.evaluate(async (title) => {
        const { until } = await import("/tests/browser/harness.js");
        await until(
          () =>
            document.querySelector("aside[aria-label=视频详情] [data-video-selection-list=season] [aria-current=true]")
              ?.textContent?.includes(title),
          `当前项未切到「${title}」`,
          15000,
        );
        // 两帧：让切换后的提交与随后的 effect 都落地。
        const { frames } = await import("/tests/browser/harness.js");
        await frames();
      }, title);
    const clickEpisode = (title) =>
      page.evaluate((title) => {
        const rows = [...document.querySelectorAll("aside[aria-label=视频详情] [data-video-selection-list=season] button")];
        rows.find((row) => row.textContent.includes(title)).click();
      }, title);

    await waitCurrent("合集第 1 期");
    const counts = [await upCards()];
    // 1 → 2 → 3（未缓存）→ 1 → 2（缓存命中，`archive.bvid` 立即等于新 `bvid`）。
    for (const title of ["合集第 2 期", "合集第 3 期", "合集第 1 期", "合集第 2 期"]) {
      await clickEpisode(title);
      await waitCurrent(title);
      counts.push(await upCards());
    }
    assert(counts.every((count) => count === 1), `UP 主信息卡数量应恒为 1，实测 ${counts.join(",")}`);

    const surface = await page.evaluate(() => {
      const panel = document.querySelector("aside[aria-label=视频详情] [data-slot=video-selection-card]");
      if (!panel) return null;
      const style = getComputedStyle(panel);
      const related = document.querySelector("aside[aria-label=视频详情] [data-slot=video-related-list]");
      return {
        borderTop: style.borderTopWidth,
        radius: Number.parseFloat(style.borderTopLeftRadius),
        background: style.backgroundColor,
        separated: related ? related.getBoundingClientRect().top >= panel.getBoundingClientRect().bottom : false,
      };
    });
    assert(surface, "合集/选集区没有独立卡片");
    assert(surface.borderTop !== "0px", "合集卡片缺少描边");
    assert(surface.radius >= 8, "合集卡片缺少圆角");
    assert(!/rgba\(0, 0, 0, 0\)|transparent/.test(surface.background), "合集卡片缺少底色");
    assert(surface.separated, "相关视频没有落在合集卡片之后");

    const desktopToggle = await page.evaluate(
      () =>
        document
          .querySelector("aside[aria-label=视频详情] [data-slot=video-selection-card] h3 button")
          ?.getAttribute("aria-expanded"),
    );
    assert(desktopToggle === "true", `桌面端单独合集应默认展开，实测 ${desktopToggle}`);

    // 移动端：选集卡片默认收起；两个发送区底色一致。
    await page.evaluate(() =>
      sessionStorage.setItem(
        "__seasonCardMobileUA",
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36",
      ),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/video/play?bvid=BVseason1&cid=100&aid=1&title=x`, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    const mobile = await page.evaluate(async () => {
      const { until, frames } = await import("/tests/browser/harness.js");
      await until(
        () => document.querySelector("[data-slot=video-selection-card] h3 button[aria-expanded]"),
        "移动端合集卡片未出现",
        15000,
      );
      await frames();
      const toggle = document.querySelector("[data-slot=video-selection-card] h3 button[aria-expanded]");
      const comment = document.querySelector("section[aria-label=发送评论]");
      const danmaku = document.querySelector("[data-slot=video-sidebar-danmaku-composer] > *");
      // 弹幕发送区只在竖屏非全屏且播放器就绪时挂进侧栏；桩环境不取流时可能缺席，
      // 此时用同一 tone 类名的探针元素比对计算后的底色。
      let danmakuBackground = danmaku ? getComputedStyle(danmaku).backgroundColor : null;
      if (!danmakuBackground) {
        const probe = document.createElement("div");
        probe.className = "bg-sidebar/80";
        comment?.parentElement?.append(probe);
        danmakuBackground = getComputedStyle(probe).backgroundColor;
        probe.remove();
      }
      return {
        expanded: toggle?.getAttribute("aria-expanded"),
        listMounted: Boolean(document.querySelector("[data-video-selection-list=season]")),
        commentBackground: comment ? getComputedStyle(comment).backgroundColor : null,
        danmakuBackground,
        danmakuMounted: Boolean(danmaku),
      };
    });
    assert(mobile.expanded === "false", `移动端合集应默认收起，实测 ${mobile.expanded}`);
    assert(!mobile.listMounted, "移动端收起态不应挂载合集列表");
    assert(mobile.commentBackground, "移动端评论发送区未出现");
    assert(
      mobile.commentBackground === mobile.danmakuBackground,
      `移动端评论/弹幕发送区底色应一致：${mobile.commentBackground} vs ${mobile.danmakuBackground}`,
    );

    return { passed: true, counts, surface, desktopToggle, mobile };
  } finally {
    await page.evaluate(() => sessionStorage.removeItem("__seasonCardMobileUA")).catch(() => {});
    if (oldViewport) await page.setViewportSize(oldViewport);
  }
}
