import { useEffect, useMemo, useState } from "react";
import { CircleCheck, CircleX, Play, Tv, X } from "lucide-react";
import { ErrorState } from "@/shared/components/ErrorState";
import { PullToRefresh } from "@/shared/components/PullToRefresh";
import { RefreshFab } from "@/shared/components/RefreshFab";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { preloadRouteModule } from "@/app/routeModules";
import { cn } from "@/lib/utils";
import { useIptvController } from "./IptvController";
import { IptvAvailabilityFab } from "./IptvHeaderControls";
import type { IptvAvailabilityState } from "./availability";
import type { IptvChannel } from "./types";

const CHANNEL_PAGE_SIZE = 120;

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
    availabilityFilter,
    filteredChannels,
    availabilityByUrl,
    playlistQuery,
    hasFilters,
    updateSource,
    clearFilters,
    openChannel,
  } = useIptvController();
  const [channelLimit, setChannelLimit] = useState(CHANNEL_PAGE_SIZE);
  const displayedChannels = useMemo(
    () => filteredChannels.slice(0, channelLimit),
    [channelLimit, filteredChannels],
  );

  useEffect(() => {
    setChannelLimit(CHANNEL_PAGE_SIZE);
  }, [availabilityFilter, keyword, selectedGroup, source.url]);

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
        ) : (
          <section aria-label="IPTV 频道列表" className="flex min-h-[32rem] flex-col gap-4">
            {playlistQuery.isLoading ? (
              <IptvChannelGridSkeleton />
            ) : filteredChannels.length === 0 ? (
              <Empty className="min-h-64 py-12">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Tv aria-hidden />
                  </EmptyMedia>
                  <EmptyTitle>没有符合条件的频道</EmptyTitle>
                  <EmptyDescription>调整搜索、分类或可用状态后再试。</EmptyDescription>
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
                <div className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                  {displayedChannels.map((channel) => (
                    <IptvChannelCard
                      key={`${channel.id}:${channel.url}`}
                      channel={channel}
                      availability={availabilityByUrl.get(channel.url)}
                      onOpen={openChannel}
                    />
                  ))}
                </div>

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
        )}
      </div>
    </PullToRefresh>
  );
}

function IptvChannelGridSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {Array.from({ length: 12 }).map((_, index) => (
        <div key={index} className="flex flex-col gap-2">
          <Skeleton className="aspect-video w-full rounded-xl" />
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}

function IptvAvailabilityBadge({ availability }: { availability: IptvAvailabilityState }) {
  if (availability.status === "checking") {
    return (
      <Badge variant="outline" className="absolute top-2 left-2 shadow-sm">
        <Spinner data-icon="inline-start" aria-hidden />
        检测中
      </Badge>
    );
  }
  if (availability.status === "available") {
    return (
      <Badge
        variant="secondary"
        className="absolute top-2 left-2 shadow-sm"
        title={`响应耗时 ${formatLatency(availability.latencyMs)}`}
      >
        <CircleCheck className="text-success" data-icon="inline-start" aria-hidden />
        可用 · {formatLatency(availability.latencyMs)}
      </Badge>
    );
  }
  return (
    <Badge
      variant="destructive"
      className="absolute top-2 left-2 shadow-sm"
      title={availability.message ?? "频道当前不可用"}
    >
      <CircleX data-icon="inline-start" aria-hidden />
      不可用
    </Badge>
  );
}

function IptvChannelCard({
  channel,
  availability,
  onOpen,
}: {
  channel: IptvChannel;
  availability: IptvAvailabilityState | undefined;
  onOpen: (channel: IptvChannel) => void;
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
    <button
      type="button"
      onClick={() => onOpen(channel)}
      onPointerEnter={() => preloadRouteModule("/iptv/play")}
      onPointerDown={() => preloadRouteModule("/iptv/play")}
      onFocus={() => preloadRouteModule("/iptv/play")}
      className={cn(
        "room-card group flex w-full flex-col overflow-hidden rounded-xl bg-transparent text-left transition-transform focus-ring max-md:active:scale-[0.97]",
        "hover:-translate-y-0.5",
      )}
      aria-label={`播放 ${channel.name}${availabilityLabel}`}
    >
      <div className="relative aspect-video overflow-hidden rounded-xl bg-muted shadow-md shadow-black/20 ring-1 ring-border/70">
        {channel.logo ? (
          <img
            src={channel.logo}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            className="size-full object-contain p-5 transition duration-300 group-hover:scale-[1.04] sm:p-6"
          />
        ) : (
          <div className="flex size-full items-center justify-center text-muted-foreground">
            <Tv className="size-8" aria-hidden />
          </div>
        )}
        {availability && <IptvAvailabilityBadge availability={availability} />}
        <span className="absolute top-2 right-2 flex size-7 items-center justify-center rounded-full bg-background/80 text-foreground opacity-0 shadow-sm backdrop-blur transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100">
          <Play className="size-3.5 fill-current" aria-hidden />
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-0.5 px-0.5 pt-2.5 pb-1">
        <p className="line-clamp-1 text-[13px] font-medium leading-snug text-foreground">
          {channel.name || "未命名频道"}
        </p>
        <p className="truncate text-xs text-muted-foreground" title={group}>
          {group}
        </p>
      </div>
    </button>
  );
}
