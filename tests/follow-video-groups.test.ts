import { describe, expect, test } from "bun:test";
import {
  UNGROUPED_VIDEO_FOLLOW_ID,
  videoFollowBelongsToGroup,
  videoFollowGroupFromSearch,
  videoFollowGroupId,
  videoFollowGroups,
  withVideoFollowGroup,
} from "../src/features/follow/videoFollowGroups";
import { followViewFromSearch, withFollowView } from "../src/features/follow/followRoute";
import type { VideoFollow, VideoFollowGroup } from "../src/features/video/videoFollows";

const groups: VideoFollowGroup[] = [
  { id: "games", name: "游戏" },
  { id: "music", name: "音乐" },
];

function follow(overrides: Partial<VideoFollow> = {}): VideoFollow {
  return {
    site_id: "bilibili",
    mid: "1",
    name: "UP 主",
    face: null,
    group_id: null,
    updated_at: 1,
    ...overrides,
  };
}

describe("video follow groups", () => {
  test("recognizes the video view and keeps view switches isolated from group state", () => {
    expect(followViewFromSearch("video")).toBe("video");
    expect(followViewFromSearch("iptv")).toBe("iptv");
    expect(followViewFromSearch("unknown")).toBe("live");
    expect(
      withFollowView(
        new URLSearchParams("view=video&videoGroup=games&platform=bilibili"),
        "iptv",
      ).toString(),
    ).toBe("view=iptv&videoGroup=games&platform=bilibili");
  });

  test("treats deleted groups as ungrouped", () => {
    expect(videoFollowGroupId(follow({ group_id: "music" }), groups)).toBe("music");
    expect(videoFollowGroupId(follow({ group_id: "missing" }), groups)).toBe(
      UNGROUPED_VIDEO_FOLLOW_ID,
    );
  });

  test("counts custom and ungrouped UP owners independently", () => {
    expect(
      videoFollowGroups(
        [
          follow({ mid: "1", group_id: "games" }),
          follow({ mid: "2", group_id: "games" }),
          follow({ mid: "3", group_id: null }),
          follow({ mid: "4", group_id: "missing" }),
        ],
        groups,
      ),
    ).toEqual([
      { id: "games", name: "游戏", count: 2 },
      { id: "music", name: "音乐", count: 0 },
      { id: UNGROUPED_VIDEO_FOLLOW_ID, name: "未分组", count: 2 },
    ]);
  });

  test("matches all, custom, and ungrouped views", () => {
    const grouped = follow({ group_id: "games" });
    const ungrouped = follow({ group_id: null });
    expect(videoFollowBelongsToGroup(grouped, null, groups)).toBe(true);
    expect(videoFollowBelongsToGroup(grouped, "games", groups)).toBe(true);
    expect(videoFollowBelongsToGroup(grouped, "music", groups)).toBe(false);
    expect(videoFollowBelongsToGroup(ungrouped, UNGROUPED_VIDEO_FOLLOW_ID, groups)).toBe(true);
  });

  test("normalizes stale group parameters without disturbing unrelated state", () => {
    expect(videoFollowGroupFromSearch("music", groups)).toBe("music");
    expect(videoFollowGroupFromSearch(UNGROUPED_VIDEO_FOLLOW_ID, groups)).toBe(
      UNGROUPED_VIDEO_FOLLOW_ID,
    );
    expect(videoFollowGroupFromSearch("missing", groups)).toBeNull();
    const params = withVideoFollowGroup(
      new URLSearchParams("view=video&platform=bilibili&videoGroup=music"),
      UNGROUPED_VIDEO_FOLLOW_ID,
    );
    expect(params.toString()).toBe(
      "view=video&platform=bilibili&videoGroup=__video_follow_ungrouped__",
    );
    expect(withVideoFollowGroup(params, null).toString()).toBe("view=video&platform=bilibili");
  });
});
