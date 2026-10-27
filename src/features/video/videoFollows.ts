import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { notify } from "@/components/ui/toast";
import { invokeCmd } from "@/shared/api/tauri";
import { errorText } from "@/shared/components/errorPresentation";

/** 本地保存的 B 站 UP 主关注。与直播关注分表，不参与开播状态或自动录制。 */
export type VideoFollow = {
  site_id: "bilibili";
  mid: string;
  name: string;
  /** 上游没有公开头像时为 null；空字符串由后端归一化为 null。 */
  face: string | null;
  group_id: string | null;
  updated_at: number;
};

/** 视频关注专用分组，不与直播标签或 IPTV 频道分组共用。 */
export type VideoFollowGroup = {
  id: string;
  name: string;
};

export const VIDEO_FOLLOWS_QUERY_KEY = ["video", "follows"] as const;
export const VIDEO_FOLLOW_GROUPS_QUERY_KEY = ["video", "follow-groups"] as const;

export function videoFollowIdentity(follow: Pick<VideoFollow, "site_id" | "mid">): string {
  return `${follow.site_id}\u0000${follow.mid}`;
}

export function sortVideoFollows(follows: readonly VideoFollow[]): VideoFollow[] {
  return [...follows].sort(
    (left, right) =>
      left.name.localeCompare(right.name, "zh-CN", { numeric: true }) ||
      left.mid.localeCompare(right.mid, "en", { numeric: true }),
  );
}

export function sortVideoFollowGroups(groups: readonly VideoFollowGroup[]): VideoFollowGroup[] {
  return [...groups].sort((left, right) =>
    left.name.localeCompare(right.name, "zh-CN", { numeric: true }),
  );
}

export function useVideoFollows(enabled = true) {
  return useQuery({
    queryKey: VIDEO_FOLLOWS_QUERY_KEY,
    queryFn: () => invokeCmd<VideoFollow[]>("video_follow_list"),
    enabled,
    staleTime: 15_000,
    select: sortVideoFollows,
  });
}

export function useVideoFollowGroups(enabled = true) {
  return useQuery({
    queryKey: VIDEO_FOLLOW_GROUPS_QUERY_KEY,
    queryFn: () => invokeCmd<VideoFollowGroup[]>("video_follow_group_list"),
    enabled,
    staleTime: 30_000,
    select: sortVideoFollowGroups,
  });
}

export type UpsertVideoFollowInput = {
  mid: string;
  name: string;
  face: string | null;
  groupId: string | null;
};

function replaceVideoFollow(
  current: VideoFollow[] | undefined,
  follow: VideoFollow,
): VideoFollow[] | undefined {
  if (!current) return current;
  return sortVideoFollows([
    follow,
    ...current.filter((item) => videoFollowIdentity(item) !== videoFollowIdentity(follow)),
  ]);
}

function removeVideoFollow(
  current: VideoFollow[] | undefined,
  mid: string,
): VideoFollow[] | undefined {
  return current?.filter((item) => item.mid !== mid);
}

export function useUpsertVideoFollowMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpsertVideoFollowInput) =>
      invokeCmd<VideoFollow>("video_follow_upsert", {
        siteId: "bilibili",
        mid: input.mid,
        name: input.name,
        face: input.face,
        groupId: input.groupId,
      }),
    onSuccess: (follow) => {
      queryClient.setQueryData<VideoFollow[]>(VIDEO_FOLLOWS_QUERY_KEY, (current) =>
        replaceVideoFollow(current, follow),
      );
      notify.success("已关注 UP 主", `之后可在关注页的「视频关注」中找到 ${follow.name}。`);
    },
    onError: (error) => notify.error("关注失败", errorText(error)),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: VIDEO_FOLLOWS_QUERY_KEY }),
  });
}

export function useRemoveVideoFollowMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (follow: Pick<VideoFollow, "site_id" | "mid">) =>
      invokeCmd("video_follow_remove", { siteId: follow.site_id, mid: follow.mid }),
    onSuccess: (_, follow) => {
      queryClient.setQueryData<VideoFollow[]>(VIDEO_FOLLOWS_QUERY_KEY, (current) =>
        removeVideoFollow(current, follow.mid),
      );
      notify.success("已取消关注 UP 主");
    },
    onError: (error) => notify.error("取消关注失败", errorText(error)),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: VIDEO_FOLLOWS_QUERY_KEY }),
  });
}

export function setVideoFollowGroupInList(
  current: VideoFollow[] | undefined,
  follow: Pick<VideoFollow, "site_id" | "mid">,
  groupId: string | null,
): VideoFollow[] | undefined {
  if (!current) return current;
  return current.map((item) =>
    item.site_id === follow.site_id && item.mid === follow.mid
      ? { ...item, group_id: groupId }
      : item,
  );
}

export function useSetVideoFollowGroupMutation(groups: readonly VideoFollowGroup[]) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      follow,
      groupId,
    }: {
      follow: Pick<VideoFollow, "site_id" | "mid">;
      groupId: string | null;
    }) => {
      await invokeCmd("video_follow_set_group", {
        siteId: follow.site_id,
        mid: follow.mid,
        groupId,
      });
      return { follow, groupId };
    },
    onMutate: async ({ follow, groupId }) => {
      await queryClient.cancelQueries({ queryKey: VIDEO_FOLLOWS_QUERY_KEY });
      const previous = queryClient.getQueryData<VideoFollow[]>(VIDEO_FOLLOWS_QUERY_KEY);
      queryClient.setQueryData<VideoFollow[]>(VIDEO_FOLLOWS_QUERY_KEY, (current) =>
        setVideoFollowGroupInList(current, follow, groupId),
      );
      return { previous };
    },
    onSuccess: (_, { groupId }) => {
      const groupName = groupId
        ? (groups.find((group) => group.id === groupId)?.name ?? "目标分组")
        : "未分组";
      notify.success(`已移至${groupName}`);
    },
    onError: (error, _, context) => {
      if (context?.previous) {
        queryClient.setQueryData(VIDEO_FOLLOWS_QUERY_KEY, context.previous);
      }
      notify.error("移动分组失败", errorText(error));
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: VIDEO_FOLLOWS_QUERY_KEY }),
  });
}
