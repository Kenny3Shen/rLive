import type { IptvFavorite, IptvFavoriteGroup } from "@/features/iptv/favorites";
import { DEFAULT_PLAYLIST_SOURCE } from "@/features/iptv/playlistSource";

export const FOLLOW_IPTV_GROUP_PARAM = "group";
export const FOLLOW_IPTV_SOURCE_PARAM = "source";
export const IPTV_FOLLOW_UNGROUPED_NAME = "未分组";
export const IPTV_FOLLOW_UNGROUPED_ID = "__iptv_follow_ungrouped__";
export const IPTV_M3U_UNCATEGORIZED_NAME = "未分类";

export type IptvFollowGroup = IptvFavoriteGroup & {
  count: number;
};

export function iptvM3uGroupName(favorite: IptvFavorite): string {
  return favorite.group.trim() || IPTV_M3U_UNCATEGORIZED_NAME;
}

export function iptvFavoriteGroupId(
  favorite: IptvFavorite,
  groups: readonly IptvFavoriteGroup[],
): string {
  return favorite.favorite_group_id &&
    groups.some((group) => group.id === favorite.favorite_group_id)
    ? favorite.favorite_group_id
    : IPTV_FOLLOW_UNGROUPED_ID;
}

export function iptvFollowGroups(
  favorites: readonly IptvFavorite[],
  groups: readonly IptvFavoriteGroup[],
): IptvFollowGroup[] {
  const counts = new Map<string, number>();
  for (const favorite of favorites) {
    const id = iptvFavoriteGroupId(favorite, groups);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  return [
    ...groups.map((group) => ({ ...group, count: counts.get(group.id) ?? 0 })),
    {
      id: IPTV_FOLLOW_UNGROUPED_ID,
      name: IPTV_FOLLOW_UNGROUPED_NAME,
      count: counts.get(IPTV_FOLLOW_UNGROUPED_ID) ?? 0,
    },
  ];
}

/** `null` represents the Shell's "全部频道" option. */
export function iptvFollowGroupFromSearch(
  value: string | null,
  groups: readonly IptvFollowGroup[],
): string | null {
  return value && groups.some((group) => group.id === value) ? value : null;
}

export function iptvFavoriteBelongsToGroup(
  favorite: IptvFavorite,
  selectedGroup: string | null,
  groups: readonly IptvFavoriteGroup[],
): boolean {
  return selectedGroup === null || iptvFavoriteGroupId(favorite, groups) === selectedGroup;
}

export function withIptvFollowGroup(
  searchParams: URLSearchParams,
  group: string | null,
): URLSearchParams {
  const next = new URLSearchParams(searchParams);
  if (group) next.set(FOLLOW_IPTV_GROUP_PARAM, group);
  else next.delete(FOLLOW_IPTV_GROUP_PARAM);
  return next;
}

export function withIptvFollowSource(
  searchParams: URLSearchParams,
  sourceId: string,
): URLSearchParams {
  const next = new URLSearchParams(searchParams);
  if (sourceId === DEFAULT_PLAYLIST_SOURCE.id) next.delete(FOLLOW_IPTV_SOURCE_PARAM);
  else next.set(FOLLOW_IPTV_SOURCE_PARAM, sourceId);
  return next;
}
