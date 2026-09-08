import { describe, expect, test } from "bun:test";

const source = await Bun.file(
  new URL("../src/features/video/VideoPlayerPage.tsx", import.meta.url),
).text();

describe("video details stage layout", () => {
  test("details mode shares one 16:9 stage across aspect ratios", () => {
    // 竖屏视频源的详情页曾用 9:16 容器占去大半视口，压掉了下方详情区；
    // 详情页统一 16:9 舞台后，播放器与详情区的占比对任何画幅都一致。
    expect(source).not.toContain("aspect-[9/16]");
    expect(source).toMatch(
      /shortVideo \|\| webFullscreen\s*\?\s*"aspect-auto max-h-none flex-1"\s*:\s*"aspect-video w-full max-lg:max-h-\[56%\]"/,
    );
  });

  test("the immersive branch still lets the stage fill the window", () => {
    // 沉浸（短视频/网页全屏）与桌面 lg 分支不受统一舞台影响。
    expect(source).toContain('"aspect-auto max-h-none flex-1"');
    expect(source).toContain('"lg:aspect-auto lg:w-auto lg:flex-1"');
  });
});
