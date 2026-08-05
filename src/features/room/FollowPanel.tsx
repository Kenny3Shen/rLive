import { memo, useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Heart, Home, Radio, RefreshCw } from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import type { FollowUser } from "@/shared/types/live";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { notify } from "@/components/ui/toast";
import { cn, normalizeImageUrl, SITE_LABELS } from "@/lib/utils";
import { PullToRefresh } from "@/shared/components/PullToRefresh";
import { isSiteEnabled } from "@/shared/siteId";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { FOLLOW_ROOM_SWITCH_STATE } from "./roomNavigation";
import {
  FOLLOW_LIST_QUERY_KEY,
  refreshFollows,
  useFollowStatusRefresh,
} from "../follow/followRefresh";

function sortFollows(follows: FollowUser[]): FollowUser[] {
  return [...follows].sort((a, b) => {
    const rank = (item: FollowUser) =>
      item.live_status === true ? 0 : item.live_status === false ? 1 : 2;
    const statusDifference = rank(a) - rank(b);
    if (statusDifference !== 0) return statusDifference;
    return a.user_name.localeCompare(b.user_name, "zh");
  });
}

function statusBadge(user: FollowUser) {
  if (user.live_status === true) {
    return <Badge>直播中</Badge>;
  }
  if (user.live_status === false) {
    return <Badge variant="secondary">未开播</Badge>;
  }
  return <Badge variant="outline">状态未知</Badge>;
}

/**
 * Compact follow list for the room sidebar.
 *
 * It shares the follow page's status-refresh cadence and cache entry, so live
 * badges keep updating while a room stays open. `refreshFollows` deduplicates
 * the remote call, meaning having both views mounted never doubles the work.
 */
export const FollowPanel = memo(function FollowPanel({ className }: { className?: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  useFollowStatusRefresh();
  const { siteId: routeSiteId, roomId: routeRoomId } = useParams<{
    siteId: string;
    roomId: string;
  }>();
  const currentRoomId = routeRoomId ? decodeURIComponent(routeRoomId) : undefined;
  const disabledSiteIds = useSettingsStore((state) => state.disabledSiteIds);

  const followsQuery = useQuery({
    queryKey: FOLLOW_LIST_QUERY_KEY,
    queryFn: () => invokeCmd<FollowUser[]>("follow_list"),
    // RoomPage already observes this query for the follow button. Reuse its
    // short-lived cache while rooms are switched from this panel.
    staleTime: 15_000,
  });

  const refreshMutation = useMutation({
    mutationFn: () => refreshFollows(queryClient),
    onError: () => {
      notify.error("刷新关注列表失败", "请检查网络后重试。");
    },
  });

  const follows = useMemo(
    () =>
      sortFollows(
        (followsQuery.data ?? []).filter((follow) =>
          isSiteEnabled(follow.site_id, disabledSiteIds),
        ),
      ),
    [disabledSiteIds, followsQuery.data],
  );

  function switchRoom(user: FollowUser) {
    const isCurrentRoom = user.site_id === routeSiteId && user.room_id === currentRoomId;
    if (isCurrentRoom) return;
    const roomPath = `/room/${user.site_id}/${encodeURIComponent(user.room_id)}`;
    // Replacing avoids stacking rooms in history. The explicit target sends
    // Back to the follow grid instead of bouncing through previous rooms.
    navigate(roomPath, {
      replace: true,
      state: FOLLOW_ROOM_SWITCH_STATE,
    });
  }

  return (
    <section
      className={cn("relative flex min-h-0 flex-1 flex-col", className)}
      aria-label="关注直播间"
    >
      <ScrollArea className="min-h-0 flex-1">
        <PullToRefresh
          onRefresh={() => refreshMutation.mutateAsync().catch(() => undefined)}
          refreshing={refreshMutation.isPending || followsQuery.isFetching}
          className="h-full min-h-0 p-2 pb-14"
        >
          {followsQuery.isLoading && (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 5 }).map((_, index) => (
                <Skeleton key={index} className="h-14 w-full" />
              ))}
            </div>
          )}

          {followsQuery.isError && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-5 text-center text-sm text-muted-foreground">
              <p>关注列表加载失败</p>
              <Button variant="outline" size="sm" onClick={() => void followsQuery.refetch()}>
                重试
              </Button>
            </div>
          )}

          {!followsQuery.isLoading && !followsQuery.isError && follows.length === 0 && (
            <Empty className="min-h-0 border-0 px-5">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Heart aria-hidden />
                </EmptyMedia>
                <EmptyTitle>还没有关注主播</EmptyTitle>
                <EmptyDescription>在直播间点击“关注”后会显示在这里。</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button variant="outline" size="sm" onClick={() => navigate("/")}>
                  <Home data-icon="inline-start" aria-hidden />
                  去首页看看
                </Button>
              </EmptyContent>
            </Empty>
          )}

          {follows.length > 0 && (
            <ul className="flex flex-col gap-1">
              {follows.map((user) => {
                const isCurrentRoom =
                  user.site_id === routeSiteId && user.room_id === currentRoomId;
                const avatar = normalizeImageUrl(user.face);
                return (
                  <li key={`${user.site_id}:${user.room_id}`}>
                    <Button
                      type="button"
                      variant={isCurrentRoom ? "secondary" : "ghost"}
                      className={cn(
                        "h-auto w-full justify-start gap-2 border border-transparent px-2 py-2 text-left",
                        isCurrentRoom
                          ? "border-primary/25 bg-primary/15 text-primary shadow-sm shadow-primary/10 hover:bg-primary/15 disabled:pointer-events-none disabled:opacity-100"
                          : "hover:bg-muted/70",
                      )}
                      disabled={isCurrentRoom}
                      aria-current={isCurrentRoom ? "page" : undefined}
                      onClick={() => switchRoom(user)}
                    >
                      <Avatar>
                        <AvatarImage src={avatar} alt="" referrerPolicy="no-referrer" />
                        <AvatarFallback>{(user.user_name || "?").slice(0, 1)}</AvatarFallback>
                      </Avatar>
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-sm font-medium">{user.user_name}</span>
                          {user.live_status === true && (
                            <Radio data-icon="inline-end" aria-hidden />
                          )}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {SITE_LABELS[user.site_id] ?? user.site_id} · 房间 {user.room_id}
                        </span>
                      </span>
                      {statusBadge(user)}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </PullToRefresh>
      </ScrollArea>

      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-lg"
              className="absolute right-3 bottom-3 rounded-full"
              disabled={refreshMutation.isPending || followsQuery.isLoading}
              aria-label={refreshMutation.isPending ? "正在刷新关注状态" : "刷新关注状态"}
              onClick={() => refreshMutation.mutate()}
            />
          }
        >
          {refreshMutation.isPending ? (
            <Spinner data-icon="inline-start" aria-hidden />
          ) : (
            <RefreshCw data-icon="inline-start" aria-hidden />
          )}
        </TooltipTrigger>
        <TooltipContent side="left">
          {refreshMutation.isPending ? "正在刷新关注状态" : "刷新关注状态"}
        </TooltipContent>
      </Tooltip>
    </section>
  );
});
