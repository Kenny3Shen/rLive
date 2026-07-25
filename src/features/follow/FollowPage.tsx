import { useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Star, UserRoundX, Radio } from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import { ErrorState } from "@/shared/components/ErrorState";
import { PageHeader } from "@/shared/components/PageHeader";
import { usePageEntrance } from "@/shared/hooks/usePageEntrance";
import type { FollowUser } from "@/shared/types/live";
import { FOLLOW_PLATFORM_PARAM, followPlatformFromSearch } from "./followRoute";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn, normalizeImageUrl, SITE_LABELS } from "@/lib/utils";

type LiveFilter = "all" | "live" | "offline";

export function FollowPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const qc = useQueryClient();
  const pageRef = useRef<HTMLDivElement>(null);
  const [liveFilter, setLiveFilter] = useState<LiveFilter>("all");
  const platformFilter = followPlatformFromSearch(searchParams.get(FOLLOW_PLATFORM_PARAM));

  const followsQuery = useQuery({
    queryKey: ["follows"],
    queryFn: () => invokeCmd<FollowUser[]>("follow_list"),
  });

  const refreshMutation = useMutation({
    mutationFn: () => invokeCmd<FollowUser[]>("follow_refresh"),
    onSuccess: (data) => {
      qc.setQueryData(["follows"], data);
    },
  });

  const removeMutation = useMutation({
    mutationFn: (u: FollowUser) =>
      invokeCmd("follow_remove", {
        siteId: u.site_id,
        roomId: u.room_id,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["follows"] });
    },
  });

  const items = useMemo(() => {
    let list = [...(followsQuery.data ?? [])];
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
  }, [followsQuery.data, platformFilter, liveFilter]);

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
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border py-20 text-muted-foreground">
          <Star className="h-8 w-8 opacity-40" />
          <p className="text-sm">还没有关注任何主播</p>
          <p className="text-xs">打开直播间后点击「关注」即可添加</p>
        </div>
      )}

      {items.length > 0 && (
        <ul className="flex flex-col gap-2.5">
          {items.map((u) => {
            const live = u.live_status === true;
            const offline = u.live_status === false;
            const avatarSrc = normalizeImageUrl(u.face);
            return (
              <li data-page-enter-item key={`${u.site_id}:${u.room_id}`}>
                <div
                  className={cn(
                    "group flex items-center gap-3 rounded-2xl border border-border-subtle bg-card/80 p-2.5 pr-3 transition-colors",
                    "hover:border-border hover:bg-card-elevated",
                  )}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-3 text-left focus-ring rounded-xl"
                    onClick={() => navigate(`/room/${u.site_id}/${encodeURIComponent(u.room_id)}`)}
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
                      {live && (
                        <Badge className="absolute left-1.5 top-1.5 animate-live bg-accent text-accent-foreground">
                          直播中
                        </Badge>
                      )}
                    </div>

                    <div className="relative min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Avatar className="size-8 ring-2 ring-background">
                          <AvatarImage src={avatarSrc} alt="" referrerPolicy="no-referrer" />
                          <AvatarFallback>{(u.user_name || "?").slice(0, 1)}</AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">
                            {u.user_name}
                            {live && (
                              <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-success align-middle" />
                            )}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">
                            {SITE_LABELS[u.site_id] ?? u.site_id} · 房间 {u.room_id}
                          </p>
                        </div>
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline">{SITE_LABELS[u.site_id] ?? u.site_id}</Badge>
                        {live && <Badge className="bg-success/15 text-success">直播中</Badge>}
                        {offline && <Badge>未开播</Badge>}
                        {u.live_status == null && <Badge>未知</Badge>}
                      </div>
                    </div>
                  </button>

                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0 opacity-60 hover:opacity-100 hover:text-danger"
                    title="取消关注"
                    onClick={() => removeMutation.mutate(u)}
                  >
                    <UserRoundX className="h-4 w-4" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-lg"
              className="fixed right-5 bottom-5 z-20 rounded-full shadow-lg shadow-primary/25"
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
        <TooltipContent>刷新关注列表</TooltipContent>
      </Tooltip>
    </div>
  );
}
