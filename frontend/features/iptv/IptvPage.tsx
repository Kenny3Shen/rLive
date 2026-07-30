import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { ListFilter, Play, Radio, RefreshCw, Search, Tv, X } from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import { ErrorState } from "@/shared/components/ErrorState";
import { PageHeader } from "@/shared/components/PageHeader";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldLabel } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { filterIptvChannels, getIptvGroupOptions } from "./filterChannels";
import { iptvHomePath, iptvPlayerPath } from "./iptvRoute";
import { builtInSources, playlistSourceFromRoute } from "./playlistSource";
import type { PlaylistSource } from "./playlistSource";
import type { IptvChannel } from "./types";

const EMPTY_CHANNELS: IptvChannel[] = [];
const CHANNEL_PAGE_SIZE = 120;
const QUICK_GROUP_LIMIT = 5;

/**
 * IPTV discovery deliberately does not render a player. Selecting a card is
 * the only path to the separate playback route, so simply entering /iptv can
 * never start a stream or claim a proxy session.
 */
export function IptvPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const iptvCustomM3uUrl = useSettingsStore((state) => state.iptvCustomM3uUrl);
  const sourceId = searchParams.get("source");
  const sourceUrl = searchParams.get("m3u");
  const source = useMemo(
    () => playlistSourceFromRoute(sourceId, sourceUrl ?? iptvCustomM3uUrl),
    [iptvCustomM3uUrl, sourceId, sourceUrl],
  );
  const configuredCustomSource = useMemo(() => {
    const resolved = playlistSourceFromRoute("custom", iptvCustomM3uUrl);
    return resolved.id === "custom" ? resolved : null;
  }, [iptvCustomM3uUrl]);
  const selectedGroup = searchParams.get("group") ?? "all";
  const keyword = searchParams.get("q") ?? "";
  const [channelLimit, setChannelLimit] = useState(CHANNEL_PAGE_SIZE);

  const playlistQuery = useQuery({
    queryKey: ["iptv_playlist", source.url],
    queryFn: () => invokeCmd<IptvChannel[]>("iptv_load_playlist", { sourceUrl: source.url }),
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
  });
  const channels = playlistQuery.data ?? EMPTY_CHANNELS;
  const groupOptions = useMemo(() => getIptvGroupOptions(channels), [channels]);
  const filteredChannels = useMemo(
    () => filterIptvChannels(channels, { group: selectedGroup, query: keyword }),
    [channels, keyword, selectedGroup],
  );
  const displayedChannels = useMemo(
    () => filteredChannels.slice(0, channelLimit),
    [channelLimit, filteredChannels],
  );
  const quickGroups = groupOptions.slice(0, QUICK_GROUP_LIMIT);
  const hasFilters = selectedGroup !== "all" || keyword.trim().length > 0;

  useEffect(() => {
    // A source may have changed since this URL was last visited. Do not keep a
    // category that has no possible result, but wait for a real list before
    // deciding so initial loading does not erase a valid deep-link filter.
    if (
      channels.length > 0 &&
      selectedGroup !== "all" &&
      !groupOptions.some((group) => group.value === selectedGroup)
    ) {
      navigate(iptvHomePath({ source, group: "all", query: keyword }), { replace: true });
    }
  }, [channels.length, groupOptions, keyword, navigate, selectedGroup, source]);

  useEffect(() => {
    setChannelLimit(CHANNEL_PAGE_SIZE);
  }, [keyword, selectedGroup, source.url]);

  function navigateHome(
    next: Partial<{ source: PlaylistSource; group: string; query: string }>,
    replace = false,
  ) {
    navigate(
      iptvHomePath({
        source: next.source ?? source,
        group: next.group ?? selectedGroup,
        query: next.query ?? keyword,
      }),
      { replace },
    );
  }

  function chooseSource(id: string) {
    const next =
      id === "custom"
        ? configuredCustomSource
        : builtInSources.find((candidate) => candidate.id === id);
    if (next && next.url !== source.url) {
      navigate(iptvHomePath({ source: next }));
    }
  }

  function clearFilters() {
    navigateHome({ group: "all", query: "" }, true);
  }

  function openChannel(channel: IptvChannel) {
    const returnTo = `${location.pathname}${location.search}`;
    navigate(
      iptvPlayerPath({
        source,
        channelUrl: channel.url,
        group: selectedGroup,
        query: keyword,
      }),
      { state: { returnTo } },
    );
  }

  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-4">
      <PageHeader
        title="IPTV"
        description={`当前源：${source.label}。选择分类和频道后进入独立播放页；自定义 M3U 地址可在设置 › 网络中管理。`}
        actions={
          <>
            <ToggleGroup
              aria-label="IPTV 频道源"
              value={[source.id]}
              variant="outline"
              size="sm"
              spacing={1}
              className="max-w-full flex-wrap justify-end"
              onValueChange={(values) => {
                const next = values[0];
                if (next) chooseSource(next);
              }}
            >
              {builtInSources.map((candidate) => (
                <ToggleGroupItem key={candidate.id} value={candidate.id}>
                  {candidate.label}
                </ToggleGroupItem>
              ))}
              {(configuredCustomSource || source.id === "custom") && (
                <ToggleGroupItem value="custom">自定义源</ToggleGroupItem>
              )}
            </ToggleGroup>
            <Button
              variant="outline"
              onClick={() => void playlistQuery.refetch()}
              disabled={playlistQuery.isFetching}
            >
              <RefreshCw data-icon="inline-start" aria-hidden />
              刷新频道
            </Button>
          </>
        }
      />

      {playlistQuery.isError && channels.length === 0 ? (
        <ErrorState
          error={playlistQuery.error}
          title="IPTV 频道列表加载失败"
          onRetry={() => void playlistQuery.refetch()}
        />
      ) : (
        <section
          aria-labelledby="iptv-channel-library-title"
          className="flex min-h-[32rem] flex-col gap-4 rounded-2xl border border-border-subtle bg-card/45 p-3 md:p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <Radio className="size-4 text-primary" aria-hidden />
              <h2 id="iptv-channel-library-title" className="truncate text-base font-semibold">
                频道列表
              </h2>
              <Badge variant={hasFilters ? "secondary" : "outline"} aria-live="polite">
                {hasFilters ? `${filteredChannels.length} / ${channels.length}` : channels.length}
              </Badge>
            </div>
            {hasFilters && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <X data-icon="inline-start" aria-hidden />
                清除筛选
              </Button>
            )}
          </div>

          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_13rem]">
            <Field>
              <FieldLabel htmlFor="iptv-channel-search" className="sr-only">
                搜索频道
              </FieldLabel>
              <FieldContent>
                <InputGroup>
                  <InputGroupAddon>
                    <Search aria-hidden />
                  </InputGroupAddon>
                  <InputGroupInput
                    id="iptv-channel-search"
                    value={keyword}
                    onChange={(event) => navigateHome({ query: event.target.value }, true)}
                    placeholder="搜索频道或分类（支持多个关键词）"
                    autoComplete="off"
                  />
                  {!playlistQuery.isLoading && (
                    <InputGroupAddon align="inline-end">
                      <InputGroupText>{filteredChannels.length} 个</InputGroupText>
                    </InputGroupAddon>
                  )}
                </InputGroup>
              </FieldContent>
            </Field>

            <Field>
              <FieldLabel className="sr-only">频道分类</FieldLabel>
              <FieldContent>
                <Select
                  value={selectedGroup}
                  onValueChange={(value) => navigateHome({ group: value ?? "all" })}
                >
                  <SelectTrigger className="w-full" aria-label="频道分类">
                    <ListFilter data-icon="inline-start" aria-hidden />
                    <SelectValue placeholder="全部分类">
                      {selectedGroup === "all" ? "全部分类" : selectedGroup}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="all">全部分类</SelectItem>
                      {groupOptions.map((group) => (
                        <SelectItem key={group.value} value={group.value}>
                          <span className="min-w-0 flex-1 truncate">{group.value}</span>
                          <span className="text-xs text-muted-foreground">{group.count}</span>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </FieldContent>
            </Field>
          </div>

          {quickGroups.length > 0 && (
            <ToggleGroup
              aria-label="常用频道分类"
              value={[selectedGroup]}
              variant="outline"
              size="sm"
              spacing={1}
              className="w-full flex-wrap"
              onValueChange={(values) => navigateHome({ group: values[0] ?? "all" })}
            >
              <ToggleGroupItem value="all">全部</ToggleGroupItem>
              {quickGroups.map((group) => (
                <ToggleGroupItem key={group.value} value={group.value}>
                  {group.value} {group.count}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          )}

          {playlistQuery.isLoading ? (
            <div className="flex min-h-64 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
              <Spinner aria-label="正在加载频道" />
              正在读取频道列表…
            </div>
          ) : filteredChannels.length === 0 ? (
            <div className="flex min-h-64 flex-col items-center justify-center gap-2 px-4 text-center text-sm text-muted-foreground">
              <Tv className="size-6" aria-hidden />
              <p>没有符合条件的频道</p>
              {hasFilters && (
                <Button variant="outline" size="sm" onClick={clearFilters}>
                  清除筛选
                </Button>
              )}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-x-3 gap-y-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                {displayedChannels.map((channel) => (
                  <IptvChannelCard key={channel.url} channel={channel} onOpen={openChannel} />
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

      <p className="px-1 text-xs leading-relaxed text-muted-foreground">
        仅观看你所在地允许访问、且你有权使用的频道。rLive
        不托管任何节目流，也不会绕过地区或版权限制。
      </p>
    </div>
  );
}

function IptvChannelCard({
  channel,
  onOpen,
}: {
  channel: IptvChannel;
  onOpen: (channel: IptvChannel) => void;
}) {
  const group = channel.group || "未分组";

  return (
    <button
      type="button"
      onClick={() => onOpen(channel)}
      className={cn(
        "group flex w-full flex-col overflow-hidden rounded-xl bg-transparent text-left transition-transform focus-ring",
        "hover:-translate-y-0.5",
      )}
      aria-label={`播放 ${channel.name}`}
    >
      <div className="relative aspect-video overflow-hidden rounded-xl bg-muted shadow-md shadow-black/20 ring-1 ring-border/70">
        {channel.logo ? (
          <img
            src={channel.logo}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            className="size-full object-contain p-6 transition duration-300 group-hover:scale-[1.04]"
          />
        ) : (
          <div className="flex size-full items-center justify-center text-muted-foreground">
            <Tv className="size-8" aria-hidden />
          </div>
        )}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-transparent" />
        <Badge variant="secondary" className="absolute right-2 bottom-2 max-w-[70%] truncate">
          {group}
        </Badge>
        <span className="absolute top-2 right-2 flex size-7 items-center justify-center rounded-full bg-background/80 text-foreground opacity-0 shadow-sm backdrop-blur transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100">
          <Play className="size-3.5 fill-current" aria-hidden />
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-0.5 px-0.5 pt-2.5 pb-1">
        <p className="line-clamp-1 text-[13px] font-medium leading-snug text-foreground">
          {channel.name || "未命名频道"}
        </p>
        <p className="truncate text-xs text-muted-foreground">点击进入播放页</p>
      </div>
    </button>
  );
}
