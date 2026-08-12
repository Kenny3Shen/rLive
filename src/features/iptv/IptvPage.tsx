import { useEffect, useMemo, useState } from "react";
import { CircleCheck, CircleX, Folder, Heart, Inbox, Layers3, Tv, X } from "lucide-react";
import { ErrorState } from "@/shared/components/ErrorState";
import { PullToRefresh } from "@/shared/components/PullToRefresh";
import { RefreshFab } from "@/shared/components/RefreshFab";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { preloadRouteModule } from "@/app/routeModules";
import { cn } from "@/lib/utils";
import { useIptvController } from "./IptvController";
import { IptvAvailabilityFab, IptvHeaderStatusControls } from "./IptvHeaderControls";
import type { IptvGroupOption } from "./filterChannels";
import type { IptvAvailabilityState } from "./availability";
import type { IptvChannel } from "./types";

const CHANNEL_PAGE_SIZE = 120;

type IptvGroupTargetProps = {
  value: string;
  label: string;
  count: number;
  selected: boolean;
  onSelect: () => void;
};

function IptvGroupTarget({ value, label, count, selected, onSelect }: IptvGroupTargetProps) {
  const Icon = value === "all" ? Layers3 : value === "未分组" ? Inbox : Folder;

  return (
    <Button
      type="button"
      variant={selected ? "secondary" : "ghost"}
      size="sm"
      aria-current={selected ? "page" : undefined}
      className="w-full justify-start gap-2 px-2.5"
      onClick={onSelect}
      title={label}
    >
      <Icon data-icon="inline-start" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{count}</span>
    </Button>
  );
}

function groupTargets(channelsCount: number, options: readonly IptvGroupOption[]) {
  return [
    { value: "all", label: "全部频道", count: channelsCount },
    ...options.map((group) => ({
      value: group.value,
      label: group.value,
      count: group.count,
    })),
  ];
}

function formatLatency(latencyMs: number): string {
  if (latencyMs < 1_000) return `${Math.max(1, Math.round(latencyMs))} ms`;
  return `${(latencyMs / 1_000).toFixed(1)} s`;
}

/**
 * IPTV discovery deliberately does not render a player. Selecting a card is
 * the only path to the separate playback route, so simply entering /iptv can
 * never start a stream or claim a proxy session.
 *
 * Entrance motion is deliberately absent, matching the other card-grid pages
 * (home, category, search, follow): route-level travel is `PagePan`'s job, and
 * a second in-page stagger on top of it would read as two transitions for one
 * navigation.
 */
