import { describe, expect, test } from "bun:test";
import {
  SIDEBAR_NAV_ITEMS,
  SIDEBAR_NAVIGATION_STATE,
  isSidebarNavigation,
  routeScopedPreviousGroup,
  sidebarNavItemsFor,
  sidebarNavigationDirection,
} from "../src/app/layout/sidebarNavigation";

describe("sidebar navigation transitions", () => {
  test("recognizes a direct sidebar push", () => {
    expect(isSidebarNavigation("PUSH", SIDEBAR_NAVIGATION_STATE)).toBe(true);
  });

  test("does not treat browser history or replacement navigation as a sidebar click", () => {
    expect(isSidebarNavigation("POP", SIDEBAR_NAVIGATION_STATE)).toBe(false);
    expect(isSidebarNavigation("REPLACE", SIDEBAR_NAVIGATION_STATE)).toBe(false);
  });

  test("rejects missing and malformed route state", () => {
    expect(isSidebarNavigation("PUSH", null)).toBe(false);
    expect(isSidebarNavigation("PUSH", { rliveNavigationSource: "header" })).toBe(false);
  });

  test("follows the sidebar's vertical destination order", () => {
    expect(sidebarNavigationDirection("/", "/history")).toBe(1);
    expect(sidebarNavigationDirection("/settings", "/follow")).toBe(-1);
    expect(sidebarNavigationDirection("/follow", "/iptv")).toBe(1);
    expect(sidebarNavigationDirection("/iptv", "/history")).toBe(1);
    expect(sidebarNavigationDirection("/multi-room", "/recordings")).toBe(1);
    expect(sidebarNavigationDirection("/recordings", "/history")).toBe(1);
  });

  test("places the video destination between follow and iptv in both directions", () => {
    // 方向条带漏了 `/video` 时这两条会掉：未录入的 pathname 解析成 -1，
    // 一律回落正向，从 IPTV 退回视频的平移方向于是错。
    expect(sidebarNavigationDirection("/follow", "/video")).toBe(1);
    expect(sidebarNavigationDirection("/iptv", "/video")).toBe(-1);
    expect(sidebarNavigationDirection("/video", "/settings")).toBe(1);
  });

  test("treats the video player page as part of the video destination", () => {
    // 条带按前缀匹配，`/video/play` 因此与 `/video` 同一个下标。
    expect(sidebarNavigationDirection("/video/play", "/settings")).toBe(1);
    expect(sidebarNavigationDirection("/video/play", "/follow")).toBe(-1);
  });

  test("defaults unknown source routes to the forward direction", () => {
    expect(sidebarNavigationDirection("/search", "/follow")).toBe(1);
  });
});

describe("route-scoped platform panels", () => {
  test("retains the previous platform only inside the same destination", () => {
    expect(routeScopedPreviousGroup("/", "huya", "/", "douyin")).toBe("huya");
  });

  test("starts a new destination from its own active platform", () => {
    expect(routeScopedPreviousGroup("/", "huya", "/follow", "all")).toBe("all");
  });
});

describe("sidebar nav items per client platform", () => {
  test("keeps every desktop-only entry out of the mobile navigation", () => {
    // 手机与平板横屏的视口宽度普遍超过 md 断点，
    // 视口门控（max-md:hidden）无法再阻止桌面专属入口出现在移动端。
    const mobileDestinations = sidebarNavItemsFor(true).map((item) => item.to);
    expect(mobileDestinations).toEqual(["/", "/follow", "/video", "/iptv", "/settings"]);
  });

  test("drops the category entry now that browsing lives on the home page", () => {
    expect(SIDEBAR_NAV_ITEMS.map((item) => item.to)).not.toContain("/category");
  });

  test("serves desktop clients the full destination list", () => {
    expect(sidebarNavItemsFor(false)).toEqual(SIDEBAR_NAV_ITEMS);
    expect(SIDEBAR_NAV_ITEMS.map((item) => item.to)).toContain("/multi-room");
    expect(SIDEBAR_NAV_ITEMS.map((item) => item.to)).toContain("/recordings");
  });

  test("keeps the history shortcut on desktop only now that settings owns the entry", () => {
    // 历史收进「设置 → 观看记录」后，移动端底栏不再为它留目的地；
    // 桌面竖栏仍保留快捷入口。
    expect(SIDEBAR_NAV_ITEMS.map((item) => item.to)).toContain("/history");
    expect(sidebarNavItemsFor(true).map((item) => item.to)).not.toContain("/history");
  });

  test("keeps the visual order aligned with the navigation direction strip", () => {
    const desktop = sidebarNavItemsFor(false).map((item) => item.to);
    expect(desktop.indexOf("/multi-room")).toBeLessThan(desktop.indexOf("/recordings"));
    expect(desktop.indexOf("/iptv")).toBeLessThan(desktop.indexOf("/history"));
    expect(desktop.indexOf("/follow")).toBeLessThan(desktop.indexOf("/video"));
    expect(desktop.indexOf("/video")).toBeLessThan(desktop.indexOf("/iptv"));
  });

  test("groups history and settings into the bottom footer cluster", () => {
    // 桌面竖栏里历史/设置被 mt-auto 推到底部（紧跟亮暗切换），
    // 移动端底栏里回到行内流，因此 footer 标记不改变条带顺序。
    const footer = SIDEBAR_NAV_ITEMS.filter((item) => item.footer).map((item) => item.to);
    expect(footer).toEqual(["/history", "/settings"]);
    expect(SIDEBAR_NAV_ITEMS.slice(-2).map((item) => item.to)).toEqual(footer);
  });
});
