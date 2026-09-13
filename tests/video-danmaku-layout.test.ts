import { describe, expect, test } from "bun:test";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VideoDanmakuLayer } from "../src/features/video/VideoDanmakuLayer";

describe("video danmaku layout", () => {
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
