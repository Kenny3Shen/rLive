import { describe, expect, test } from "bun:test";
import { SIDEBAR_NAVIGATION_STATE, isSidebarNavigation } from "../src/app/layout/sidebarNavigation";

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
});
