import { describe, expect, test } from "bun:test";
import {
  ALL_FOLLOW_GROUP_ID,
  followBelongsToGroup,
  followGroupId,
  followIdentity,
  sortFollowGroups,
  sortFollowsByStatus,
  tagIdsForFollowGroup,
  UNGROUPED_FOLLOW_GROUP_ID,
  type FollowGroup,
} from "../src/features/follow/followGroups";
import type { FollowUser } from "../src/shared/types/live";

const groups: FollowGroup[] = [
  { id: "games", name: "游戏" },
  { id: "music", name: "音乐" },
];

function follow(overrides: Partial<FollowUser> = {}): FollowUser {
  return {
    site_id: "bilibili",
    room_id: "1",
    user_name: "主播",
    face: "",
    tag_ids: [],
    auto_record: false,
    live_status: null,
    live_started_at: null,
    updated_at: 1,
    ...overrides,
  };
}

describe("follow groups", () => {
  test("uses the first existing legacy tag and ignores stale tag ids", () => {
    expect(followGroupId(follow({ tag_ids: ["missing", "music", "games"] }), groups)).toBe(
      "music",
    );
    expect(followGroupId(follow({ tag_ids: ["missing"] }), groups)).toBe(
      UNGROUPED_FOLLOW_GROUP_ID,
    );
  });

  test("maps the ungrouped destination to an empty persisted tag list", () => {
    expect(tagIdsForFollowGroup(UNGROUPED_FOLLOW_GROUP_ID)).toEqual([]);
    expect(tagIdsForFollowGroup("games")).toEqual(["games"]);
  });

  test("matches all, named, and ungrouped views", () => {
    const grouped = follow({ tag_ids: ["games"] });
    const ungrouped = follow({ tag_ids: [] });

    expect(followBelongsToGroup(grouped, ALL_FOLLOW_GROUP_ID, groups)).toBe(true);
    expect(followBelongsToGroup(grouped, "games", groups)).toBe(true);
    expect(followBelongsToGroup(grouped, "music", groups)).toBe(false);
    expect(followBelongsToGroup(ungrouped, UNGROUPED_FOLLOW_GROUP_ID, groups)).toBe(true);
  });

  test("sorts live streamers first and keeps stable room identities", () => {
    const offline = follow({ room_id: "2", user_name: "乙", live_status: false });
    const live = follow({ room_id: "3", user_name: "丙", live_status: true });
    const unknown = follow({ room_id: "4", user_name: "甲", live_status: null });

    expect(sortFollowsByStatus([offline, unknown, live]).map((item) => item.room_id)).toEqual([
      "3",
      "2",
      "4",
    ]);
    expect(followIdentity(live)).toBe("bilibili\u00003");
  });

  test("sorts group names for a predictable navigation order", () => {
    expect(
      sortFollowGroups([
        { id: "later", name: "Beta" },
        { id: "first", name: "Alpha" },
      ]).map((group) => group.id),
    ).toEqual(["first", "later"]);
  });
});