export function IptvPage() {
  const {
    source,
    channels,
    selectedGroup,
    keyword,
    groupOptions,
    availabilityFilter,
    filteredChannels,
    availabilityByUrl,
    favoriteOnly,
    favoritesQuery,
    favoritePendingUrl,
    isFavorite,
    toggleFavorite,
    playlistQuery,
    hasFilters,
    updateSource,
    clearFilters,
    navigateHome,
    openChannel,
  } = useIptvController();
  const [channelLimit, setChannelLimit] = useState(CHANNEL_PAGE_SIZE);
  const displayedChannels = useMemo(
    () => filteredChannels.slice(0, channelLimit),
    [channelLimit, filteredChannels],
  );
  const targets = useMemo(
    () => groupTargets(channels.length, groupOptions),
    [channels.length, groupOptions],
  );
  const selectedGroupLabel =
    targets.find((target) => target.value === selectedGroup)?.label ?? "全部频道";

  useEffect(() => {
    setChannelLimit(CHANNEL_PAGE_SIZE);
  }, [availabilityFilter, favoriteOnly, keyword, selectedGroup, source.url]);

  return (
    <PullToRefresh
      onRefresh={updateSource}
      refreshing={playlistQuery.isRefetching}
      className="mx-auto max-w-[1600px]"
    >
      <RefreshFab
        onRefresh={updateSource}
        pending={playlistQuery.isRefetching}
        label="更新 IPTV 频道源"
      />
      <IptvAvailabilityFab />
      <div className="flex min-h-full flex-col gap-4 touch-pan-y">
        {playlistQuery.isError && channels.length === 0 ? (
          <ErrorState
            error={playlistQuery.error}
            title="IPTV 频道列表加载失败"
            onRetry={() => void updateSource()}
          />
        ) : favoriteOnly && favoritesQuery.isError ? (
          <ErrorState
            error={favoritesQuery.error}
            title="IPTV 关注列表加载失败"
            onRetry={() => void favoritesQuery.refetch()}
          />
        ) : (
          <div className="grid min-w-0 items-start gap-4 md:grid-cols-[13rem_minmax(0,1fr)]">
            <aside
              aria-label="IPTV 频道分组"
              className="sticky top-3 hidden max-h-[calc(100dvh-9rem)] min-w-0 flex-col gap-1 overflow-hidden border-r border-border pr-3 md:flex"
            >
              <div className="mb-1 shrink-0 px-2">
                <span className="text-xs font-medium text-muted-foreground">频道分组</span>
              </div>
              <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain py-0.5">
                {targets.map((target) => (
                  <IptvGroupTarget
                    key={target.value}
                    {...target}
                    selected={selectedGroup === target.value}
                    onSelect={() => navigateHome({ group: target.value })}
                  />
                ))}
              </nav>
              <div className="mt-2 shrink-0 border-t border-border-subtle pt-3">
                <IptvHeaderStatusControls showGroup={false} compact={false} />
              </div>
            </aside>

            <section
              aria-label="IPTV 频道列表"
              className="flex min-h-[32rem] min-w-0 flex-col gap-4"
            >
              <div className="md:hidden">
                <IptvHeaderStatusControls showGroup compact={false} />
              </div>

              <div className="flex min-h-9 flex-wrap items-end justify-between gap-2 border-b border-border pb-2">
                <div className="min-w-0">
                  <h1 className="truncate text-sm font-semibold">{selectedGroupLabel}</h1>
                  <p className="text-xs tabular-nums text-muted-foreground">
                    {filteredChannels.length} 个频道
                  </p>
                </div>
              </div>

              {playlistQuery.isLoading || (favoriteOnly && favoritesQuery.isLoading) ? (
                <IptvChannelGridSkeleton />
              ) : filteredChannels.length === 0 ? (
                <Empty className="min-h-64 py-12">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Tv aria-hidden />
                    </EmptyMedia>
                    <EmptyTitle>没有符合条件的频道</EmptyTitle>
                    <EmptyDescription>
                      {favoriteOnly
                        ? "当前来源还没有符合条件的关注频道。"
                        : "调整搜索、分类或可用状态后再试。"}
                    </EmptyDescription>
                  </EmptyHeader>
                  {hasFilters && (
                    <EmptyContent>
                      <Button variant="outline" size="sm" onClick={clearFilters}>
                        <X data-icon="inline-start" aria-hidden />
                        清除筛选
                      </Button>
                    </EmptyContent>
                  )}
                </Empty>
              ) : (
                <>
                  <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,17rem),1fr))] gap-2.5">
                    {displayedChannels.map((channel) => (
                      <IptvChannelCard
                        key={`${channel.id}:${channel.url}`}
                        channel={channel}
                        availability={availabilityByUrl.get(channel.url)}
                        isFavorite={isFavorite(channel)}
                        favoritePending={favoritePendingUrl === channel.url}
                        onOpen={openChannel}
                        onToggleFavorite={toggleFavorite}
                      />
                    ))}
                  </ul>

                  {displayedChannels.length < filteredChannels.length && (
                    <div className="flex flex-col items-center gap-2 py-2">
                      <p className="text-xs text-muted-foreground">
                        已显示 {displayedChannels.length} / {filteredChannels.length} 个频道
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setChannelLimit((current) => current + CHANNEL_PAGE_SIZE)}
                      >
                        显示更多
                      </Button>
                    </div>
                  )}
                </>
              )}
            </section>
          </div>
        )}
      </div>
    </PullToRefresh>
  );
}

