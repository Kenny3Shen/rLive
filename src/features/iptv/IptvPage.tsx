import { useEffect, useMemo, useState } from "react";
import { CircleCheck, CircleX, Folder, Inbox, Layers3, Tv, X } from "lucide-react";
import { ErrorState } from "@/shared/components/ErrorState";
import { PullToRefresh } from "@/shared/components/PullToRefresh";
import { RefreshFab } from "@/shared/components/RefreshFab";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { useIptvController } from "./IptvController";
import { IptvAvailabilityFab, IptvContentToolbar, IptvRailControls } from "./IptvHeaderControls";
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
 * IPTV 发现页刻意不渲染播放器。选择卡片是进入独立播放路由的唯一路径，
 * 因此仅仅进入 /iptv 绝不会启动流或占用代理会话。
 *
 * 入场动画刻意省略，与其他卡片网格页（首页、分类、搜索、关注）一致：
 * 路由级移动是 `PagePan` 的职责，
 * 在其之上再来一次页内交错会被读成一次导航两段过渡。
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
          <div className="grid min-w-0 items-start gap-4 md:grid-cols-[13rem_minmax(0,1fr)]">
            <aside
              aria-label="IPTV 频道分组"
              className="sticky top-3 hidden max-h-[calc(100dvh-9rem)] min-w-0 flex-col gap-1 overflow-hidden border-r border-border pr-3 md:flex"
            >
              <IptvRailControls className="mb-3 shrink-0 border-b border-border-subtle pb-3" />
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
            </aside>

            <section
              aria-label="IPTV 频道列表"
              className="flex min-h-[32rem] min-w-0 flex-col gap-4"
            >
              <IptvContentToolbar className="md:hidden" />

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
                  <ul className="grid grid-cols-1 gap-2.5 md:grid-cols-[repeat(auto-fill,minmax(min(100%,17rem),1fr))]">
                    {displayedChannels.map((channel) => (
                      <IptvChannelCard
                        key={`${channel.id}:${channel.url}`}
                        channel={channel}
                        availability={availabilityByUrl.get(channel.url)}
                        onOpen={openChannel}
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
    <div className="grid grid-cols-1 gap-2.5 md:grid-cols-[repeat(auto-fill,minmax(min(100%,17rem),1fr))]">
      {Array.from({ length: 12 }).map((_, index) => (
        <Card key={index} size="sm" className="relative gap-2 py-3">
          <CardHeader className="items-center gap-x-2.5 max-md:grid-cols-1">
            <div className="flex min-w-0 items-center gap-2.5">
              <Skeleton className="size-10 shrink-0 rounded-lg" />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Skeleton className="h-3.5 w-3/5" />
                <Skeleton className="h-3 w-4/5" />
              </div>
            </div>
            <CardAction className="self-center max-md:hidden">
              <Skeleton className="h-4 w-12 rounded-full" />
            </CardAction>
          </CardHeader>
        </Card>
      ))}
    </div>
  );
}

/** 紧凑的卡片角落状态：图标加延迟数值，没有文字结论。 */
function IptvCardAvailability({
  availability,
}: {
  availability: IptvAvailabilityState | undefined;
}) {
  if (!availability) return null;
  if (availability.status === "checking") {
    return <Spinner className="size-4 text-muted-foreground" aria-label="检测中" />;
  }
  if (availability.status === "available") {
    return (
      <span
        className="flex items-center gap-1 text-xs tabular-nums text-muted-foreground"
        aria-label={`可用，响应 ${formatLatency(availability.latencyMs)}`}
      >
        <CircleCheck className="size-4 text-success" aria-hidden />
        {formatLatency(availability.latencyMs)}
      </span>
    );
  }
  return (
    <CircleX
      className="size-4 text-destructive"
      role="img"
      aria-label={availability.message ?? "频道当前不可用"}
    />
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
          className="absolute inset-0 rounded-xl outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--focus-ring-color)]"
          aria-label={`播放 ${channel.name}${availabilityLabel}`}
        />

        <CardHeader className="pointer-events-none items-center gap-x-2.5 max-md:grid-cols-1">
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
              <div className="flex min-w-0 items-center gap-1.5">
                <CardDescription className="min-w-0 flex-1 truncate" title={group}>
                  {group}
                </CardDescription>
                <span className="flex shrink-0 items-center md:hidden">
                  <IptvCardAvailability availability={availability} />
                </span>
              </div>
            </div>
          </div>

          <CardAction className="self-center max-md:hidden">
            <IptvCardAvailability availability={availability} />
          </CardAction>
        </CardHeader>
      </Card>
    </li>
  );
}
