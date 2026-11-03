import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Square } from "lucide-react";
import {
  LocalMediaCard,
  LocalMediaCardAction,
  LocalMediaCardProgress,
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
      expect(html).toContain("<h3>本地视频</h3>");
      expect(html).not.toContain('data-slot="card-footer"');
      expect(html).toContain("data-local-media-actions");
      expect(html).toContain("grid-cols-[7rem_minmax(0,1fr)_auto]");
      expect(html).toContain("pointer-events-auto");
      expect(html).toContain("12:30");
      expect(html).not.toContain("motion-card");
    }
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
