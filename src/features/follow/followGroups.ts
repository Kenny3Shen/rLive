import type { FollowUser } from "@/shared/types/live";

export const FOLLOW_GROUPS_QUERY_KEY = ["follow-groups"] as const;
export const ALL_FOLLOW_GROUP_ID = "__all__";
export const UNGROUPED_FOLLOW_GROUP_ID = "__ungrouped__";

export type FollowGroup = {
  id: string;
  name: string;
};

export function followIdentity(follow: Pick<FollowUser, "site_id" | "room_id">): string {
  return `${follow.site_id}\u0000${follow.room_id}`;
}

export function followGroupId(
  follow: Pick<FollowUser, "tag_ids">,
  groups: readonly FollowGroup[],
): string {
  const existingIds = new Set(groups.map((group) => group.id));
  return follow.tag_ids.find((id) => existingIds.has(id)) ?? UNGROUPED_FOLLOW_GROUP_ID;
}

export function tagIdsForFollowGroup(groupId: string): string[] {
  return groupId === UNGROUPED_FOLLOW_GROUP_ID ? [] : [groupId];
}

export function followBelongsToGroup(
  follow: Pick<FollowUser, "tag_ids">,
  groupId: string,
  groups: readonly FollowGroup[],
): boolean {
  return groupId === ALL_FOLLOW_GROUP_ID || followGroupId(follow, groups) === groupId;
}

export function sortFollowGroups(groups: readonly FollowGroup[]): FollowGroup[] {
  return [...groups].sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

export function sortFollowsByStatus(follows: readonly FollowUser[]): FollowUser[] {
  return [...follows].sort((a, b) => {
    const rank = (follow: FollowUser) =>
      follow.live_status === true ? 0 : follow.live_status === false ? 1 : 2;
    const statusDifference = rank(a) - rank(b);
    if (statusDifference !== 0) return statusDifference;
    return a.user_name.localeCompare(b.user_name, "zh");
  });
}
