import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { notify } from "@/components/ui/toast";
import { invokeCmd } from "@/shared/api/tauri";
import type { IptvChannel } from "./types";

export type IptvFavorite = IptvChannel & {
  source_id: string;
  favorite_group_id: string | null;
  updated_at: number;
};

export type IptvFavoriteGroup = {
  id: string;
  name: string;
};

export const IPTV_FAVORITES_QUERY_KEY = ["iptv_favorites"] as const;
export const IPTV_FAVORITE_GROUPS_QUERY_KEY = ["iptv_favorite_groups"] as const;

export function iptvFavoritesQueryKey(sourceId: string) {
  return [...IPTV_FAVORITES_QUERY_KEY, sourceId] as const;
}

export function iptvFavoritesForSource(
  favorites: readonly IptvFavorite[],
  sourceId: string,
): IptvFavorite[] {
  return favorites.filter((favorite) => favorite.source_id === sourceId);
}

export function sortIptvFavoriteGroups(groups: readonly IptvFavoriteGroup[]): IptvFavoriteGroup[] {
  return [...groups].sort((left, right) =>
    left.name.localeCompare(right.name, "zh-CN", { numeric: true }),
  );
}

export function mergeFavoriteChannels(
  channels: readonly IptvChannel[],
  favorites: readonly IptvFavorite[],
): IptvChannel[] {
  const currentChannels = new Map(channels.map((channel) => [channel.url, channel]));
  return favorites.map((favorite) => currentChannels.get(favorite.url) ?? favorite);
}

export function resolveIptvChannel(
  channelUrl: string | null,
  channels: readonly IptvChannel[] | undefined,
  favorites: readonly IptvFavorite[] | undefined,
): IptvChannel | null {
  if (!channelUrl) return null;
  return (
    channels?.find((channel) => channel.url === channelUrl) ??
    favorites?.find((favorite) => favorite.url === channelUrl) ??
    null
  );
}

function favoriteFromChannel(sourceId: string, channel: IptvChannel): IptvFavorite {
  return {
    ...channel,
    source_id: sourceId,
    favorite_group_id: null,
    protocol: channel.protocol,
    updated_at: Date.now(),
  };
}

function messageFromError(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    return String(error.message);
  }
  return String(error ?? "未知错误");
}

export function useIptvFavorites(sourceId: string, enabled = true) {
  return useQuery({
    queryKey: iptvFavoritesQueryKey(sourceId),
    queryFn: () => invokeCmd<IptvFavorite[]>("iptv_favorite_list", { sourceId }),
    enabled,
    staleTime: 15_000,
  });
}

export function useAllIptvFavorites(enabled = true) {
  return useQuery({
    queryKey: IPTV_FAVORITES_QUERY_KEY,
    queryFn: () => invokeCmd<IptvFavorite[]>("iptv_favorite_list"),
    enabled,
    staleTime: 15_000,
  });
}

export function useIptvFavoriteGroups(enabled = true) {
  return useQuery({
    queryKey: IPTV_FAVORITE_GROUPS_QUERY_KEY,
    queryFn: () => invokeCmd<IptvFavoriteGroup[]>("iptv_favorite_group_list"),
    enabled,
    staleTime: 30_000,
    select: sortIptvFavoriteGroups,
  });
}

function updateFavoriteList(
  current: IptvFavorite[] | undefined,
  action: "added" | "removed",
  favorite: IptvFavorite,
): IptvFavorite[] | undefined {
  if (!current) return current;
  return action === "removed"
    ? current.filter((item) => item.source_id !== favorite.source_id || item.url !== favorite.url)
    : [
        favorite,
        ...current.filter(
          (item) => item.source_id !== favorite.source_id || item.url !== favorite.url,
        ),
      ];
}

function updateFavoriteCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  action: "added" | "removed",
  favorite: IptvFavorite,
) {
  queryClient.setQueryData<IptvFavorite[]>(iptvFavoritesQueryKey(favorite.source_id), (current) =>
    updateFavoriteList(current, action, favorite),
  );
  queryClient.setQueryData<IptvFavorite[]>(IPTV_FAVORITES_QUERY_KEY, (current) =>
    updateFavoriteList(current, action, favorite),
  );
}

