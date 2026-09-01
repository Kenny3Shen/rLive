import { describe, expect, test } from "bun:test";
import { roomCardLabels } from "../src/shared/components/roomCardLabels";
import type { LiveRoomItem } from "../src/shared/types/live";

function room(overrides: Partial<LiveRoomItem> = {}): LiveRoomItem {
  return {
    site_id: "bilibili",
    room_id: "1001",
    title: "直播标题",
    cover: "https://example.com/c.jpg",
    user_name: "主播",
    online: 1234,
    ...overrides,
  };
}

describe("room card labels", () => {
  test("keeps title and anchor on two lines for live rooms", () => {
    expect(roomCardLabels(room())).toEqual({
      offline: false,
      primaryText: "直播标题",
      secondaryText: "主播",
      showOnline: true,
    });
  });

  test("promotes the anchor name and states the status for offline rooms", () => {
    // 未开播的搜索结果没有直播标题，热度也不可信。
    expect(roomCardLabels(room({ title: "", online: 0, live_status: false }))).toEqual({
      offline: true,
      primaryText: "主播",
      secondaryText: "未开播",
      showOnline: false,
    });
  });

  test("treats a missing status as unknown rather than offline", () => {
    // 分类/推荐列表不下发开播状态，不能因此显示「未开播」。
    const labels = roomCardLabels(room({ live_status: null }));
    expect(labels.offline).toBe(false);
    expect(labels.secondaryText).toBe("主播");
  });

  test("hides the heat chip when the platform reports no viewers", () => {
    // 人数 0 时不硬显示一个「0」，那既不准也没信息量。
    expect(roomCardLabels(room({ online: 0 })).showOnline).toBe(false);
  });

  test("falls back to placeholders when both title and anchor are empty", () => {
    const labels = roomCardLabels(room({ title: "  ", user_name: "  " }));
    expect(labels.primaryText).toBe("未命名直播间");
    expect(labels.secondaryText).toBe("");
  });
});
