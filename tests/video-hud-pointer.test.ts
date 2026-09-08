import { describe, expect, test } from "bun:test";

const page = await Bun.file(
  new URL("../src/features/video/VideoPlayerPage.tsx", import.meta.url),
).text();

// 实际标题、留白、按钮与弹层命中由 video-hud-pointer.browser.js 覆盖。
describe("video HUD pointer events", () => {
  test("only visible enabled HUD buttons receive pointer events", () => {
    const start = page.indexOf("ref={hudRef}");
    const end = page.indexOf("onPointerEnter={holdControlsVisible}", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const hud = page.slice(start, end);
    expect(hud).toContain(
      "pointer-events-none [&[data-visible=true]_button:enabled]:pointer-events-auto",
    );
    expect(hud).not.toContain("!mobileClient &&");
  });
});
