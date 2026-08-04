import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CirclePlay, Clock3, Home, Star, UserRoundX } from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import { ErrorState } from "@/shared/components/ErrorState";
import { PageHeader } from "@/shared/components/PageHeader";
import { PullToRefresh } from "@/shared/components/PullToRefresh";
import { RefreshFab } from "@/shared/components/RefreshFab";
import { isSiteEnabled } from "@/shared/siteId";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import type { FollowUser } from "@/shared/types/live";
import { FOLLOW_LIST_QUERY_KEY, refreshFollows, useFollowStatusRefresh } from "./followRefresh";
import {
  FOLLOW_PLATFORM_PARAM,
  followPlatformFromSearch,
  formatFollowLiveDuration,
} from "./followRoute";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { notify } from "@/components/ui/toast";
import { preloadRouteModule } from "@/app/routeModules";
import { usePlatformScope } from "@/shared/hooks/useSiteQuery";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn, normalizeImageUrl, SITE_LABELS } from "@/lib/utils";

type LiveFilter = "all" | "live" | "offline";

export function FollowPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const qc = useQueryClient();
  const [liveFilter, setLiveFilter] = useState<LiveFilter>("all");
  const [pendingRemove, setPendingRemove] = useState<FollowUser | null>(null);
  const disabledSiteIds = useSettingsStore((state) => state.disabledSiteIds);
  const scopedPlatform = usePlatformScope();
  // Status refresh is intentionally started only after the user enters the
  // dedicated follow page, so first-paint work stays focused on discovery.
  useFollowStatusRefresh();
  const platformFilter =
    scopedPlatform ??
    followPlatformFromSearch(searchParams.get(FOLLOW_PLATFORM_PARAM), disabledSiteIds);

  const followsQuery = useQuery({
    queryKey: FOLLOW_LIST_QUERY_KEY,
    queryFn: () => invokeCmd<FollowUser[]>("follow_list"),
  });

  const refreshMutation = useMutation({
    mutationFn: () => refreshFollows(qc),
    onError: () => {
      notify.error("刷新关注列表失败", "请检查网络后重试。");
    },
  });

  const removeMutation = useMutation({
    mutationFn: (u: FollowUser) =>
      invokeCmd("follow_remove", {
        siteId: u.site_id,
        roomId: u.room_id,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: FOLLOW_LIST_QUERY_KEY });
      notify.success("已取消关注");
    },
    onError: () => {
      notify.error("取消关注失败", "请检查网络后重试。");
    },
  });

  const platformItems = useMemo(() => {
    let list = (followsQuery.data ?? []).filter((follow) =>
      isSiteEnabled(follow.site_id, disabledSiteIds),
    );
    if (platformFilter !== "all") {
      list = list.filter((follow) => follow.site_id === platformFilter);
    }

    return list;
  }, [disabledSiteIds, followsQuery.data, platformFilter]);

  const items = useMemo(() => {
    let list = [...platformItems];
    if (liveFilter === "live") {
      list = list.filter((f) => f.live_status === true);
    } else if (liveFilter === "offline") {
      list = list.filter((f) => f.live_status === false);
    }
    list.sort((a, b) => {
      const av = a.live_status === true ? 0 : a.live_status === false ? 1 : 2;
      const bv = b.live_status === true ? 0 : b.live_status === false ? 1 : 2;
      if (av !== bv) return av - bv;
      return a.user_name.localeCompare(b.user_name, "zh");
    });
    return list;
  }, [liveFilter, platformItems]);

  const liveCount = platformItems.filter((follow) => follow.live_status === true).length;

  const hasLiveDuration = items.some(
    (follow) => follow.live_status === true && follow.live_started_at != null,
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!hasLiveDuration) return;

    let interval: number | undefined;
    const updateClock = () => setNow(Date.now());
    updateClock();
    const untilNextMinute = 60_000 - (Date.now() % 60_000) + 50;
    const timeout = window.setTimeout(() => {
      updateClock();
      interval = window.setInterval(updateClock, 60_000);
    }, untilNextMinute);

    return () => {
      window.clearTimeout(timeout);
      if (interval != null) window.clearInterval(interval);
    };
  }, [hasLiveDuration]);

  return (
    <PullToRefresh
      onRefresh={() => refreshMutation.mutateAsync()}
      refreshing={refreshMutation.isPending}
      className="mx-auto max-w-[1600px]"
    >
      <RefreshFab
        onRefresh={() => refreshMutation.mutateAsync()}
        pending={refreshMutation.isPending || followsQuery.isLoading}
        label="刷新关注列表"
      />
      <div className="flex flex-col gap-3">
        <div>
          <PageHeader
            title="关注用户"
            description={
              followsQuery.isLoading
                ? undefined
                : `${platformItems.length} 位主播 · ${liveCount} 位直播中`
            }
            className="mb-0"
            actions={
              <ToggleGroup
                value={[liveFilter]}
                variant="outline"
                size="sm"
                spacing={0}
                aria-label="关注状态筛选"
                onValueChange={(value) => {
                  const next = value[0] as LiveFilter | undefined;
                  if (next) setLiveFilter(next);
                }}
              >
                <ToggleGroupItem value="all">全部</ToggleGroupItem>
                <ToggleGroupItem value="live">直播中</ToggleGroupItem>
                <ToggleGroupItem value="offline">未开播</ToggleGroupItem>
              </ToggleGroup>
            }
          />
        </div>

        {followsQuery.isLoading && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-2.5">
            {Array.from({ length: 10 }).map((_, i) => (
              <Card key={i} size="sm" className="gap-2">
                <CardHeader className="items-center gap-x-2.5">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Skeleton className="size-10 shrink-0 rounded-full" />
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <Skeleton className="h-3.5 w-3/5" />
                      <Skeleton className="h-3 w-4/5" />
                    </div>
                  </div>
                  <CardAction className="self-center">
                    <Skeleton className="size-7 rounded-lg" />
                  </CardAction>
                </CardHeader>
                <CardContent className="flex min-h-5 items-center gap-1.5">
                  <Skeleton className="h-5 w-14 rounded-full" />
                  <Skeleton className="h-5 w-20 rounded-full" />
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {followsQuery.isError && (
          <ErrorState
            error={followsQuery.error}
            title="关注列表加载失败"
            onRetry={() => void followsQuery.refetch()}
          />
        )}

        {!followsQuery.isLoading && items.length === 0 && (
          <Empty className="min-h-64 py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Star aria-hidden />
              </EmptyMedia>
              <EmptyTitle>还没有关注任何主播</EmptyTitle>
              <EmptyDescription>打开直播间后点击“关注”即可添加。</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" size="sm" onClick={() => navigate("/")}>
                <Home data-icon="inline-start" aria-hidden />
                去首页看看
              </Button>
            </EmptyContent>
          </Empty>
        )}

        {items.length > 0 && (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-2.5">
            {items.map((u) => {
              const live = u.live_status === true;
              const offline = u.live_status === false;
              const liveDuration = live ? formatFollowLiveDuration(u.live_started_at, now) : null;
              const avatarSrc = normalizeImageUrl(u.face);
              const removingThis =
                removeMutation.isPending &&
                removeMutation.variables?.site_id === u.site_id &&
                removeMutation.variables.room_id === u.room_id;
              const roomPath = `/room/${u.site_id}/${encodeURIComponent(u.room_id)}`;
              return (
                <li key={`${u.site_id}:${u.room_id}`} className="min-w-0">
                  <ContextMenu>
                    <ContextMenuTrigger
                      render={
                        <Card
                          size="sm"
                          className={cn(
                            "relative h-full gap-2 py-3 transition-[background-color,box-shadow] hover:bg-card-elevated hover:ring-foreground/20",
                            live &&
                              "before:absolute before:inset-y-3 before:left-0 before:w-0.5 before:rounded-r-full before:bg-success",
                          )}
                        />
                      }
                    >
                      <button
                        type="button"
                        className="absolute inset-0 rounded-xl outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                        aria-label={`打开${u.user_name}的直播间`}
                        onPointerEnter={() => preloadRouteModule(roomPath)}
                        onPointerDown={() => preloadRouteModule(roomPath)}
                        onFocus={() => preloadRouteModule(roomPath)}
                        onClick={() => navigate(roomPath)}
                      />

                      <CardHeader className="pointer-events-none items-center gap-x-2.5">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <Avatar size="lg">
                            <AvatarImage src={avatarSrc} alt="" referrerPolicy="no-referrer" />
                            <AvatarFallback>{(u.user_name || "?").slice(0, 1)}</AvatarFallback>
                          </Avatar>
                          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <CardTitle className="truncate" title={u.user_name}>
                              {u.user_name}
                            </CardTitle>
                            <CardDescription className="truncate">
                              {SITE_LABELS[u.site_id] ?? u.site_id} · 房间 {u.room_id}
                            </CardDescription>
                          </div>
                        </div>

                        <CardAction className="pointer-events-auto relative z-10 self-center">
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  className="shrink-0 opacity-60 transition-opacity hover:text-destructive hover:opacity-100 [@media(pointer:coarse)]:opacity-100"
                                  disabled={removeMutation.isPending}
                                  aria-label="取消关注"
                                  aria-busy={removingThis}
                                  onClick={() => setPendingRemove(u)}
                                />
                              }
                            >
                              {removingThis ? (
                                <Spinner data-icon="inline-start" aria-hidden />
                              ) : (
                                <UserRoundX data-icon="inline-start" aria-hidden />
                              )}
                            </TooltipTrigger>
                            <TooltipContent>取消关注</TooltipContent>
                          </Tooltip>
                        </CardAction>
                      </CardHeader>

                      <CardContent className="pointer-events-none flex min-h-5 min-w-0 items-center gap-1.5">
                        {live && (
                          <Badge variant="secondary" className="bg-success/15 text-success">
                            直播中
                          </Badge>
                        )}
                        {liveDuration && (
                          <Badge variant="outline" title={`开播时长：${liveDuration}`}>
                            <Clock3 aria-hidden />
                            开播 {liveDuration}
                          </Badge>
                        )}
                        {offline && <Badge variant="secondary">未开播</Badge>}
                        {u.live_status == null && <Badge variant="outline">状态未知</Badge>}
                      </CardContent>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuGroup>
                        <ContextMenuItem
                          onFocus={() => preloadRouteModule(roomPath)}
                          onClick={() => navigate(roomPath)}
                        >
                          <CirclePlay aria-hidden />
                          打开直播间
                        </ContextMenuItem>
                      </ContextMenuGroup>
                      <ContextMenuSeparator />
                      <ContextMenuGroup>
                        <ContextMenuItem
                          variant="destructive"
                          disabled={removeMutation.isPending}
                          onClick={() => setPendingRemove(u)}
                        >
                          <UserRoundX aria-hidden />
                          取消关注
                        </ContextMenuItem>
                      </ContextMenuGroup>
                    </ContextMenuContent>
                  </ContextMenu>
                </li>
              );
            })}
          </ul>
        )}

        <AlertDialog
          open={pendingRemove != null}
          onOpenChange={(open) => {
            if (removeMutation.isPending) return;
            if (!open) setPendingRemove(null);
          }}
        >
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogMedia className="bg-destructive/10 text-destructive">
                <UserRoundX aria-hidden />
              </AlertDialogMedia>
              <AlertDialogTitle>取消关注</AlertDialogTitle>
              <AlertDialogDescription>
                确定不再关注 {pendingRemove?.user_name} 吗？取消后将不再显示在关注列表中。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={removeMutation.isPending}>取消</AlertDialogCancel>
              <AlertDialogAction
                type="button"
                variant="destructive"
                disabled={removeMutation.isPending}
                onClick={() => {
                  if (pendingRemove) removeMutation.mutate(pendingRemove);
                  setPendingRemove(null);
                }}
              >
                <UserRoundX data-icon="inline-start" aria-hidden />
                取消关注
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </PullToRefresh>
  );
}