function IptvChannelGridSkeleton() {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,17rem),1fr))] gap-2.5">
      {Array.from({ length: 12 }).map((_, index) => (
        <Card key={index} size="sm" className="gap-2">
          <CardHeader className="items-center gap-x-2.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <Skeleton className="size-10 shrink-0 rounded-lg" />
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
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function IptvAvailabilityBadge({ availability }: { availability: IptvAvailabilityState }) {
  if (availability.status === "checking") {
    return (
      <Badge variant="outline">
        <Spinner data-icon="inline-start" aria-hidden />
        检测中
      </Badge>
    );
  }
  if (availability.status === "available") {
    return (
      <Badge variant="secondary" title={`响应耗时 ${formatLatency(availability.latencyMs)}`}>
        <CircleCheck className="text-success" data-icon="inline-start" aria-hidden />
        可用 · {formatLatency(availability.latencyMs)}
      </Badge>
    );
  }
  return (
    <Badge variant="destructive" title={availability.message ?? "频道当前不可用"}>
      <CircleX data-icon="inline-start" aria-hidden />
      不可用
    </Badge>
  );
}

function IptvChannelCard({
  channel,
  availability,
  isFavorite,
  favoritePending,
  onOpen,
  onToggleFavorite,
}: {
  channel: IptvChannel;
  availability: IptvAvailabilityState | undefined;
  isFavorite: boolean;
  favoritePending: boolean;
  onOpen: (channel: IptvChannel) => void;
  onToggleFavorite: (channel: IptvChannel) => void;
}) {
  const group = channel.group || "未分组";
  const availabilityLabel =
    availability?.status === "available"
      ? `，可用，响应 ${formatLatency(availability.latencyMs)}`
      : availability?.status === "unavailable"
        ? `，不可用，${availability.message ?? "连接失败"}`
        : availability?.status === "checking"
          ? "，正在检测可用性"
          : "";

  return (
    <li className="min-w-0">
      <Card
        size="sm"
        className="motion-card relative h-full gap-2 py-3 hover:bg-card-elevated hover:ring-foreground/20"
      >
        <button
          type="button"
          onClick={() => onOpen(channel)}
          onPointerEnter={() => preloadRouteModule("/iptv/play")}
          onPointerDown={() => preloadRouteModule("/iptv/play")}
          onFocus={() => preloadRouteModule("/iptv/play")}
          className="absolute inset-0 rounded-xl outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          aria-label={`播放 ${channel.name}${availabilityLabel}`}
        />

        <CardHeader className="pointer-events-none items-center gap-x-2.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted ring-1 ring-border-subtle">
              {channel.logo ? (
                <img
                  src={channel.logo}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  referrerPolicy="no-referrer"
                  className="size-full object-contain p-1"
                />
              ) : (
                <Tv className="size-5 text-muted-foreground" aria-hidden />
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <CardTitle className="truncate" title={channel.name}>
                {channel.name || "未命名频道"}
              </CardTitle>
              <CardDescription className="truncate" title={group}>
                {group}
              </CardDescription>
            </div>
          </div>

          <CardAction className="pointer-events-auto relative z-10 self-center">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={favoritePending}
                    onClick={() => onToggleFavorite(channel)}
                    aria-label={`${isFavorite ? "取消关注" : "关注"} ${channel.name}`}
                    aria-pressed={isFavorite}
                    className={cn(isFavorite && "text-primary hover:text-primary")}
                  />
                }
              >
                {favoritePending ? (
                  <Spinner aria-hidden />
                ) : (
                  <Heart className={cn(isFavorite && "fill-current")} aria-hidden />
                )}
              </TooltipTrigger>
              <TooltipContent>{isFavorite ? "取消关注" : "关注频道"}</TooltipContent>
            </Tooltip>
          </CardAction>
        </CardHeader>

        <CardContent className="pointer-events-none flex min-h-5 min-w-0 items-center gap-1.5 overflow-hidden">
          {availability ? (
            <IptvAvailabilityBadge availability={availability} />
          ) : (
            <Badge variant="outline">未检测</Badge>
          )}
        </CardContent>
      </Card>
    </li>
  );
}
