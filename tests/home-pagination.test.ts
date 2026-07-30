import { describe, expect, test } from "bun:test";
import { mergeRoomPages, nextRecommendPage } from "../src/features/home/pagination";
import type { LiveRoomItem, RoomListPage } from "../src/shared/types/live";

function room(roomId: string): LiveRoomItem {
  return {
    site_id: "bilibili",
    room_id: roomId,
    title: `直播 ${roomId}`,
    cover: "",
    user_name: "主播",
    online: 0,
  };
}

function page(items: LiveRoomItem[], hasMore = true): RoomListPage {
  return { items, has_more: hasMore };
}

describe("home recommendation pagination", () => {
  test("keeps the first occurrence of each room across changing feed pages", () => {
    expect(mergeRoomPages([page([room("1"), room("2")]), page([room("2"), room("3")])])).toEqual([
      room("1"),
      room("2"),
      room("3"),
    ]);
  });

  test("stops a reported next page when it adds no rooms", () => {
    const first = page([room("1"), room("2")]);
    const repeated = page([room("1"), room("2")]);

    expect(nextRecommendPage(first, [first], 1)).toBe(2);
    expect(nextRecommendPage(repeated, [first, repeated], 2)).toBeUndefined();
    expect(nextRecommendPage(page([room("3")], false), [first], 1)).toBeUndefined();
  });
});
