import { describe, expect, test } from "bun:test";
import {
  HOME_ENTRY_IDS,
  isHomeEntryId,
  normalizeHiddenHomeEntryIds,
  updateHiddenHomeEntryIds,
} from "../src/shared/navEntries";
import { SIDEBAR_NAV_ITEMS, sidebarNavItemsFor } from "../src/app/layout/sidebarNavigation";

describe("home entry ids", () => {
  test("exposes only the content destinations users may hide", () => {
    // 首页、关注、设置是应用骨架，绝不能被隐藏。
    expect(HOME_ENTRY_IDS).toEqual(["video", "shorts", "iptv"]);
    expect(HOME_ENTRY_IDS).not.toContain("home" as never);
  });

  test("recognizes known ids and rejects everything else", () => {
    expect(isHomeEntryId("video")).toBe(true);
    expect(isHomeEntryId("shorts")).toBe(true);
    expect(isHomeEntryId("iptv")).toBe(true);
    expect(isHomeEntryId("history")).toBe(false);
    expect(isHomeEntryId("home")).toBe(false);
    expect(isHomeEntryId(42)).toBe(false);
    expect(isHomeEntryId(null)).toBe(false);
  });

  test("drops unknown ids and duplicates, then returns the canonical order", () => {
    // 输入顺序与重复项都不应影响持久化结果：normalize 后按 HOME_ENTRY_IDS 排序。
    expect(normalizeHiddenHomeEntryIds(["iptv", "video", "iptv", "history", "video"])).toEqual([
      "video",
      "iptv",
    ]);
  });

  test("treats malformed persisted values as no hidden entries", () => {
    expect(normalizeHiddenHomeEntryIds(undefined)).toEqual([]);
    expect(normalizeHiddenHomeEntryIds(null)).toEqual([]);
    expect(normalizeHiddenHomeEntryIds("video")).toEqual([]);
    expect(normalizeHiddenHomeEntryIds({ video: true })).toEqual([]);
  });

  test("toggles one entry without disturbing the others", () => {
    expect(updateHiddenHomeEntryIds([], "shorts", false)).toEqual(["shorts"]);
    expect(updateHiddenHomeEntryIds(["shorts"], "shorts", true)).toEqual([]);
    expect(updateHiddenHomeEntryIds(["shorts"], "iptv", false)).toEqual(["shorts", "iptv"]);
    // 重复切换同一入口保持幂等。
    expect(updateHiddenHomeEntryIds(["shorts"], "shorts", false)).toEqual(["shorts"]);
  });
});

describe("sidebar visibility follows the home entry preference", () => {
  test("hides exactly the requested entries on both clients", () => {
    for (const mobileClient of [true, false]) {
      const visible = sidebarNavItemsFor(mobileClient, ["video", "iptv"]).map((item) => item.to);
      expect(visible).not.toContain("/video");
      expect(visible).not.toContain("/iptv");
      expect(visible).toContain("/shorts");
    }
  });

  test("keeps the core destinations regardless of hidden entries", () => {
    const visible = sidebarNavItemsFor(false, ["video", "shorts", "iptv"]).map((item) => item.to);
    expect(visible).toEqual([
      "/",
      "/follow",
      "/multi-room",
      "/recordings",
      "/history",
      "/settings",
    ]);
  });

  test("ignores unknown hidden ids instead of dropping entries", () => {
    expect(sidebarNavItemsFor(false, ["history", "settings", "unknown"])).toEqual(
      SIDEBAR_NAV_ITEMS,
    );
  });

  test("still gates desktop-only entries out of the mobile navigation", () => {
    const mobile = sidebarNavItemsFor(true, []).map((item) => item.to);
    expect(mobile).toEqual(["/", "/follow", "/video", "/shorts", "/iptv", "/settings"]);
  });
});
