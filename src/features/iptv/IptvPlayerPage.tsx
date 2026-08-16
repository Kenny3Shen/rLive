import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, Heart, RefreshCw, Tv } from "lucide-react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { invokeCmd } from "@/shared/api/tauri";
import { ErrorState } from "@/shared/components/ErrorState";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { resolveIptvChannel, useIptvFavoriteMutation, useIptvFavorites } from "./favorites";
import { iptvChannelPlayUrl, IptvPlayer, type IptvPlaybackStatus } from "./IptvPlayer";
import { RecordingControl } from "@/features/recording/RecordingControl";
import { RecordingLeaveGuard } from "@/features/recording/RecordingLeaveGuard";
import type { RecordingContext } from "@/features/recording/recording";
import { iptvHomePath, iptvReturnPathFromState } from "./iptvRoute";
import {
  builtInSources,
  iptvFavoriteSourceId,
  iptvFavoriteSourceIdFromRoute,
  iptvUrlFingerprint,
  isHttpUrl,
  playlistSourceForFavorite,
  playlistSourceFromRoute,
} from "./playlistSource";
import type { IptvChannel } from "./types";

type IptvPlayerTopBarProps = {
  title: string;
  sourceLabel: string;
  group: string | null;
  status: IptvPlaybackStatus;
  reconnecting: boolean;
  reconnectEnabled: boolean;
  isFavorite: boolean;
  favoriteBusy: boolean;
  favoriteEnabled: boolean;
  backLabel: string;
  onBack: () => void;
  onReconnect: () => void;
  onToggleFavorite: () => void;
  recordingContext: RecordingContext | null;
};

function IptvPlayerTopBar({
  title,
  sourceLabel,
  group,
  status,
  reconnecting,
  reconnectEnabled,
  isFavorite,
  favoriteBusy,
  favoriteEnabled,
  backLabel,
  onBack,
  onReconnect,
  onToggleFavorite,
  recordingContext,
}: IptvPlayerTopBarProps) {
  return (
    <header className="relative flex h-11 shrink-0 items-center justify-center border-b border-border/80 bg-sidebar/90 px-3">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="motion-back-button absolute left-3 rounded-lg hover:bg-muted/70"
              aria-label={backLabel}
              onClick={onBack}
            />
          }
        >
          <ChevronLeft data-icon="inline-start" aria-hidden />
        </TooltipTrigger>
        <TooltipContent>{backLabel}</TooltipContent>
      </Tooltip>

      <div className="absolute inset-x-12 flex min-w-0 items-center justify-center px-12">
        <div className="min-w-0 text-center">
          <p
            className="truncate text-sm font-semibold tracking-tight text-foreground/90"
            title={title}
          >
            {title}
          </p>
          <p className="hidden truncate text-xs text-muted-foreground sm:block" title={sourceLabel}>
            {sourceLabel}
          </p>
        </div>
      </div>

      <div className="absolute right-3 flex items-center gap-1.5">
        <RecordingControl context={recordingContext} disabled={!recordingContext} />
        {favoriteEnabled && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant={isFavorite ? "secondary" : "ghost"}
                  size="icon-sm"
                  className={cn(isFavorite && "text-primary hover:text-primary")}
                  disabled={favoriteBusy}
                  aria-label={isFavorite ? "取消关注频道" : "关注频道"}
                  aria-pressed={isFavorite}
                  onClick={onToggleFavorite}
                />
              }
            >
              {favoriteBusy ? (
                <Spinner aria-hidden />
              ) : (
                <Heart className={cn(isFavorite && "fill-current")} aria-hidden />
              )}
            </TooltipTrigger>
            <TooltipContent>{isFavorite ? "取消关注" : "关注频道"}</TooltipContent>
          </Tooltip>
        )}
        {group && (
          <Badge variant="outline" className="hidden max-w-28 truncate md:inline-flex">
            {group}
          </Badge>
        )}
        {status === "playing" && (
          <Badge variant="secondary" className="hidden sm:inline-flex">
            播放中
          </Badge>
        )}
        {status === "connecting" && (
          <Badge variant="outline" className="hidden sm:inline-flex">
            <Spinner data-icon="inline-start" aria-hidden />
            连接中
          </Badge>
        )}
        {status === "error" && (
          <Badge variant="destructive" className="hidden sm:inline-flex">
            播放失败
          </Badge>
        )}
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <Button
              variant="ghost"
              size="sm"
              disabled={!reconnectEnabled || reconnecting}
              aria-label="重新连接频道"
              onClick={onReconnect}
            >
              {reconnecting ? (
                <Spinner data-icon="inline-start" aria-hidden />
              ) : (
                <RefreshCw data-icon="inline-start" aria-hidden />
              )}
              <span className="hidden sm:inline">{reconnecting ? "重连中" : "重连"}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>重新连接频道</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}

