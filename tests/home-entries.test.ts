import { describe, expect, test } from "bun:test";
import {
  HOME_ENTRY_IDS,
  normalizeHiddenHomeEntryIds,
  updateHiddenHomeEntryIds,
} from "../src/shared/navEntries";
import { sidebarNavItemsFor } from "../src/app/layout/sidebarNavigation";
describe("home entry ids", () => {
  test("only video and iptv remain configurable destinations", () => {
    expect([...HOME_ENTRY_IDS]).toEqual(["video", "iptv"]);
  });
  test("drops unknown ids and duplicates, then returns the canonical order", () => {
    // 输入顺序与重复项都不应影响持久化结果：normalize 后按 HOME_ENTRY_IDS 排序。
    expect(normalizeHiddenHomeEntryIds(["iptv", "video", "iptv", "history", "video"])).toEqual([
      "video",
      "iptv",
    ]);
  });
  test("drops the retired shorts id from persisted settings", () => {
    // 短视频不再占导航入口；旧设置里的 shorts 值在净化时被丢弃，
    // Rust 侧仍接受该 id，因此读取不会失败。
    expect(normalizeHiddenHomeEntryIds(["shorts", "video"])).toEqual(["video"]);
    expect(normalizeHiddenHomeEntryIds(["shorts"])).toEqual([]);
  });
  test("toggles one entry without disturbing the others", () => {
    expect(updateHiddenHomeEntryIds([], "iptv", false)).toEqual(["iptv"]);
    expect(updateHiddenHomeEntryIds(["iptv"], "iptv", true)).toEqual([]);
    expect(updateHiddenHomeEntryIds(["video"], "iptv", false)).toEqual(["video", "iptv"]);
    // 重复切换同一入口保持幂等。
    expect(updateHiddenHomeEntryIds(["video"], "video", false)).toEqual(["video"]);
  });
});
describe("sidebar visibility follows the home entry preference", () => {
  test("hides exactly the requested entries on both clients", () => {
    for (const mobileClient of [true, false]) {
      const visible = sidebarNavItemsFor(mobileClient, ["video", "iptv"]).map((item) => item.to);
      expect(visible).not.toContain("/video");
      expect(visible).not.toContain("/iptv");
      expect(visible).toContain("/follow");
      expect(visible).toContain("/settings");
    }
  });
  test("still gates desktop-only entries out of the mobile navigation", () => {
    const mobile = sidebarNavItemsFor(true, []).map((item) => item.to);
    expect(mobile).toEqual(["/", "/follow", "/video", "/iptv", "/settings"]);
  });
  test("no longer exposes a standalone shorts destination", () => {
    for (const mobileClient of [true, false]) {
      expect(sidebarNavItemsFor(mobileClient, []).map((item) => item.to)).not.toContain("/shorts");
    }
  });
});
