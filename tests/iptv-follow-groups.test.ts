import { describe, expect, test } from "bun:test";
import {
  FOLLOW_IPTV_GROUP_PARAM,
  FOLLOW_IPTV_SOURCE_PARAM,
  IPTV_FOLLOW_UNGROUPED_ID,
  IPTV_M3U_UNCATEGORIZED_NAME,
  iptvFavoriteBelongsToGroup,
  iptvFavoriteGroupId,
  iptvFollowGroupFromSearch,
  iptvFollowGroups,
  iptvM3uGroupName,
  withIptvFollowGroup,
  withIptvFollowSource,
} from "../src/features/follow/iptvFollowGroups";
import type { IptvFavorite, IptvFavoriteGroup } from "../src/features/iptv/favorites";

const groups: IptvFavoriteGroup[] = [
  { id: "news", name: "新闻" },
  { id: "sports", name: "体育" },
];

function favorite(
  name: string,
  m3uGroup: string,
  favoriteGroupId: string | null = null,
): IptvFavorite {
  return {
    id: name,
    name,
    group: m3uGroup,
    favorite_group_id: favoriteGroupId,
    logo: null,
    url: `https://media.example.test/${encodeURIComponent(name)}.m3u8`,
    protocol: "hls",
    headers: {},
    source_id: "chinese",
    updated_at: 1,
  };
}

describe("IPTV follow groups", () => {
  test("keeps M3U categories separate from custom groups", () => {
    expect(iptvM3uGroupName(favorite("CCTV-1", "  综合  "))).toBe("综合");
    expect(iptvM3uGroupName(favorite("测试频道", "   "))).toBe(IPTV_M3U_UNCATEGORIZED_NAME);
  });

  test("aggregates custom group counts and keeps ungrouped last", () => {
    const result = iptvFollowGroups(
      [
        favorite("新闻一台", "综合", "news"),
        favorite("新闻二台", "国内", "news"),
        favorite("未分组频道", "体育"),
      ],
      groups,
    );

    expect(result).toEqual([
      { id: "news", name: "新闻", count: 2 },
      { id: "sports", name: "体育", count: 0 },
      { id: IPTV_FOLLOW_UNGROUPED_ID, name: "未分组", count: 1 },
    ]);
  });

  test("treats missing group references as ungrouped", () => {
    const orphan = favorite("旧频道", "综合", "removed-group");
    expect(iptvFavoriteGroupId(orphan, groups)).toBe(IPTV_FOLLOW_UNGROUPED_ID);
    expect(iptvFavoriteBelongsToGroup(orphan, IPTV_FOLLOW_UNGROUPED_ID, groups)).toBe(true);
    expect(iptvFavoriteBelongsToGroup(orphan, "news", groups)).toBe(false);
    expect(iptvFavoriteBelongsToGroup(orphan, null, groups)).toBe(true);
  });

  test("accepts only stable group ids present in the current options", () => {
    const options = iptvFollowGroups([favorite("新闻频道", "新闻", "news")], groups);

    expect(iptvFollowGroupFromSearch("news", options)).toBe("news");
    expect(iptvFollowGroupFromSearch("新闻", options)).toBeNull();
    expect(iptvFollowGroupFromSearch(null, options)).toBeNull();
  });

  test("updates the group parameter without dropping the follow view", () => {
    const current = new URLSearchParams("view=iptv&platform=all");
    const selected = withIptvFollowGroup(current, "news");

    expect(selected.get(FOLLOW_IPTV_GROUP_PARAM)).toBe("news");
    expect(selected.get("view")).toBe("iptv");
    expect(selected.get("platform")).toBe("all");
    expect(withIptvFollowGroup(selected, null).has(FOLLOW_IPTV_GROUP_PARAM)).toBe(false);
  });

  test("updates the IPTV source without dropping the follow view or custom group", () => {
    const current = new URLSearchParams("view=iptv&group=news");
    const mainland = withIptvFollowSource(current, "mainland");

    expect(mainland.get(FOLLOW_IPTV_SOURCE_PARAM)).toBe("mainland");
    expect(mainland.get("view")).toBe("iptv");
    expect(mainland.get("group")).toBe("news");
    expect(withIptvFollowSource(mainland, "chinese").has(FOLLOW_IPTV_SOURCE_PARAM)).toBe(false);
  });
});
