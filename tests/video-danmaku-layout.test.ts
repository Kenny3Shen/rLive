import { describe, expect, test } from "bun:test";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VideoDanmakuLayer } from "../src/features/video/VideoDanmakuLayer";

const page = await Bun.file(
  new URL("../src/features/video/VideoPlayerPage.tsx", import.meta.url),
).text();

// 实际尺寸、HUD 显隐和 ResizeObserver 回归由 video-danmaku-layout.browser.js 覆盖。
describe("video danmaku layout", () => {
  test("only mobile short-video mode reserves the top HUD", () => {
    expect(page).toContain("useVideoDanmakuTopInset(stageRef, hudRef, shortVideo && mobileClient)");
  });

  test("the layer stretches between its insets without forcing full height", () => {
    const html = renderToStaticMarkup(
      createElement(VideoDanmakuLayer, {
        videoRef: createRef<HTMLVideoElement>(),
        entries: [],
        active: false,
      }),
    );
    expect(html).toContain("data-video-danmaku-layer");
    expect(html).toContain("absolute inset-0 overflow-hidden");
    expect(html).toContain("top:var(--video-danmaku-top, 0px)");
    expect(html).not.toContain("size-full");
    expect(html).not.toContain("h-full");
    expect(html).not.toContain("height:100%");
  });
});