function PlayerPageState({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-background p-4 md:p-6">
      <div className="w-full max-w-xl">{children}</div>
    </main>
  );
}

export function IptvPlayerPage() {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [reloadToken, setReloadToken] = useState(0);
  const [playbackStatus, setPlaybackStatus] = useState<IptvPlaybackStatus>("idle");
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [manualReconnect, setManualReconnect] = useState(false);
  const iptvCustomM3uUrl = useSettingsStore((state) => state.iptvCustomM3uUrl);

  const requestedDirectUrl = searchParams.get("direct");
  const directUrl = isHttpUrl(requestedDirectUrl) ? requestedDirectUrl : null;
  const directRequested = requestedDirectUrl !== null;
  const isDirectPlayback = directUrl !== null;
  const sourceId = searchParams.get("source");
  const favoriteSourceOverride = iptvFavoriteSourceIdFromRoute(searchParams.get("favoriteSource"));
  // Keep accepting links generated by older builds, but new custom sources
  // resolve from the private, device-local settings value.
  const customSourceUrl = searchParams.get("m3u") ?? iptvCustomM3uUrl;
  const sourceIsValid = directRequested
    ? isDirectPlayback
    : sourceId === null ||
      builtInSources.some((candidate) => candidate.id === sourceId) ||
      (sourceId === "custom" && isHttpUrl(customSourceUrl)) ||
      favoriteSourceOverride !== null;
  const source = directRequested
    ? {
        id: "direct",
        label: "直链播放",
        description: "用户提供的媒体直链",
        url: directUrl ?? "",
      }
    : sourceId === "custom" && !isHttpUrl(customSourceUrl) && favoriteSourceOverride
      ? playlistSourceForFavorite(favoriteSourceOverride, customSourceUrl)
      : playlistSourceFromRoute(sourceId, customSourceUrl);
  const favoriteSourceId = isDirectPlayback
    ? "direct"
    : (favoriteSourceOverride ?? iptvFavoriteSourceId(source));
  const favoritesQuery = useIptvFavorites(favoriteSourceId, sourceIsValid && !isDirectPlayback);
  const favoriteMutation = useIptvFavoriteMutation(favoriteSourceId);
  const requestedChannelUrl = isDirectPlayback ? directUrl : searchParams.get("channel");
  const channelUrl = isHttpUrl(requestedChannelUrl) ? requestedChannelUrl : null;
  const group = searchParams.get("group");
  const query = searchParams.get("q");
  const stateReturnPath = iptvReturnPathFromState(location.state);
  const homePath = directRequested
    ? (stateReturnPath ?? "/settings?section=network")
    : iptvHomePath({ source, group, query });
  const returnPath = stateReturnPath ?? homePath;

  const handlePlaybackStatus = useCallback(
    (nextStatus: IptvPlaybackStatus, nextError: string | null) => {
      setPlaybackStatus(nextStatus);
      setPlaybackError(nextError);
      if (nextStatus !== "connecting") setManualReconnect(false);
    },
    [],
  );

  const handleReconnect = useCallback(() => {
    setManualReconnect(true);
    setPlaybackStatus("connecting");
    setPlaybackError(null);
    setReloadToken((token) => token + 1);
  }, []);

  const playlistQuery = useQuery({
    queryKey: ["iptv_playlist", source.url],
    queryFn: () => invokeCmd<IptvChannel[]>("iptv_load_playlist", { sourceUrl: source.url }),
    enabled: channelUrl !== null && sourceIsValid && !isDirectPlayback && isHttpUrl(source.url),
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
  });
  const channel = useMemo(() => {
    if (isDirectPlayback && channelUrl) {
      return {
        id: "direct",
        name: "直链播放",
        group: "",
        logo: null,
        url: channelUrl,
        headers: {},
      } satisfies IptvChannel;
    }
    return resolveIptvChannel(channelUrl, playlistQuery.data, favoritesQuery.data);
  }, [channelUrl, favoritesQuery.data, isDirectPlayback, playlistQuery.data]);

  const title = channel?.name ?? "IPTV 播放器";
  const recordingContext = useMemo<RecordingContext | null>(
    () =>
      channel
        ? {
            source: iptvChannelPlayUrl(channel),
            sourceKey: isDirectPlayback
              ? `iptv:direct:${iptvUrlFingerprint(channel.url)}`
              : `iptv:${favoriteSourceId}:${channel.id}`,
            sourceKind: "iptv",
            title: channel.name,
            cover: channel.logo ?? "",
          }
        : null,
    [channel, favoriteSourceId, isDirectPlayback],
  );
  const channelGroup = channel?.group || group;
  const isFavorite = Boolean(
    channel && favoritesQuery.data?.some((favorite) => favorite.url === channel.url),
  );

  function goBack() {
    // The state helper accepts only local application paths. Replacing this
    // route prevents a browser Back action from immediately reopening playback.
    navigate(returnPath, { replace: true });
  }

  const topBar = (
    <>
      <IptvPlayerTopBar
        title={title}
        sourceLabel={source.label}
        group={channelGroup}
        status={playbackStatus}
        reconnecting={manualReconnect || playbackStatus === "connecting"}
        reconnectEnabled={channel !== null && playbackStatus !== "connecting"}
        isFavorite={isFavorite}
        favoriteBusy={
          favoriteMutation.isPending && favoriteMutation.variables?.channel.url === channel?.url
        }
        favoriteEnabled={!isDirectPlayback && channel !== null && !favoritesQuery.isLoading}
        backLabel={directRequested ? "返回设置" : "返回频道列表"}
        onBack={goBack}
        onReconnect={handleReconnect}
        onToggleFavorite={() => {
          if (channel) favoriteMutation.mutate({ channel, isFavorite });
        }}
        recordingContext={recordingContext}
      />
      <RecordingLeaveGuard context={recordingContext} />
    </>
  );

  if (!channelUrl || !sourceIsValid) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        {topBar}
        <PlayerPageState>
          <ErrorState
            error={
              new Error(
                !sourceIsValid
                  ? directRequested
                    ? "直链无效，请返回设置页重新输入 HTTP(S) 媒体地址。"
                    : "频道源无效或缺少自定义 M3U 地址。请从 IPTV 首页重新选择频道。"
                  : "缺少有效的频道地址。请从 IPTV 首页选择频道。",
              )
            }
            title={directRequested ? "无效的直链播放链接" : "无效的 IPTV 播放链接"}
          />
        </PlayerPageState>
      </div>
    );
  }

  if (
    ((!isDirectPlayback && playlistQuery.isPending && isHttpUrl(source.url)) ||
      (!isDirectPlayback && favoritesQuery.isPending)) &&
    !channel
  ) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        {topBar}
        <PlayerPageState>
          <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            <Spinner className="size-6 text-primary" aria-label="正在加载频道" />
            <p>正在读取频道列表…</p>
          </div>
        </PlayerPageState>
      </div>
    );
  }

  if (playlistQuery.isError && isHttpUrl(source.url) && !channel) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        {topBar}
        <PlayerPageState>
          <ErrorState
            error={playlistQuery.error}
            title="IPTV 频道列表加载失败"
            onRetry={() => void playlistQuery.refetch()}
          />
        </PlayerPageState>
      </div>
    );
  }

  if (!channel) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        {topBar}
        <PlayerPageState>
          <ErrorState
            error={new Error("该频道已不在当前列表中，可能已被频道源更新或移除。")}
            title="找不到请求的频道"
            onRetry={() => void playlistQuery.refetch()}
          />
        </PlayerPageState>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {topBar}
      <main className="flex min-h-0 flex-1 flex-col bg-black">
        <div className="flex min-h-0 flex-1 items-center justify-center p-3 md:p-5">
          <div className="flex aspect-video h-full max-h-full max-w-full items-center">
            <IptvPlayer
              channel={channel}
              reloadToken={reloadToken}
              onStatusChange={handlePlaybackStatus}
              onReconnect={handleReconnect}
            />
          </div>
        </div>
        <footer
          data-slot="iptv-player-footer"
          className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border/80 bg-sidebar/90 px-3 py-2"
        >
          <Badge variant="outline">{source.label}</Badge>
          {channel.group && <Badge variant="secondary">{channel.group}</Badge>}
          <Badge
            variant={
              playbackStatus === "playing"
                ? "secondary"
                : playbackStatus === "error"
                  ? "destructive"
                  : "outline"
            }
            title={playbackError ?? undefined}
            aria-live="polite"
          >
            {playbackStatus === "connecting" && <Spinner data-icon="inline-start" aria-hidden />}
            {playbackStatus === "playing"
              ? "播放中"
              : playbackStatus === "error"
                ? "播放失败"
                : playbackStatus === "ready"
                  ? "已就绪"
                  : "连接中"}
          </Badge>
          <div className="min-w-0 flex-1" />
          <Tv className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </footer>
      </main>
    </div>
  );
}
