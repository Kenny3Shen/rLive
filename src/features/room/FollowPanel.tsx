import { useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Heart, Radio, RefreshCw } from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import type { FollowUser } from "@/shared/types/live";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn, normalizeImageUrl, SITE_LABELS } from "@/lib/utils";

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
 * It intentionally owns only navigation and follow-list refresh: switching a
 * row changes the active route, so RoomPage tears down the previous player and
 * danmaku connection before opening the next room.
 */
export function FollowPanel({ className }: { className?: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { siteId: routeSiteId, roomId: routeRoomId } = useParams<{
    siteId: string;
    roomId: string;
  }>();
  const currentRoomId = routeRoomId ? decodeURIComponent(routeRoomId) : undefined;

  const followsQuery = useQuery({
    queryKey: ["follows"],
    queryFn: () => invokeCmd<FollowUser[]>("follow_list"),
    // RoomPage already observes this query for the follow button. Reuse its
    // short-lived cache while rooms are switched from this panel.
    staleTime: 15_000,
  });

  const refreshMutation = useMutation({
    mutationFn: () => invokeCmd<FollowUser[]>("follow_refresh"),
    onSuccess: (follows) => {
      queryClient.setQueryData(["follows"], follows);
    },
  });

  const follows = useMemo(() => sortFollows(followsQuery.data ?? []), [followsQuery.data]);

  function switchRoom(user: FollowUser) {
    const isCurrentRoom = user.site_id === routeSiteId && user.room_id === currentRoomId;
    if (isCurrentRoom) return;
    // Shell deliberately keys room routes to restart the page transition and
    // dispose the previous player. Carry the tab intent through that remount
    // so the user can pick several followed rooms in succession without
    // reopening this tab after every switch.
    navigate(`/room/${user.site_id}/${encodeURIComponent(user.room_id)}`, {
      state: { roomSideTab: "follow" },
    });
  }

  return (
    <section
      className={cn("relative flex min-h-0 flex-1 flex-col", className)}
      aria-label="关注直播间"
    >
      {followsQuery.isLoading && (
        <div className="flex flex-col gap-2 px-2 pt-2 pb-14">
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
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-5 text-center text-muted-foreground">
          <Heart className="size-7" aria-hidden />
          <p className="text-sm">还没有关注主播</p>
          <p className="text-xs">在直播间点击“关注”后会显示在这里</p>
        </div>
      )}

      {follows.length > 0 && (
        <ScrollArea className="min-h-0 flex-1 px-2 pt-2 pb-14">
          <ul className="flex flex-col gap-1">
            {follows.map((user) => {
              const isCurrentRoom = user.site_id === routeSiteId && user.room_id === currentRoomId;
              const avatar = normalizeImageUrl(user.face);
              return (
                <li key={`${user.site_id}:${user.room_id}`}>
                  <Button
                    type="button"
                    variant={isCurrentRoom ? "secondary" : "ghost"}
                    className="h-auto w-full justify-start gap-2 px-2 py-2 text-left"
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
                        {user.live_status === true && <Radio data-icon="inline-end" aria-hidden />}
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
        </ScrollArea>
      )}

      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-lg"
              className="absolute right-3 bottom-3 z-10 rounded-full shadow-lg shadow-primary/25"
              disabled={refreshMutation.isPending}
              aria-label="刷新关注列表"
              title="刷新关注列表"
              onClick={() => refreshMutation.mutate()}
            />
          }
        >
          <RefreshCw
            data-icon="inline-start"
            aria-hidden
            className={cn(refreshMutation.isPending && "animate-spin-soft")}
          />
        </TooltipTrigger>
        <TooltipContent side="left">刷新关注列表</TooltipContent>
      </Tooltip>
    </section>
  );
}
