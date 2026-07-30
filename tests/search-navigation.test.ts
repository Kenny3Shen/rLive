import { describe, expect, test } from "bun:test";
import {
  categoryHomePathAfterSiteChange,
  categoryNameFromSearch,
  categoryRoomsPath,
} from "../src/features/category/categoryRoute";
import {
  canSearchNavigateBack,
  parseSearchScope,
  prepareSearchResults,
  searchMatch,
  searchPath,
} from "../src/features/search/search";
import type { LiveRoomItem } from "../src/shared/types/live";

const rooms: LiveRoomItem[] = [
  {
    site_id: "bilibili",
    room_id: "7788",
    title: "深夜游戏直播",
    cover: "",
    user_name: "小蓝",
    online: 1,
  },
  {
    site_id: "bilibili",
    room_id: "1001",
    title: "日常聊天",
    cover: "",
    user_name: "游戏主播",
    online: 2,
  },
  {
    site_id: "bilibili",
    room_id: "1002",
    title: "游戏实况",
    cover: "",
    user_name: "小红",
    online: 3,
  },
];

describe("search routes and result fields", () => {
  test("keeps the selected search field in a shareable URL", () => {
    expect(searchPath(" 小蓝 ", "user")).toBe("/search?q=%E5%B0%8F%E8%93%9D&scope=user");
    expect(searchPath("", "title")).toBe("/search");
    expect(parseSearchScope("room")).toBe("room");
    expect(parseSearchScope("unknown")).toBe("all");
  });

  test("returns to the preceding in-app page and safely falls back for direct links", () => {
    expect(canSearchNavigateBack({ idx: 1 })).toBe(true);
    expect(canSearchNavigateBack({ idx: 0 })).toBe(false);
    expect(canSearchNavigateBack({ idx: "1" })).toBe(false);
    expect(canSearchNavigateBack(null)).toBe(false);
  });

  test("filters a broad site response by user, room number, or title", () => {
    expect(prepareSearchResults(rooms, "游戏", "user").map((room) => room.room_id)).toEqual([
      "1001",
    ]);
    expect(prepareSearchResults(rooms, "778", "room").map((room) => room.room_id)).toEqual([
      "7788",
    ]);
    expect(prepareSearchResults(rooms, "游戏", "title").map((room) => room.room_id)).toEqual([
      "1002",
      "7788",
    ]);
  });

  test("labels and ranks exact room-number matches before broad matches", () => {
    expect(searchMatch(rooms[0], "7788")).toBe("room");
    expect(searchMatch(rooms[1], "主播")).toBe("user");
    expect(searchMatch(rooms[2], "实况")).toBe("title");
    expect(
      prepareSearchResults([...rooms, rooms[0]], "7788", "all").map((room) => room.room_id),
    ).toEqual(["7788", "1001", "1002"]);
  });
});

describe("category route", () => {
  test("opens a route carrying the category identity and display name", () => {
    const path = categoryRoomsPath({
      id: "101,2",
      parent_id: "7",
      name: "和平 精英",
      pic: null,
    });
    const url = new URL(path, "https://rlive.local");

    expect(url.pathname).toBe("/category/7/101%2C2");
    expect(url.searchParams.get("name")).toBe("和平 精英");
    expect(categoryNameFromSearch("  和平精英  ")).toBe("和平精英");
  });

  test("returns to the category browser when a platform changes from a child page", () => {
    expect(categoryHomePathAfterSiteChange("/category/7/101%2C2")).toBe("/category");
    expect(categoryHomePathAfterSiteChange("/category/7/101%2C2/")).toBe("/category");
    expect(categoryHomePathAfterSiteChange("/category")).toBeNull();
    expect(categoryHomePathAfterSiteChange("/search")).toBeNull();
  });
});
