import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CirclePlay, Clock3, Home, Radio, RefreshCw, Star, UserRoundX } from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import { ErrorState } from "@/shared/components/ErrorState";
import { PageHeader } from "@/shared/components/PageHeader";
import { usePageEntrance } from "@/shared/hooks/usePageEntrance";
import { isSiteEnabled } from "@/shared/siteId";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import type { FollowUser } from "@/shared/types/live";
import { FOLLOW_LIST_QUERY_KEY, refreshFollows } from "./followRefresh";
import {
  FOLLOW_PLATFORM_PARAM,
  followPlatformFromSearch,
  formatFollowLiveDuration,
} from "./followRoute";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { cn, normalizeImageUrl, SITE_LABELS } from "@/lib/utils";

type LiveFilter = "all" | "live" | "offline";

function FollowRefreshButton({ pending, onRefresh }: { pending: boolean; onRefresh: () => void }) {
  // The page entrance animation applies a CSS transform to the route shell.
  // A fixed descendant of that shell would use it as its containing block and
  // scroll with the page. Portal the control to the document body so it stays
  // at the same viewport position throughout the follow list.
  if (typeof document === "undefined") return null;

  return createPortal(
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-lg"
            className="fixed right-5 bottom-5 z-20 rounded-full shadow-lg shadow-primary/25"
            disabled={pending}
            aria-label="刷新关注列表"
            onClick={onRefresh}
          />
        }
      >
        {pending ? (
          <Spinner data-icon="inline-start" aria-hidden />
        ) : (
          <RefreshCw data-icon="inline-start" aria-hidden />
        )}
      </TooltipTrigger>
      <TooltipContent>刷新关注列表</TooltipContent>
    </Tooltip>,
    document.body,
  );
}

export function FollowPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const qc = useQueryClient();
  const pageRef = useRef<HTMLDivElement>(null);
  const [liveFilter, setLiveFilter] = useState<LiveFilter>("all");
  const disabledSiteIds = useSettingsStore((state) => state.disabledSiteIds);
  const platformFilter = followPlatformFromSearch(
    searchParams.get(FOLLOW_PLATFORM_PARAM),
    disabledSiteIds,
  );

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

  const items = useMemo(() => {
    let list = (followsQuery.data ?? []).filter((follow) =>
      isSiteEnabled(follow.site_id, disabledSiteIds),
    );
    if (platformFilter !== "all") {
      list = list.filter((follow) => follow.site_id === platformFilter);
    }
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
  }, [disabledSiteIds, followsQuery.data, platformFilter, liveFilter]);

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

  usePageEntrance(pageRef, {
    entryKey: `follow:${platformFilter}`,
    ready: !followsQuery.isLoading,
  });

  return (
    <div ref={pageRef} className="mx-auto flex max-w-4xl flex-col gap-4 pb-16">
      <div data-page-enter-heading>
        <PageHeader title="关注用户" />
      </div>

      <div data-page-enter-controls>
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
      </div>

      {followsQuery.isLoading && (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[88px] w-full rounded-2xl" />
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
        <ul className="flex flex-col gap-2.5">
          {items.map((u) => {
            const live = u.live_status === true;
            const offline = u.live_status === false;
            const liveDuration = live ? formatFollowLiveDuration(u.live_started_at, now) : null;
            const avatarSrc = normalizeImageUrl(u.face);
            return (
              <li data-page-enter-item key={`${u.site_id}:${u.room_id}`}>
                <ContextMenu>
                  <ContextMenuTrigger
                    render={
                      <div
                        className={cn(
                          "group flex items-center gap-3 rounded-2xl border border-border-subtle bg-card/80 p-2.5 pr-3 transition-colors",
                          "hover:border-border hover:bg-card-elevated",
                        )}
                      />
                    }
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-3 text-left focus-ring rounded-xl"
                      onClick={() =>
                        navigate(`/room/${u.site_id}/${encodeURIComponent(u.room_id)}`)
                      }
                    >
                      <div className="relative h-16 w-[104px] shrink-0 overflow-hidden rounded-xl bg-muted">
                        {avatarSrc ? (
                          <img
                            src={avatarSrc}
                            alt=""
                            className="h-full w-full object-cover"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center">
                            <Radio className="h-5 w-5 text-muted-foreground" />
                          </div>
                        )}
                      </div>

                      <div className="relative min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <Avatar className="size-8 ring-2 ring-background">
                            <AvatarImage src={avatarSrc} alt="" referrerPolicy="no-referrer" />
                            <AvatarFallback>{(u.user_name || "?").slice(0, 1)}</AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{u.user_name}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              {SITE_LABELS[u.site_id] ?? u.site_id} · 房间 {u.room_id}
                            </p>
                          </div>
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          <Badge variant="outline">{SITE_LABELS[u.site_id] ?? u.site_id}</Badge>
                          {live && <Badge className="bg-success/15 text-success">直播中</Badge>}
                          {liveDuration && (
                            <Badge variant="outline" title={`开播时长：${liveDuration}`}>
                              <Clock3 aria-hidden />
                              开播 {liveDuration}
                            </Badge>
                          )}
                          {offline && <Badge>未开播</Badge>}
                          {u.live_status == null && <Badge>未知</Badge>}
                        </div>
                      </div>
                    </button>

                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="shrink-0 opacity-60 transition-opacity hover:opacity-100 hover:text-destructive [@media(pointer:coarse)]:opacity-100"
                            disabled={removeMutation.isPending}
                            aria-label="取消关注"
                            aria-busy={removeMutation.isPending}
                            onClick={() => removeMutation.mutate(u)}
                          />
                        }
                      >
                        {removeMutation.isPending ? (
                          <Spinner data-icon="inline-start" aria-hidden />
                        ) : (
                          <UserRoundX data-icon="inline-start" aria-hidden />
                        )}
                      </TooltipTrigger>
                      <TooltipContent>取消关注</TooltipContent>
                    </Tooltip>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuGroup>
                      <ContextMenuItem
                        onClick={() =>
                          navigate(`/room/${u.site_id}/${encodeURIComponent(u.room_id)}`)
                        }
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
                        onClick={() => removeMutation.mutate(u)}
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

      <FollowRefreshButton
        pending={refreshMutation.isPending}
        onRefresh={() => refreshMutation.mutate()}
      />
    </div>
  );
}
