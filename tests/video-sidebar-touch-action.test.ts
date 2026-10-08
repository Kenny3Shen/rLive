import { describe, expect, test } from "bun:test";

/**
 * 侧栏触摸轴的 CSS 不变量：条带内每个纵向滚动容器都必须自己声明 `touch-pan-y`，
 * 页签条不再设纵向抓手，只有内容视口绑定自适应手势。
 *
 * 真机（vivo V2509A / Android 16 / WebView 151）实测的缺陷：只在 Tabs 外壳上写
 * `touch-pan-y` 不够。Chromium 用命中元素所在的**最近滚动容器**决定手势归属，
 * 该容器保持默认 `touch-action: auto` 时，横向拖动会被合成器当成滚动接走，第一次
 * pointermove 之后立刻 pointercancel，`useHorizontalSwipe` 永远攒不到 12px 锁定
 * 阈值——表现为「下方栏怎么滑都不切页签」，而合成 PointerEvent 却能切（合成事件
 * 不经合成器，所以夹具测不出来，只能靠源码不变量守）。
 *
 * 用源码断言而不是渲染断言：这几个滚动层分散在 `VideoSidebar` 的各个子组件里，
 * 渲染它们需要 TanStack Query 的真实数据；而漏加 class 是纯静态的书写疏漏。
 */
const SOURCES = [
  "../src/features/video/VideoSidebar.tsx",
  "../src/features/video/VideoDanmakuList.tsx",
];

describe("video sidebar touch axes", () => {
  for (const path of SOURCES) {
    test(`${path.split("/").pop()} 的每个纵向滚动容器都让出横向`, async () => {
      const source = await Bun.file(new URL(path, import.meta.url)).text();
      // 逐个 className 字符串检查，避免跨属性误匹配。
      const offenders = [...source.matchAll(/"([^"]*\boverflow-y-(?:auto|scroll)\b[^"]*)"/g)]
        .map((match) => match[1])
        .filter((className) => !className.includes("touch-pan-y"));
      expect(offenders).toEqual([]);
    });
  }

  test("评论 / 弹幕独立内滚、外壳固定发送区，其余页签让出横向", async () => {
    const source = await Bun.file(new URL(SOURCES[0], import.meta.url)).text();
    // 弹幕与评论各自提供列表视口，外壳不滚动，发送区才能固定在底部。
    expect(source).toContain('value === "danmaku" || value === "comments"');
    expect(source).toContain('data-slot="video-sidebar-comments-list"');
    expect(source).toContain("<VideoCommentComposer aid={resolvedAid} />");
    expect(source).toContain('? "overflow-hidden"');
    expect(source).toContain(': "overflow-y-auto overscroll-contain touch-pan-y"');
  });

  test("条带视口用 overflow-clip，任何面板的 scrollIntoView 都滚不动它", async () => {
    const source = await Bun.file(new URL(SOURCES[0], import.meta.url)).text();
    const start = source.indexOf("data-video-side-tab-viewport");
    expect(start).toBeGreaterThan(-1);
    // 视口的 className 就在该属性之后的那一段。
    const viewportTag = source.slice(start, source.indexOf(">", start));
    // overflow-hidden 仍是滚动容器，只是不给滚动条：面板横向偏出视口时，
    // 面板内的 scrollIntoView 会横向滚动它，条带停在页签之间（真机实测
    // scrollLeft 停在 304.86px），显示的面板与选中页签脱同步。clip 不建立
    // 滚动容器，这条不变量由布局保证，不依赖每个面板自我约束。
    expect(viewportTag).toContain("overflow-clip");
    expect(viewportTag).not.toContain("overflow-hidden");
  });

  test("三类选集仅定位自身有限高列表，且非活动页签不跟随滚动", async () => {
    const source = await Bun.file(new URL(SOURCES[0], import.meta.url)).text();
    expect(source).not.toMatch(/\.scrollIntoView\(/);
    expect(source).toContain("if (!active) return;");
    expect(source).toContain("list.scrollTop +=");
    expect(source).toContain("useCurrentRowScroll(open && active, epId)");
    expect(source).toContain("useCurrentRowScroll(active, currentBvid)");
    expect(source).toContain("useCurrentRowScroll(open && active, currentCid)");
    for (const kind of ["episodes", "season", "parts"]) {
      const start = source.indexOf(`data-video-selection-list="${kind}"`);
      expect(start).toBeGreaterThan(-1);
      const listTag = source.slice(start, source.indexOf(">", start));
      expect(listTag).toContain("max-h-64");
      expect(listTag).toContain("overflow-y-auto overscroll-contain");
    }
  });

  test("三类选集共用 Collapsible 标题开关，收起时立即退出焦点序列", async () => {
    const source = await Bun.file(new URL(SOURCES[0], import.meta.url)).text();
    expect(source).toContain("function SelectionSection(");
    expect(source.match(/<SelectionSection\s/g)).toHaveLength(3);
    expect(source).toContain("<CollapsibleContent inert={!open || undefined}>");
    expect(source).toContain("defaultOpen={!multiPart}");
    expect(source).toMatch(/<PartsSeasonPanel\s+[\s\S]*?key=\{archive\.bvid\}/);
    expect(source).toMatch(/<EpisodesPanel\s+key=\{season\.season_id\}/);
  });

  test("合集与分集不再独立成 Tab，UGC 与 PGC 的弹幕入口同源", async () => {
    const source = await Bun.file(new URL(SOURCES[0], import.meta.url)).text();
    const sidebarTab = source.match(/export type SidebarTab = ([^;]+);/)?.[1] ?? "";
    expect(sidebarTab).toContain('"related"');
    expect(sidebarTab).not.toContain('"episodes"');
    expect(sidebarTab).not.toContain('"parts"');
    expect(source).toContain("const showDanmakuTab = danmaku !== undefined;");
    expect(source).toContain("danmakuComposer?: ReactNode;");
    expect(source).toContain('data-slot="video-sidebar-danmaku-composer"');
  });

  test("取消 Tab 抓手，只在内容视口绑定自适应占比", async () => {
    const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();
    const source = await Bun.file(new URL(SOURCES[0], import.meta.url)).text();
    expect(css).not.toContain("[data-vod-details-handle]");
    expect(source).not.toContain("data-vod-details-handle");
    expect(source).toMatch(/ref=\{detailsContentRef\}\s+data-video-side-tab-viewport/);
    const player = await Bun.file(
      new URL("../src/features/video/VideoPlayerPage.tsx", import.meta.url),
    ).text();
    expect(player).toContain("canResizeVideoDetails(frameAspectRatio)");
  });
});
