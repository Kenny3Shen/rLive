import type { VideoFollow, VideoFollowGroup } from "@/features/video/videoFollows";

export const VIDEO_FOLLOW_GROUP_PARAM = "videoGroup";
export const UNGROUPED_VIDEO_FOLLOW_ID = "__video_follow_ungrouped__";

export type VideoFollowGroupOption = VideoFollowGroup & {
  count: number;
};

export function videoFollowGroupId(
  follow: Pick<VideoFollow, "group_id">,
  groups: readonly VideoFollowGroup[],
): string {
  return follow.group_id && groups.some((group) => group.id === follow.group_id)
    ? follow.group_id
    : UNGROUPED_VIDEO_FOLLOW_ID;
}

export function videoFollowGroups(
  follows: readonly VideoFollow[],
  groups: readonly VideoFollowGroup[],
): VideoFollowGroupOption[] {
  const counts = new Map<string, number>();
  for (const follow of follows) {
    const id = videoFollowGroupId(follow, groups);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [
    ...groups.map((group) => ({ ...group, count: counts.get(group.id) ?? 0 })),
    {
      id: UNGROUPED_VIDEO_FOLLOW_ID,
      name: "未分组",
      count: counts.get(UNGROUPED_VIDEO_FOLLOW_ID) ?? 0,
    },
  ];
}

export function videoFollowBelongsToGroup(
  follow: Pick<VideoFollow, "group_id">,
  selectedGroup: string | null,
  groups: readonly VideoFollowGroup[],
): boolean {
  return selectedGroup === null || videoFollowGroupId(follow, groups) === selectedGroup;
}

/** `null` 表示“全部 UP 主”；未知或已删除的分组回退到全部。 */
export function videoFollowGroupFromSearch(
  value: string | null,
  groups: readonly VideoFollowGroup[],
): string | null {
  if (!value) return null;
  if (value === UNGROUPED_VIDEO_FOLLOW_ID) return value;
  return groups.some((group) => group.id === value) ? value : null;
}

export function withVideoFollowGroup(
  searchParams: URLSearchParams,
  groupId: string | null,
): URLSearchParams {
  const next = new URLSearchParams(searchParams);
  if (groupId) next.set(VIDEO_FOLLOW_GROUP_PARAM, groupId);
  else next.delete(VIDEO_FOLLOW_GROUP_PARAM);
  return next;
}
