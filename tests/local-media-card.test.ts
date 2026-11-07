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
      expect(html).toContain("data-local-media-status");
      expect(html).toContain("pointer-events-auto");
      expect(html).toContain("12:30");
      expect(html.indexOf("data-local-media-actions")).toBeGreaterThan(
        html.indexOf("data-local-media-info"),
      );
      expect(html).not.toContain("motion-card");
    }
  });

  test("进度、文件信息和状态归入封面右侧的文字区", () => {
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
    const headerStart = html.indexOf('data-slot="card-header"');
    const infoStart = html.indexOf("data-local-media-info");
    const header = html.slice(headerStart, infoStart);
    const info = html.slice(infoStart, html.indexOf("data-local-media-actions"));
    expect(header).toContain("本地视频");
    expect(header).toContain("作者");
    expect(header).not.toContain("下载中");
    expect(info).toContain("1080P / 100 MB");
    expect(info).toContain('data-progress="true"');
    expect(info).toContain("下载中");
    // 进度在信息行上方，状态在信息行末尾。
    expect(info.indexOf('data-progress="true"')).toBeLessThan(info.indexOf("data-meta"));
    expect(info.indexOf("data-meta")).toBeLessThan(info.indexOf("下载中"));
    expect(html).not.toContain('data-slot="card-footer"');
  });

  test("状态只在文字区底部渲染一次", () => {
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
    const headerStart = html.indexOf('data-slot="card-header"');
    const infoStart = html.indexOf("data-local-media-info");
    const header = html.slice(headerStart, infoStart);
    const info = html.slice(infoStart, html.indexOf("data-local-media-actions"));
    expect(header).toContain("标题很长的一集视频");
    expect(header).toContain("作者名");
    expect(header).not.toContain("data-status");
    expect(info.match(/data-status/g)).toHaveLength(1);
    expect(html.match(/data-status/g)).toHaveLength(1);
    expect(info).toContain("已完成");
  });

  test("骨架复用封面、文字区和单个删除按钮结构", () => {
    const html = renderToStaticMarkup(createElement(LocalMediaCardSkeleton));
    expect(html).not.toContain('data-slot="card-footer"');
    // 封面 1 + 标题和作者 2 + 进度、文件信息和状态 3 + 删除按钮 1。
    expect(html.match(/data-slot="skeleton"/g)).toHaveLength(7);
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
