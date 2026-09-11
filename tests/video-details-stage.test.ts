import { describe, expect, test } from "bun:test";

const source = await Bun.file(
  new URL("../src/features/video/VideoPlayerPage.tsx", import.meta.url),
).text();

describe("video details stage layout", () => {
  test("details mode adapts stage aspect ratio based on video resolution", () => {
    // 播放器占比基于视频分辨率 (16:9 或 9:16) 自动切换，不再永远只占 16:9 固定大小。
    expect(source).toContain("aspect-[9/16]");
    expect(source).toContain("aspect-video");
  });

  test("the immersive branch still lets the stage fill the window", () => {
    // 沉浸（短视频/网页全屏）与桌面 lg 分支不受影响。
    expect(source).toContain('"aspect-auto max-h-none flex-1"');
    expect(source).toContain('"lg:aspect-auto lg:w-auto lg:flex-1"');
  });

  test("VOD settings panel contains playback rates", () => {
    // 包含 0.25, 0.5, 1, 1.5, 2 播放倍数
    expect(source).toContain("VOD_PLAYBACK_RATES = [0.25, 0.5, 1, 1.5, 2]");
    expect(source).toContain("播放倍数");
  });

  test("video player top HUD uses shared HUD button styling and centered title line", () => {
    expect(source).toContain("className={PLAYER_HUD_BUTTON_CLASS}");
    expect(source).toContain("flex h-media-control min-w-0 flex-1 items-center px-1");
  });

  test("desktop manual enter short video button is removed", () => {
    expect(source).not.toContain("进入刷视频模式");
  });
});
