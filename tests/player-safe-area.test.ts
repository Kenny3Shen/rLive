import { describe, expect, test } from "bun:test";

const [styles, shell, roomHud, roomPage, videoPage] = await Promise.all(
  [
    "../src/styles.css",
    "../src/app/layout/Shell.tsx",
    "../src/features/room/PlayerFullscreenHud.tsx",
    "../src/features/room/RoomPage.tsx",
    "../src/features/video/VideoPlayerPage.tsx",
  ].map((path) => Bun.file(new URL(path, import.meta.url)).text()),
);

describe("player safe-area ownership", () => {
  test("overlay routes keep the shell inset and fullscreen transition freeze", () => {
    // 原先的路由属性强制 padding-top: 0，状态栏遮住画面且压过全屏过渡冻结。
    expect(shell).not.toContain("data-overlay-top-bar");
    expect(styles).not.toContain("data-overlay-top-bar");
    expect(styles).toMatch(
      /html\[data-platform="android"\] \.app-shell\s*\{\s*padding-top: var\(--android-safe-area-top, env\(safe-area-inset-top\)\);/,
    );
    expect(styles).toMatch(
      /html\[data-fullscreen-transition="true"\] \.app-shell\s*\{\s*padding-top: var\(--fullscreen-transition-safe-area-top\) !important;/,
    );
  });

  test("normal stages do not add the shell safe area a second time", () => {
    expect(styles).toMatch(/\[data-player-stage\]\s*\{\s*--player-safe-area-top: 0px;/);
    for (const source of [roomHud, videoPage]) {
      expect(source).toContain("pt-[max(0.375rem,var(--player-safe-area-top,0px))]");
      expect(source).not.toContain("pt-[max(0.375rem,env(safe-area-inset-top))]");
    }
  });

  test("all fullscreen implementations restore the stage inset for top controls", () => {
    expect(styles).toMatch(
      /\[data-player-stage\]:fullscreen,\s*\[data-player-stage\]:-webkit-full-screen,\s*\[data-player-stage\]\[data-fullscreen="true"\]\s*\{\s*--player-safe-area-top: var\(--android-safe-area-top, env\(safe-area-inset-top\)\);\s*position: fixed;\s*inset: 0;/,
    );
  });

  test("loading and error top bars also rely on the shell inset", () => {
    for (const source of [styles, roomPage, videoPage]) {
      expect(source).not.toContain("player-page-top-bar");
    }
    for (const source of [roomPage, videoPage]) {
      expect(source).toContain('<header className="relative flex min-h-11 shrink-0');
    }
  });
});
