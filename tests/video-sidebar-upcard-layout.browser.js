// 播放页侧栏「UP 主信息卡」的排版契约。断言的是渲染后的几何与计算样式，
// 而不是类名字符串：
//
//   1. 标题一行，箭头紧跟文字（短标题在文字后面，不是固定飘在右边界）；
//   2. 播放/评论/日期紧跟标题下方，三项用同一档间距、不插竖线，
//      数值不加粗也不用强调色（字号低于正文）；
//   3. 统计行下的留白与卡壳顶部留白相等；
//   4. 点标题任意位置切换简介展开，两端按钮都不带底色；
//   5. 收起时标题单行截断（卡高固定、骨架不跳），展开后换行显示完全体、
//      箭头落到最后一行（与短视频详情入口同一读法）；
//   6. 展开/收起是高度过渡（两端各能采到中间帧），收起后简介仍在 DOM 里
//      （`hidden`），`aria-controls` 始终可解析。
//
// 只桩 IPC，不访问真实站点。
// 用法：playwright-cli -s=upcard run-code --filename=tests/video-sidebar-upcard-layout.browser.js
// oxlint-disable-next-line no-unused-expressions -- run-code 要求顶层函数表达式。
async (page) => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const origin = page.url().match(/^https?:\/\/[^/]+/)?.[0] ?? "http://localhost:1420";
  await page.addInitScript(() => {
    window.isTauri = true;
    let nextCallback = 1;
    const archive = {
      bvid: "BV1xx411c7mD",
      aid: "456",
      cid: 123,
      title: "标题：这是一个用来测量标题行与统计行几何的视频标题，故意写长一点",
      cover: "",
      desc: "简介正文：这里是一段描述，用来观察展开后的排版。",
      tags: ["标签一", "标签二"],
      author: "测试UP主名字很长很长很长很长很长很长",
      author_face: null,
      author_mid: "1",
      author_fans: 123456,
      author_videos: 4567,
      view: 1234567,
      danmaku: 4567,
      pubdate: 1735689600,
      reply: 23456,
      pages: [],
      ugc_season: null,
    };
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
        // 允许夹具用 `window.__upcardArchive` 覆盖（退化分支：没有简介也没有 Tags）。
        if (command === "video_get_archive") return window.__upcardArchive ?? archive;
        if (command === "video_get_related") return { has_more: false, items: [] };
        if (command === "video_get_season") return { episodes: [] };
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
    await page.goto(
      `${origin}/video/play?bvid=BV1xx411c7mD&cid=123&aid=456&title=%E6%B5%8B%E8%AF%95`,
      { waitUntil: "domcontentloaded", timeout: 20000 },
    );
    await page.evaluate(async () => {
      const { until } = await import("/tests/browser/harness.js");
      await until(
        () => !!document.querySelector("aside[aria-label=视频详情] dl"),
        "统计行未出现",
        15000,
      );
    });

    const measure = () =>
      page.evaluate(() => {
        const aside = document.querySelector("aside[aria-label=视频详情]");
        const dl = aside.querySelector("dl");
        const card = dl.closest(".rounded-xl");
        const toggle = aside.querySelector("button[aria-controls=video-description]");
        const desc = aside.querySelector("#video-description");
        const title = toggle.querySelector("span > span");
        const arrow = toggle.querySelector("svg");
        const rect = (el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
        };
        const items = [...dl.children].map((el) => ({
          text: el.textContent,
          box: rect(el),
          dd: (() => {
            const dd = el.querySelector("dd");
            const style = getComputedStyle(dd);
            return { fontSize: style.fontSize, fontWeight: style.fontWeight, color: style.color };
          })(),
          icon: el.querySelector("svg") ? rect(el.querySelector("svg")) : null,
          // 分隔线会以相邻边框出现：「不插竖线」就看这一项。
          borderWidths: [
            getComputedStyle(el).borderLeftWidth,
            getComputedStyle(el).borderRightWidth,
            getComputedStyle(el).borderTopWidth,
          ],
        }));
        const cardStyle = getComputedStyle(card);
        const borderTop = parseFloat(cardStyle.borderTopWidth);
        const borderBottom = parseFloat(cardStyle.borderBottomWidth);
        // 上留白 = 卡壳内容区顶到第一行（头像行）顶；下留白 = 统计行底到内容区底。
        // 两边都不算边框与 padding，量的是「视觉留白」本身。
        const header = card.firstElementChild;
        return {
          cardTop: rect(card).y,
          cardBottom: rect(card).bottom,
          headerTop: rect(header).y,
          statsBottom: rect(dl).bottom,
          paddingTop: parseFloat(cardStyle.paddingTop),
          paddingBottom: parseFloat(cardStyle.paddingBottom),
          borderTop,
          borderBottom,
          titleBox: rect(title),
          arrowBox: rect(arrow),
          toggleBox: rect(toggle),
          toggleBg: getComputedStyle(toggle).backgroundColor,
          toggleExpanded: toggle.getAttribute("aria-expanded"),
          contentRight: rect(card).right - parseFloat(cardStyle.paddingRight),
          items,
          itemGap: items
            .slice(1)
            .map((item, index) => Math.round((item.box.x - items[index].box.right) * 10) / 10),
          dlRows: new Set(items.map((item) => Math.round(item.box.y))).size,
          descHidden: desc.hidden,
          // 标题是否被截断：`truncate` 下 scrollWidth 会超出 clientWidth。
          titleTruncated: title.scrollWidth > title.clientWidth + 1,
          titleLineHeight: parseFloat(getComputedStyle(title).lineHeight),
          titleHasTooltip: title.hasAttribute("title"),
        };
      });

    const collapsed = await measure();

    /* ---------- 1. 标题一行，箭头紧跟文字 ---------- */
    assert(
      collapsed.titleBox.h <= 24 && collapsed.titleBox.h >= 18,
      `标题应是一行（实测高度 ${collapsed.titleBox.h}）`,
    );
    // 箭头贴在标题文字右边（长标题截断后同样紧跟最后可见字符），
    // 而不是固定飘在卡片右边界。
    const arrowGap = collapsed.arrowBox.x - collapsed.titleBox.right;
    assert(arrowGap >= -1 && arrowGap <= 8, `箭头应紧跟标题文字（实测间隙 ${arrowGap}）`);
    // 整行都可点：按钮宽度铺满内容区。
    assert(
      Math.abs(collapsed.toggleBox.w - (collapsed.contentRight - collapsed.toggleBox.x)) <= 1,
      `标题开关应铺满整行（按钮 ${collapsed.toggleBox.w}，可用 ${collapsed.contentRight - collapsed.toggleBox.x}）`,
    );
    // 收起态保持紧凑：长标题停在单行（骨架按 24px 画，卡高才不跳）。
    assert(
      collapsed.titleTruncated === true,
      "收起时长标题应停在单行截断（否则卡高会随标题长度变化）",
    );
    assert(
      collapsed.titleHasTooltip === true,
      "收起时截断的标题应带 title 提示",
    );

    /* ---------- 2. 统计行：等距、无竖线、不强调 ---------- */
    assert(
      collapsed.items.length === 3,
      `统计行应有播放/评论/发布时间三项（实测 ${collapsed.items.length}）`,
    );
    assert(
      collapsed.dlRows === 1,
      "典型数值下统计三项应停在单行（换行说明字号偏大）",
    );
    // 不换行是硬约束：日期永远留在这一行，宁可三项各自收窄省略。
    await page.evaluate(() => {
      document.querySelector("aside[aria-label=视频详情] dl").closest(".rounded-xl").style.width = "150px";
    });
    await page.waitForTimeout(120);
    const squeezed = await measure();
    assert(
      squeezed.dlRows === 1,
      `窄卡下统计三项也不应换行（实测 ${squeezed.dlRows} 行）`,
    );
    await page.evaluate(() => {
      document.querySelector("aside[aria-label=视频详情] dl").closest(".rounded-xl").style.width = "";
    });
    await page.waitForTimeout(120);
    const gaps = collapsed.itemGap;
    assert(
      Math.abs(gaps[0] - gaps[1]) <= 0.6,
      `三项间距应一致（实测 ${gaps.join(" / ")}）`,
    );
    assert(gaps[0] >= 8, `间距过小，读不出分组（实测 ${gaps[0]}）`);
    // 没有竖线：三项之间只有留白（分隔线会以边框形式画在相邻一侧）。
    for (const [index, item] of collapsed.items.entries()) {
      assert(
        item.borderWidths.every((width) => parseFloat(width) === 0),
        `第 ${index + 1} 项不应带分隔线（实测 ${item.borderWidths.join("/")}）`,
      );
    }
    // 数值不加粗、不用前景强调色，字号小于正文（14px）。
    const weights = collapsed.items.map((item) => item.dd.fontWeight);
    assert(
      weights.every((weight) => weight === "400"),
      `统计数值不应加粗（实测 ${weights.join("/")}）`,
    );
    assert(
      collapsed.items.every((item) => parseFloat(item.dd.fontSize) <= 12),
      `统计字号应小于正文（实测 ${collapsed.items.map((i) => i.dd.fontSize).join("/")}）`,
    );
    const [view, reply] = collapsed.items;
    assert(
      view.dd.color === reply.dd.color,
      `播放与评论应同一颜色（实测 ${view.dd.color} / ${reply.dd.color}）`,
    );
    assert(
      view.dd.color === collapsed.items[2].dd.color,
      "三项统计（含发布时间）应同为次要文字色",
    );

    /* ---------- 3. 统计行下的空白 = 卡壳上边距 ---------- */
    const topGap =
      collapsed.headerTop - collapsed.cardTop - collapsed.borderTop - collapsed.paddingTop;
    const bottomGap =
      collapsed.cardBottom - collapsed.statsBottom - collapsed.borderBottom - collapsed.paddingBottom;
    assert(
      Math.abs(topGap - bottomGap) <= 1,
      `统计行下方空白应与卡壳顶部一致（上 ${topGap} / 下 ${bottomGap}）`,
    );
    // 统计行不再与 24px 的图标按钮（粗指针下 `min-w-11` 更高）同排，行高因此回落：
    // 两项留白都应为 0（卡壳自带的 padding 之外不额外撑开）。
    assert(
      bottomGap <= 1,
      `统计行下不应再被高层级按钮撑开（实测 ${bottomGap}）`,
    );

    /* ---------- 4. 点标题切换，两端都无底色 ---------- */
    assert(collapsed.descHidden === true, "简介默认应收起");
    assert(
      collapsed.toggleBg === "rgba(0, 0, 0, 0)",
      `收起态的标题开关不应有底色（实测 ${collapsed.toggleBg}）`,
    );
    // 点标题文字（不是箭头）也要生效。
    await page.click("aside[aria-label=视频详情] button[aria-controls=video-description]", {
      position: { x: 4, y: 12 },
    });
    await page.waitForTimeout(200);
    const expanded = await measure();
    assert(expanded.descHidden === false, "点标题后简介应展开");
    assert(expanded.toggleExpanded === "true", "aria-expanded 应随展开态更新");
    assert(
      expanded.toggleBg === "rgba(0, 0, 0, 0)",
      `展开态的标题开关也不应有底色（实测 ${expanded.toggleBg}）`,
    );
    // 展开后标题必须显示完全体：换行而不截断，因此不再需要 title 提示。
    assert(
      expanded.titleTruncated === false,
      `展开后标题不应再被截断（scrollWidth ${expanded.titleBox.w} / clientWidth）`,
    );
    assert(
      expanded.titleBox.h >= expanded.titleLineHeight * 2 - 1,
      `展开后的长标题应换行到多行（实测高度 ${expanded.titleBox.h}）`,
    );
    assert(expanded.titleHasTooltip === false, "展开后标题全文可见，不应再挂 title 提示");
    // 箭头跟着标题落到最后一行（而不是飘在首行右侧）。
    const lastLineTop = expanded.titleBox.bottom - expanded.titleLineHeight;
    assert(
      expanded.arrowBox.bottom > lastLineTop && expanded.arrowBox.bottom <= expanded.titleBox.bottom + 1,
      `展开后箭头应落在标题最后一行（箭头底 ${expanded.arrowBox.bottom}，末行 ${lastLineTop}–${expanded.titleBox.bottom}）`,
    );
    const expandedArrowGap = expanded.arrowBox.x - expanded.titleBox.right;
    assert(
      expandedArrowGap >= -1 && expandedArrowGap <= 8,
      `展开后箭头仍应紧跟标题文字（实测间隙 ${expandedArrowGap}）`,
    );
    // 展开后统计行仍在标题下方（不能与换行后的标题重叠）。
    assert(
      expanded.items[0].box.y >= expanded.titleBox.bottom - 1,
      `统计行应被换行的标题推到下方（统计 ${expanded.items[0].box.y} / 标题底 ${expanded.titleBox.bottom}）`,
    );
    await page.click("aside[aria-label=视频详情] button[aria-controls=video-description]", {
      position: { x: 8, y: 12 },
    });
    await page.waitForTimeout(200);
    const restored = await measure();
    assert(restored.descHidden === true, "再点一次应收起简介");
    // 收起后回到紧凑的单行截断（展开-收起是可逆的）。
    assert(restored.titleTruncated === true, "收起后长标题应回到单行截断");
    assert(
      Math.abs(restored.titleBox.h - collapsed.titleBox.h) <= 1,
      `收起后标题行高应复原（${restored.titleBox.h} / ${collapsed.titleBox.h}）`,
    );

    /* ---------- 5. 展开/收起是高度过渡 ---------- */
    // 收起态的 `aria-controls` 必须仍能解析到目标（`keepMounted` + `hidden`）。
    assert(
      await page.evaluate(() => {
        const toggle = document.querySelector("aside[aria-label=视频详情] button[aria-controls=video-description]");
        const target = document.getElementById(toggle.getAttribute("aria-controls"));
        return !!target && target.id === "video-description";
      }),
      "收起态 aria-controls 应能解析到简介节点",
    );
    const collapsedTransition = await page.evaluate(() => {
      const desc = document.querySelector("#video-description");
      const style = getComputedStyle(desc);
      return { property: style.transitionProperty, duration: style.transitionDuration };
    });
    assert(
      collapsedTransition.property.includes("height") &&
        parseFloat(collapsedTransition.duration) > 0,
      `简介面板应有高度过渡（实测 ${collapsedTransition.property} / ${collapsedTransition.duration}）`,
    );

    // 点开并逐帧采样：必须读到 0 与终值之间的中间帧，否则是瞬时切换而不是动画。
    const expanding = await page.evaluate(async () => {
      const desc = document.querySelector("#video-description");
      const toggle = document.querySelector("aside[aria-label=视频详情] button[aria-controls=video-description]");
      toggle.click();
      const samples = [];
      const deadline = performance.now() + 400;
      while (performance.now() < deadline) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        samples.push(Math.round(desc.getBoundingClientRect().height * 10) / 10);
      }
      return { samples, finalHeight: desc.getBoundingClientRect().height, hidden: desc.hidden };
    });
    const expandFull = expanding.finalHeight;
    assert(expanding.hidden === false, "展开后简介不应再 hidden");
    assert(expandFull > 24, `展开后的简介应有实际高度（实测 ${expandFull}）`);
    assert(
      expanding.samples.some((height) => height > 2 && height < expandFull - 2),
      `展开应采到中间帧（实测 ${JSON.stringify(expanding.samples)}）`,
    );
    assert(
      Math.abs(expanding.samples.at(-1) - expandFull) <= 1,
      `展开动画应收在终值（末帧 ${expanding.samples.at(-1)} / 终值 ${expandFull}）`,
    );

    // 收起同样要有中间帧，并且收在 0（随后仍是 DOM 里的 hidden 节点）。
    const collapsing = await page.evaluate(async () => {
      const desc = document.querySelector("#video-description");
      const toggle = document.querySelector("aside[aria-label=视频详情] button[aria-controls=video-description]");
      const expandedHeight = desc.getBoundingClientRect().height;
      toggle.click();
      const samples = [];
      const deadline = performance.now() + 400;
      while (performance.now() < deadline) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        samples.push(Math.round(desc.getBoundingClientRect().height * 10) / 10);
      }
      return {
        expandedHeight,
        samples,
        finalHeight: desc.getBoundingClientRect().height,
        hidden: desc.hidden,
        inDom: !!document.getElementById("video-description"),
      };
    });
    assert(collapsing.hidden === true, "收起后简介应回到 hidden");
    assert(collapsing.inDom, "收起后简介仍应在 DOM 里（keepMounted 是 aria-controls 的前提）");
    assert(
      collapsing.samples.some(
        (height) => height > 2 && height < collapsing.expandedHeight - 2,
      ),
      `收起应采到中间帧（实测 ${JSON.stringify(collapsing.samples)}）`,
    );
    assert(
      Math.abs(collapsing.samples.at(-1) - collapsing.finalHeight) <= 1 &&
        collapsing.finalHeight <= 1,
      `收起动画应收到 0（末帧 ${collapsing.samples.at(-1)}）`,
    );

    /* ---------- 6. 没有简介也没有 Tags：标题退化成不可点的普通行 ---------- */
    await page.addInitScript(() => {
      window.__upcardArchive = {
        bvid: "BV1xx411c7mD",
        aid: "456",
        cid: 123,
        title: "没有简介也没有标签的稿件标题",
        cover: "",
        desc: "",
        tags: [],
        author: "测试UP",
        author_face: null,
        author_mid: "1",
        author_fans: 1,
        author_videos: 1,
        view: 100,
        danmaku: 1,
        pubdate: 1735689600,
        reply: 2,
        pages: [],
        ugc_season: null,
      };
    });
    await page.goto(
      `${origin}/video/play?bvid=BV1xx411c7mD&cid=123&aid=456&title=%E6%B5%8B%E8%AF%95`,
      { waitUntil: "domcontentloaded", timeout: 20000 },
    );
    await page.evaluate(async () => {
      const { until } = await import("/tests/browser/harness.js");
      await until(
        () => !!document.querySelector("aside[aria-label=视频详情] p[title^=没有简介]"),
        "退化标题未出现",
        15000,
      );
    });
    const degenerate = await page.evaluate(() => {
      const aside = document.querySelector("aside[aria-label=视频详情]");
      const title = aside.querySelector("p[title^=没有简介]");
      const dl = title.nextElementSibling;
      return {
        hasToggle: !!aside.querySelector("button[aria-controls=video-description]"),
        hasDesc: !!aside.querySelector("#video-description"),
        titleTag: title.tagName,
        titleText: title.textContent,
        // 统计行仍然紧跟标题：两行之间只隔 `mt-0.5`（2px）。
        rowGap: Math.round((dl.getBoundingClientRect().y - title.getBoundingClientRect().bottom) * 10) / 10,
      };
    });
    assert(
      !degenerate.hasToggle && !degenerate.hasDesc,
      "没有简介也没有 Tags 时不该画展开开关（无从展开）",
    );
    assert(degenerate.titleTag === "P", `退化标题应是普通段落（实测 ${degenerate.titleTag}）`);
    assert(
      degenerate.titleText === "没有简介也没有标签的稿件标题",
      `退化标题文字不符（实测 ${degenerate.titleText}）`,
    );
    assert(
      degenerate.rowGap >= 0 && degenerate.rowGap <= 3,
      `统计行仍应紧跟标题（实测间距 ${degenerate.rowGap}）`,
    );

    return {
      passed: true,
      topGap,
      bottomGap,
      gaps,
      items: collapsed.items.map((i) => i.text),
      degenerateRowGap: degenerate.rowGap,
      expandFrames: expanding.samples.length,
      collapseFrames: collapsing.samples.length,
    };
  } finally {
    if (oldViewport) await page.setViewportSize(oldViewport);
  }
}
