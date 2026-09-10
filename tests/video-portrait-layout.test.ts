import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PlayerControls } from "../src/shared/components/player/PlayerControls";
import { VideoJsPlayerProvider } from "../src/features/room/player/videoJsControls";

const [page, styles, activity] = await Promise.all(
  [
    "../src/features/video/VideoPlayerPage.tsx",
    "../src/styles.css",
    "../src-tauri/gen/android/app/src/main/java/com/shenss/rlive/MainActivity.kt",
  ].map((path) => Bun.file(new URL(path, import.meta.url)).text()),
);

describe("mobile portrait video layout", () => {
  test("only mobile short-video mode separates the picture and controls", () => {
    expect(page).toContain('data-video-portrait={shortVideo && mobileClient ? "true" : undefined}');
    expect(page).toContain("data-video-viewport");
    expect(page).toContain("data-video-frame");
    expect(page).toContain("systemGestureBarReserved={shortVideo && mobileClient}");
    expect(styles).toMatch(/\[data-video-frame\]\s*\{[^}]*aspect-ratio: 9 \/ 16;/);
    expect(styles).toContain("width: min(100cqw, calc(100cqh * 9 / 16))");
  });

  test("portrait keeps system bars visible and uses native top and bottom insets", () => {
    expect(page).not.toContain("setAndroidImmersive(true)");
    expect(page).toContain('setAndroidPlayerOrientation("portrait")');
    expect(styles).toMatch(
      /\[data-player-stage\]\[data-video-portrait="true"\]\s*\{\s*--player-safe-area-top: 0px;/,
    );
    expect(styles).toContain(
      "padding-bottom: var(--android-safe-area-bottom, env(safe-area-inset-bottom))",
    );
    expect(activity).toContain(
      "WindowInsetsCompat.Type.navigationBars() or WindowInsetsCompat.Type.displayCutout()",
    );
    expect(activity).toContain("'--android-safe-area-bottom', ($bottom / window.devicePixelRatio)");
  });

  test("business controls render as an extension row without owning safe-area padding", () => {
    const render = (reserved: boolean) =>
      renderToStaticMarkup(
        createElement(
          VideoJsPlayerProvider,
          null,
          createElement(PlayerControls, {
            compact: true,
            fullscreen: true,
            systemGestureBarReserved: reserved,
          }),
        ),
      );
    expect(render(true)).toContain('data-slot="player-extension-controls"');
    expect(render(false)).toContain('data-slot="player-extension-controls"');
    expect(render(true)).not.toContain("safe-area-inset-bottom");
  });
});
