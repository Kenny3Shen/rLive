import { describe, expect, test } from "bun:test";
import {
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
