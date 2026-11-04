import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Square } from "lucide-react";
import {
  LocalMediaCard,
  LocalMediaCardAction,
  LocalMediaCardProgress,
  LocalMediaCardSkeleton,
} from "../src/shared/components/LocalMediaCard";

describe("本地媒体卡片", () => {
  test("录制与下载共享封面、标题、状态与独立操作区", () => {
    for (const kind of ["recording", "download"] as const) {
      const html = renderToStaticMarkup(
        createElement(LocalMediaCard, {
          kind,
          title: "本地视频",
          subtitle: "来源",
          status: "已完成",
          artwork: "封面",
          duration: "12:30",
          metadata: "100 MB",
          actions: createElement("button", { type: "button" }, "删除"),
        }),
      );
      expect(html).toContain(`data-local-media-card="${kind}"`);
      expect(html).toContain(">本地视频</h3>");
      expect(html).not.toContain('data-slot="card-footer"');
      expect(html).toContain("data-local-media-actions");
      // 窄容器封面收紧到 5rem，宽容器仍保留 11rem。
      expect(html).toContain("grid-cols-[5rem_minmax(0,1fr)_auto]");
      expect(html).toContain("@min-[36rem]/local-media-card:grid-cols-[11rem_minmax(0,1fr)_auto]");
      expect(html).toContain("pointer-events-auto");
      expect(html).toContain("12:30");
      expect(html).not.toContain("motion-card");
    }
  });

  test("窄屏画质、大小与进度跨封面+正文两列，宽容器收回正文列", () => {
    const html = renderToStaticMarkup(
      createElement(LocalMediaCard, {
        kind: "download",
        title: "本地视频",
        subtitle: "作者",
        status: "下载中",
        artwork: null,
        metadata: createElement("span", { "data-meta": true }, "1080P / 100 MB"),
        progress: createElement("div", { "data-progress": true }, "50%"),
        actions: null,
      }),
    );
    // 正文只放标题、状态、作者；metadata 与 progress 放在同一个跨列容器里。
    const contentStart = html.indexOf('data-slot="card-content"');
    const actionsStart = html.indexOf("data-local-media-actions");
    const meta = html.slice(contentStart, actionsStart);
    expect(meta).toContain("1080P / 100 MB");
    expect(meta).toContain('data-progress="true"');
    expect(meta).toContain("50%");
    const metaClass = html.match(/<div\b[^>]*data-slot="card-content"[^>]*class="([^"]*)"/)?.[1];
    expect(metaClass).toContain("col-span-2");
    expect(metaClass).toContain("@min-[36rem]/local-media-card:col-span-1");
    // 宽容器下封面跨两行，meta 回到封面右侧的正文列。
    expect(html).toContain("@min-[36rem]/local-media-card:row-span-2");
  });

  test("窄屏标题独占整列、状态与作者同一行，宽屏恢复标题+状态并排", () => {
    const html = renderToStaticMarkup(
      createElement(LocalMediaCard, {
        kind: "download",
        title: "标题很长的一集视频",
        subtitle: "作者名",
        status: createElement("span", { "data-status": true }, "已完成"),
        artwork: null,
        metadata: null,
        actions: null,
      }),
    );
    const header = html.slice(
      html.indexOf('data-slot="card-header"'),
      html.indexOf('data-slot="card-content"'),
    );
    // 单个状态节点：窄屏与作者同在第 2 行，宽屏移回标题所在第 1 行。
    expect(header.match(/data-status/g)).toHaveLength(1);
    const statusTag = header.match(/<div\b[^>]*>\s*<span data-status/)?.[0];
    expect(statusTag).toContain("col-start-2");
    expect(statusTag).toContain("row-start-2");
    expect(statusTag).toContain("@min-[36rem]/local-media-card:row-start-1");
    expect(header).toContain("col-start-1 row-start-2");
    // 标题窄屏跨两列铺满正文，宽屏收回一列给状态让位。
    const titleTag = header.match(/<div\b[^>]*data-slot="card-title"[^>]*>/)?.[0];
    expect(titleTag).toContain("col-span-2");
    expect(titleTag).toContain("@min-[36rem]/local-media-card:col-span-1");
    // 字号挂在原生 h3 上做容器响应：窄屏 14px、宽屏 16px，并保留紧凑行高，
    // 不改 Card 基础组件。
    expect(html).toContain(
      '<h3 class="text-sm leading-snug @min-[36rem]/local-media-card:text-base">',
    );
    // 宽屏作者跨满正文两列，不被上一行的 Badge 列继续挤窄。
    const descTag = header.match(/<div\b[^>]*data-slot="card-description"[^>]*>/)?.[0];
    expect(descTag).toContain("@min-[36rem]/local-media-card:col-span-2");
    // 保留默认 Card：size=sm 的 text-xs 变体类虽由基础组件静态带上，但不会生效，
    // 作者与元信息保持 14px、宽屏标题保持 16px。
    expect(html).toContain('data-size="default"');
    expect(html).not.toContain('data-size="sm"');
  });

  test("骨架复用紧凑网格，按操作数量占位而非固定三枚纵向撑高", () => {
    const html = renderToStaticMarkup(createElement(LocalMediaCardSkeleton));
    expect(html).toContain("grid-cols-[5rem_minmax(0,1fr)_auto]");
    expect(html).toContain("col-span-2");
    expect(html).toContain("@min-[36rem]/local-media-card:row-span-2");
    // 默认两枚操作占位（下载窄屏），加上 1 封面 + 3 头部 + 3 元信息 = 9。
    expect(html.match(/data-slot="skeleton"/g)).toHaveLength(9);
    const three = renderToStaticMarkup(createElement(LocalMediaCardSkeleton, { actionCount: 3 }));
    expect(three.match(/data-slot="skeleton"/g)).toHaveLength(10);
  });

  test("可播放卡片保留独立整卡入口与已有按下动效", () => {
    const html = renderToStaticMarkup(
      createElement(LocalMediaCard, {
        kind: "recording",
        title: "录播",
        subtitle: "来源",
        status: "已保存",
        artwork: null,
        metadata: null,
        actions: null,
        playbackTrigger: createElement("button", {
          "aria-label": "打开录播",
          "data-motion-press": true,
        }),
      }),
    );
    expect(html).toContain("motion-card");
    expect(html).toContain('aria-label="打开录播"');
    expect(html).toContain("has-[:focus-visible]:ring-2");
  });

  test("下载和观看进度共享可访问范围，异常数值不会溢出", () => {
    for (const [value, expected] of [
      [-10, 0],
      [200, 100],
      [Number.NaN, 0],
      [45.5, 46],
    ]) {
      const html = renderToStaticMarkup(
        createElement(LocalMediaCardProgress, { value, label: "下载进度" }),
      );
      expect(html).toContain('role="progressbar"');
      expect(html).toContain(`aria-valuenow="${expected}"`);
      expect(html).toContain('aria-label="下载进度"');
    }
  });

  test("右侧图标按钮处理中禁用点击，操作名称只用于可访问提示", () => {
    const html = renderToStaticMarkup(
      createElement(LocalMediaCardAction, {
        label: "正在保存",
        icon: Square,
        busy: true,
      }),
    );
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("disabled");
    expect(html).toContain("正在保存");
    const buttonContent = html.match(/<button\b[^>]*>([\s\S]*?)<\/button>/)?.[1];
    expect(buttonContent).toBeDefined();
    expect(buttonContent).not.toContain("正在保存");
  });
});
