import { describe, expect, test } from "bun:test";
import { normalizeHiddenHomeEntryIds, updateHiddenHomeEntryIds } from "../src/shared/navEntries";
import { sidebarNavItemsFor } from "../src/app/layout/sidebarNavigation";
describe("home entry ids", () => {
  test("drops unknown ids and duplicates, then returns the canonical order", () => {
    // 输入顺序与重复项都不应影响持久化结果：normalize 后按 HOME_ENTRY_IDS 排序。
    expect(normalizeHiddenHomeEntryIds(["iptv", "video", "iptv", "history", "video"])).toEqual([
      "video",
      "iptv",
    ]);
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
  test("still gates desktop-only entries out of the mobile navigation", () => {
    const mobile = sidebarNavItemsFor(true, []).map((item) => item.to);
    expect(mobile).toEqual(["/", "/follow", "/video", "/shorts", "/iptv", "/settings"]);
  });
});