export function setFavoriteGroupInList(
  current: IptvFavorite[] | undefined,
  favorite: IptvFavorite,
  groupId: string | null,
): IptvFavorite[] | undefined {
  if (!current) return current;
  return current.map((item) =>
    item.source_id === favorite.source_id && item.url === favorite.url
      ? { ...item, favorite_group_id: groupId }
      : item,
  );
}

export function useIptvFavoriteMutation(sourceId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ channel, isFavorite }: { channel: IptvChannel; isFavorite: boolean }) => {
      const favorite = favoriteFromChannel(sourceId, channel);
      if (isFavorite) {
        await invokeCmd("iptv_favorite_remove", {
          sourceId,
          channelUrl: channel.url,
        });
        return { action: "removed" as const, favorite };
      }
      await invokeCmd("iptv_favorite_add", { favorite });
      return { action: "added" as const, favorite };
    },
    onSuccess: ({ action, favorite }) => {
      updateFavoriteCaches(queryClient, action, favorite);
      notify.success(action === "added" ? "已关注频道" : "已取消关注");
    },
    onError: (error) => {
      notify.error("关注操作失败", messageFromError(error));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: IPTV_FAVORITES_QUERY_KEY });
    },
  });
}

export function useRemoveIptvFavoriteMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (favorite: IptvFavorite) => {
      await invokeCmd("iptv_favorite_remove", {
        sourceId: favorite.source_id,
        channelUrl: favorite.url,
      });
      return favorite;
    },
    onSuccess: (favorite) => {
      updateFavoriteCaches(queryClient, "removed", favorite);
      notify.success("已取消关注");
    },
    onError: (error) => {
      notify.error("取消关注失败", messageFromError(error));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: IPTV_FAVORITES_QUERY_KEY });
    },
  });
}

export function useSetIptvFavoriteGroupMutation(groups: readonly IptvFavoriteGroup[]) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      favorite,
      groupId,
    }: {
      favorite: IptvFavorite;
      groupId: string | null;
    }) => {
      await invokeCmd("iptv_favorite_set_group", {
        sourceId: favorite.source_id,
        channelUrl: favorite.url,
        groupId,
      });
      return { favorite, groupId };
    },
    onMutate: async ({ favorite, groupId }) => {
      const sourceKey = iptvFavoritesQueryKey(favorite.source_id);
      await Promise.all([
        queryClient.cancelQueries({ queryKey: IPTV_FAVORITES_QUERY_KEY }),
        queryClient.cancelQueries({ queryKey: sourceKey }),
      ]);
      const previousAll = queryClient.getQueryData<IptvFavorite[]>(IPTV_FAVORITES_QUERY_KEY);
      const previousSource = queryClient.getQueryData<IptvFavorite[]>(sourceKey);
      queryClient.setQueryData<IptvFavorite[]>(IPTV_FAVORITES_QUERY_KEY, (current) =>
        setFavoriteGroupInList(current, favorite, groupId),
      );
      queryClient.setQueryData<IptvFavorite[]>(sourceKey, (current) =>
        setFavoriteGroupInList(current, favorite, groupId),
      );
      return { previousAll, previousSource, sourceKey };
    },
    onSuccess: (_, { groupId }) => {
      const groupName = groupId
        ? (groups.find((group) => group.id === groupId)?.name ?? "目标分组")
        : "未分组";
      notify.success(`已移至${groupName}`);
    },
    onError: (error, _, context) => {
      if (context?.previousAll) {
        queryClient.setQueryData(IPTV_FAVORITES_QUERY_KEY, context.previousAll);
      }
      if (context?.previousSource) {
        queryClient.setQueryData(context.sourceKey, context.previousSource);
      }
      notify.error("移动分组失败", messageFromError(error));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: IPTV_FAVORITES_QUERY_KEY });
    },
  });
}
