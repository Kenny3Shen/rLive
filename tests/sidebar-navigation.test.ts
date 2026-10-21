import { describe, expect, test } from "bun:test";
import {
  SIDEBAR_NAVIGATION_STATE,
  isSidebarNavigation,
  routeScopedPreviousGroup,
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
    expect(
      isSidebarNavigation("PUSH", {
        rliveNavigationSource: "header",
      }),
    ).toBe(false);
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

describe("sidebar direction strip after removing the shorts destination", () => {
  test("orders video directly before iptv", () => {
    expect(sidebarNavigationDirection("/iptv", "/video")).toBe(-1);
    expect(sidebarNavigationDirection("/video", "/iptv")).toBe(1);
  });
  test("does not know the retired shorts path as a destination", () => {
    // `/shorts` 已不是侧栏目的地：它只经旧深链进入，不参与方向判定，
    // 因此与任何目的地之间都按默认的正向平移。
    expect(sidebarNavigationDirection("/settings", "/shorts")).toBe(1);
    expect(sidebarNavigationDirection("/shorts", "/settings")).toBe(1);
  });
});
