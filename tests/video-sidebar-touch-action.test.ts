import { describe, expect, test } from "bun:test";

/**
 * 侧栏横滑切页签的 CSS 不变量：条带内每个纵向滚动容器都必须自己声明 `touch-pan-y`。
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

describe("video sidebar swipe touch-action", () => {
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

  test("页签面板的三元分支两侧都覆盖到（弹幕支不滚动、其余支让出横向）", async () => {
    const source = await Bun.file(new URL(SOURCES[0], import.meta.url)).text();
    // 弹幕页签由 VideoDanmakuList 自持滚动视口，外壳必须是 overflow-hidden；
    // 其余页签由外壳滚动，必须带 touch-pan-y。写死这对组合，防止两支被改成同一种。
    expect(source).toContain('value === "danmaku"');
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

  test("合集与选集列表的定位滚动都受 active 把关", async () => {
    const source = await Bun.file(new URL(SOURCES[0], import.meta.url)).text();
    // 连播换集会在后台改 currentBvid / currentCid；非活动页签跟着滚动
    // 既没有意义，也是条带被滚偏的来源之一。
    const gates = [...source.matchAll(/if \((?:open && )?!?active\) return;|if \(open && active\)/g)];
    expect(gates.length).toBeGreaterThanOrEqual(2);
    for (const match of source.matchAll(/useEffect\(\(\) => \{[\s\S]{0,160}?scrollIntoView[\s\S]{0,80}?\}, \[[^\]]*\]\);/g)) {
      expect(match[0], "定位滚动必须带 active 守卫").toMatch(/active/);
    }
  });
});
