// 竖屏流章节入口的浏览器回归（IPC 与 DASH 适配器为本地桩，媒体状态由 `<video>` 桩提供）：
//   playwright-cli -s=shorts-chapters open http://127.0.0.1:1420/ && \
//   playwright-cli -s=shorts-chapters run-code --filename=tests/shorts-chapters.browser.js
//
// 断言（桌面 1280×720 与手机 390×844 各一遍）：
//   1. 有章节时，胶囊出现在信息块里、进度条上方左侧，显示当前章节名；
//   2. 弹层列出全部章节并高亮当前项，点选跳到该章起点、收起弹层，胶囊随之更新；
//   3. 弹层展开时滚轮不换片（列表要能滚）；
//   4. 换到没有章节的下一条后入口消失。
// oxlint-disable-next-line no-unused-expressions -- run-code 要求顶层函数表达式。
async (page) => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const settle = (ms = 400) => page.waitForTimeout(ms);
  const origin = page.url().match(/^https?:\/\/[^/]+/)[0];

  await page.addInitScript(() => {
    window.isTauri = true;
    let nextCallback = 1;
    const item = (n, title) => ({
      bvid: `BVch${n}`,
      aid: String(n),
      cid: 7000 + n,
      title,
      cover: "",
      author: "测试 UP 主",
      author_face: null,
      author_fans: 10,
      duration: 600,
      view: 100,
      danmaku: 1,
      reply: 2,
      pubdate: 1_789_292_152,
      rcmd_reason: null,
      dimension: { width: 1080, height: 1920, rotate: 0 },
    });
    const storyItems = [item(1, "带章节的竖屏"), item(2, "没有章节的竖屏")];
    // 取流适配器换成空壳：页面走真实槽位 hook，媒体状态由下面的 `<video>` 桩提供。
    class Dash extends EventTarget {
      handlers = new Map();
      engine = { on: (name, fn) => this.handlers.set(name, fn), off: (name) => this.handlers.delete(name) };
      source = null;
      attach() {}
      set src(src) {
        this.source = { ...this.source, src };
      }
      destroy() {}
    }
    window.__shortsModules = { DashAdapter: Dash };
    HTMLMediaElement.prototype.play = function play() {
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function pause() {};
    window.__chapterMetaCalls = [];
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
        if (command === "video_get_story") return { has_more: false, items: storyItems };
        if (command === "video_get_play_info") {
          const id = `ch-${args.request.cid}`;
          return {
            mpd_url: `http://localhost/${id}.mpd`,
            video_url: "",
            audio_url: "",
            duration: 600,
            quality: 80,
            quality_label: "测试",
            codecs: "avc1",
            accept_quality: [],
            audio_only: false,
            session_ids: { video: `${id}-v`, audio: `${id}-a`, mpd: `${id}-m` },
          };
        }
        if (command === "video_get_player_meta") {
          window.__chapterMetaCalls.push(args.request);
          return {
            subtitles: [],
            chapters:
              args.request.cid === 7001
                ? [
                    { start_time: 0, end_time: 60, title: "开场" },
                    { start_time: 60, end_time: 300, title: "正片" },
                    { start_time: 300, end_time: 600, title: "结尾" },
                  ]
                : [],
          };
        }
        if (command === "video_get_comments") return { items: [], has_more: false, next: 0, all_count: 0 };
        if (command === "video_get_danmaku") return { segment_index: 0, entries: [] };
        if (command === "danmaku_favorite_list" || command === "danmaku_send_history_list") return [];
        return null;
      },
    };
  });

  // 让 `loadVideoJsModules` 返回上面的空壳适配器（与 shorts-playback-lifecycle 同一注入点）。
  const pattern = "**/src/features/room/player/videoJsPlayer.ts*";
  const signature = "async function loadVideoJsModules(kind) {";
  const source = await page.evaluate(async () => (await fetch("/src/features/room/player/videoJsPlayer.ts")).text());
  assert(source.includes(signature), "测试注入点已改变：videoJsPlayer.ts");
  await page.route(pattern, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: source.replace(signature, `${signature}\nif (window.__shortsModules) return window.__shortsModules;`),
    }),
  );

  // 每个 `<video>` 自报 600s、可 seek；时间写入后派发 seeked/timeupdate 让 store 同步。
  const stubMedia = () =>
    page.evaluate(() => {
      for (const video of document.querySelectorAll("video")) {
        // 槽位跨换片复用 `<video>`：已桩过的元素只重派事件，让新源重新进入就绪态。
        if (!video.__chapterStub) video.__chapterStub = { t: 0 };
        else {
          for (const name of ["loadedmetadata", "durationchange", "loadeddata", "canplay", "timeupdate"]) {
            video.dispatchEvent(new Event(name));
          }
          continue;
        }
        const state = video.__chapterStub;
        Object.defineProperty(video, "readyState", { configurable: true, get: () => 4 });
        Object.defineProperty(video, "duration", { configurable: true, get: () => 600 });
        Object.defineProperty(video, "currentTime", {
          configurable: true,
          get: () => state.t,
          set: (value) => {
            state.t = value;
            video.dispatchEvent(new Event("seeking"));
            queueMicrotask(() => {
              video.dispatchEvent(new Event("seeked"));
              video.dispatchEvent(new Event("timeupdate"));
            });
          },
        });
        for (const name of ["loadedmetadata", "durationchange", "loadeddata", "canplay", "timeupdate"]) {
          video.dispatchEvent(new Event(name));
        }
      }
    });

  const run = async (label, viewport) => {
    await page.setViewportSize(viewport);
    await page.goto(`${origin}/shorts/bilibili`);
    await page.waitForSelector('[data-slot="shorts-info-float"]', { timeout: 15000 });
    await page.waitForFunction(() => document.querySelectorAll("video").length > 0);
    await settle(300);
    await stubMedia();

    const pill = page.locator('[data-slot="shorts-chapters"] button[aria-label^="章节"]');
    await pill.waitFor({ timeout: 10000 });
    assert((await pill.getAttribute("aria-label")) === "章节：开场", `${label}：初始应高亮开场`);
    const geometry = await page.evaluate(() => {
      const rect = (el) => el?.getBoundingClientRect();
      const pill = rect(document.querySelector('[data-slot="shorts-chapters"] button'));
      const seek = rect(document.querySelector('[data-slot="shorts-seek"]'));
      const viewport = rect(document.querySelector('[data-slot="shorts-viewport"]'));
      return pill && seek && viewport
        ? { above: pill.bottom <= seek.top + 1, left: pill.left - viewport.left, width: viewport.width }
        : null;
    });
    assert(geometry && geometry.above, `${label}：胶囊应在进度条上方 ${JSON.stringify(geometry)}`);
    assert(geometry.left < geometry.width / 3, `${label}：胶囊应贴左侧 ${JSON.stringify(geometry)}`);

    await pill.click();
    const list = page.getByRole("list", { name: "章节列表" });
    await list.waitFor();
    const items = list.getByRole("button");
    assert((await items.count()) === 3, `${label}：章节条目数不对`);
    assert((await items.first().getAttribute("aria-current")) === "true", `${label}：当前章节未高亮`);

    // 弹层展开时滚轮不换片。
    const aidBefore = await page.locator('[data-slot="shorts-viewport"]').getAttribute("data-current-aid");
    const box = await list.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 240);
    await settle(600);
    const aidAfterWheel = await page.locator('[data-slot="shorts-viewport"]').getAttribute("data-current-aid");
    assert(aidAfterWheel === aidBefore, `${label}：弹层展开时滚轮不应换片`);

    await items.filter({ hasText: "正片" }).click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll("video")].some((v) => v.__chapterStub && v.currentTime === 60),
    );
    await list.waitFor({ state: "hidden" });
    await page.locator('[data-slot="shorts-chapters"] button[aria-label="章节：正片"]').waitFor();

    // 换到没有章节的下一条：入口消失。
    // 换片走滚轮：手机宽度下「下一条」按钮隐藏，滚轮在所有宽度都可用。
    await page.mouse.move(viewport.width / 2, viewport.height / 3);
    await page.mouse.wheel(0, 240);
    await page.waitForFunction(
      () => document.querySelector('[data-slot="shorts-viewport"]')?.getAttribute("data-current-aid") === "2",
      null,
      { timeout: 10000 },
    );
    await settle(300);
    await stubMedia();
    await page.waitForFunction(() =>
      window.__chapterMetaCalls.some((request) => request.cid === 7002),
    );
    await settle(300);
    assert((await pill.count()) === 0, `${label}：无章节条目不应显示入口`);
    return { label, geometry };
  };

  const report = [];
  report.push(await run("桌面", { width: 1280, height: 720 }));
  report.push(await run("手机", { width: 390, height: 844 }));
  return report;
}
