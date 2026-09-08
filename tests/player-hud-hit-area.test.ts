import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { PlayerPane } from "../src/features/room/PlayerPane";

function renderHud(userAgent: string): string {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const client = new QueryClient();
  try {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { userAgent, maxTouchPoints: 0 },
    });
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          null,
          createElement(PlayerPane, { playUrl: null, roomTitle: "顶部弹幕命中测试" }),
        ),
      ),
    );
    const hud = html.match(/<div\b[^>]*\bdata-player-hud="true"[^>]*>/)?.[0];
    if (!hud) throw new Error("未渲染顶部 HUD");
    return hud;
  } finally {
    client.clear();
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
}

describe("直播顶部 HUD 指针命中", () => {
  test("桌面标题和留白穿透，仅可见且未禁用的按钮接收指针", () => {
    const hud = renderHud("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    expect(hud).toContain('data-visible="true"');
    expect(hud).toMatch(/class="[^"]*\bpointer-events-none(?:\s|")/);
    // 恢复命中必须受显隐和禁用状态约束，不能形成透明按钮热区。
    expect(hud).toContain("[&amp;[data-visible=true]_button:enabled]:pointer-events-auto");
  });

  test.each([
    "Mozilla/5.0 (Linux; Android 14)",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
  ])("移动端保持整块 HUD 原有触摸边界：%s", (userAgent) => {
    const hud = renderHud(userAgent);
    expect(hud).not.toContain("_button:enabled]:pointer-events-auto");
    expect(hud).toContain("data-[visible=false]:pointer-events-none");
  });
});
