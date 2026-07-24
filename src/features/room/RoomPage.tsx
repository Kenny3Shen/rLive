import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Flame, Heart, Share2, Link2 } from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import { ErrorState } from "@/shared/components/ErrorState";
import type { FollowUser, HistoryItem, LiveRoomDetail, SiteId } from "@/shared/types/live";
import { PlayerPane } from "./PlayerPane";
import type { RoomSideTab } from "./PlayerPane";
import { usePlaybackController } from "./playback/usePlaybackController";
import { useDanmakuConnection } from "./danmaku/useDanmakuConnection";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Spinner } from "@/components/ui/spinner";
import { SiteLogo } from "@/shared/components/SiteLogo";
import { formatOnline, SITE_LABELS, cn, normalizeImageUrl } from "@/lib/utils";

export function RoomPage() {
  const { siteId: siteParam, roomId: roomParam } = useParams<{
    siteId: string;
    roomId: string;
  }>();
  const siteId = siteParam as SiteId | undefined;
  const roomId = roomParam ? decodeURIComponent(roomParam) : undefined;
  const qc = useQueryClient();

  const [followBusy, setFollowBusy] = useState(false);
  const [sideTab, setSideTab] = useState<RoomSideTab>("chat");

  const detailQuery = useQuery({
    queryKey: ["room_detail", siteId, roomId],
    enabled: !!siteId && !!roomId,
    queryFn: () =>
      invokeCmd<LiveRoomDetail>("site_get_room_detail", {
        siteId,
        roomId,
      }),
  });

  useEffect(() => {
    const detail = detailQuery.data;
    if (!detail) return;
    const item: HistoryItem = {
      site_id: detail.site_id,
      room_id: detail.room_id,
      title: detail.title,
      user_name: detail.user_name,
      watched_at: Date.now(),
    };
    void invokeCmd("history_add", { item }).catch(() => {});
  }, [detailQuery.data]);

  const danmaku = useDanmakuConnection({
    siteId,
    roomId,
    detailRoomId: detailQuery.data?.room_id,
    enabled: !!detailQuery.data,
  });

  const playback = usePlaybackController({
    siteId,
    roomId,
    detail: detailQuery.data,
    enabled: !!detailQuery.data,
  });

  const followQuery = useQuery({
    queryKey: ["follows"],
    queryFn: () => invokeCmd<FollowUser[]>("follow_list"),
  });

  const isFollowed = useMemo(() => {
    if (!siteId || !roomId || !followQuery.data) return false;
    return followQuery.data.some((f) => f.site_id === siteId && f.room_id === roomId);
  }, [followQuery.data, siteId, roomId]);

  async function toggleFollow() {
    const detail = detailQuery.data;
    if (!detail || !siteId || !roomId) return;
    setFollowBusy(true);
    try {
      if (isFollowed) {
        await invokeCmd("follow_remove", { siteId, roomId });
      } else {
        const user: FollowUser = {
          site_id: detail.site_id,
          room_id: detail.room_id,
          user_name: detail.user_name,
          face: detail.user_avatar,
          tag_ids: [],
          live_status: detail.status,
          updated_at: Date.now(),
        };
        await invokeCmd("follow_add", { user });
      }
      await qc.invalidateQueries({ queryKey: ["follows"] });
    } finally {
      setFollowBusy(false);
    }
  }

  if (!siteId || !roomId) {
    return (
      <div className="p-6">
        <ErrorState
          error={{
            code: "bad_route",
            message: "缺少平台或房间号",
            site: null,
            retryable: false,
          }}
          title="无效的直播间链接"
        />
      </div>
    );
  }

  const detail = detailQuery.data;

  if (detailQuery.isLoading) {
    return (
      <div className="flex h-full flex-col">
        <RoomTopBar title="加载中…" />
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="size-8 text-primary" />
        </div>
      </div>
    );
  }

  if (detailQuery.isError) {
    return (
      <div className="flex h-full flex-col">
        <RoomTopBar title="加载失败" />
        <div className="p-6">
          <ErrorState
            error={detailQuery.error}
            title="直播间加载失败"
            onRetry={() => void detailQuery.refetch()}
          />
        </div>
      </div>
    );
  }

  if (!detail) return null;

  const platformLabel = SITE_LABELS[detail.site_id] ?? detail.site_id;
  const onlineLabel = formatOnline(detail.online);

  const sideHeader = (
    <div className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-3">
      <Avatar size="lg" className="size-11">
        <AvatarImage
          src={normalizeImageUrl(detail.user_avatar)}
          alt={detail.user_name}
          referrerPolicy="no-referrer"
        />
        <AvatarFallback>{(detail.user_name || "?").slice(0, 1)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold leading-5">{detail.user_name || "未知主播"}</p>
        <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="flex min-w-0 items-center gap-1 truncate" title={platformLabel}>
            <SiteLogo siteId={detail.site_id} className="size-3.5" />
            <span className="truncate">{platformLabel}</span>
          </span>
          <span
            className="flex shrink-0 items-center gap-1 text-orange-400"
            title={`当前热度 ${onlineLabel}`}
          >
            <Flame className="size-3.5" aria-hidden />
            <span>{onlineLabel}</span>
          </span>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <RoomTopBar title={detail.title || "直播间"} />

      <div className="min-h-0 flex-1">
        <PlayerPane
          playUrl={playback.playUrl}
          loading={playback.loading}
          error={playback.error}
          onRetry={playback.retryPlay}
          danmakuActive={danmaku.active}
          danmakuStatusText={danmaku.statusText}
          sideHeader={sideHeader}
          qualities={playback.qualities}
          qualityIndex={playback.qualityIndex}
          onQualityChange={playback.onQualityChange}
          lines={playback.lines}
          lineIndex={playback.lineIndex}
          onLineChange={playback.onLineChange}
          onRefresh={playback.retryPlay}
          loadError={playback.loadError}
          reloadToken={playback.reloadToken}
          onPlayerMediaFailure={playback.onPlayerMediaFailure}
          onPlayerPlaying={playback.onPlayerPlaying}
          roomSessionKey={`${siteId}:${roomId}`}
          sideTab={sideTab}
          onSideTabChange={setSideTab}
        />
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border bg-sidebar px-3 py-2">
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={followBusy}
          onClick={() => void toggleFollow()}
          aria-label={isFollowed ? "取消关注" : "关注"}
          aria-pressed={isFollowed}
          title={isFollowed ? "取消关注" : "关注"}
        >
          <Heart className={cn(isFollowed && "fill-current")} />
        </Button>

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            title="复制房间页链接"
            onClick={() => {
              void navigator.clipboard?.writeText(detail.url || window.location.href);
            }}
          >
            <Link2 data-icon="inline-start" />
            复制链接
          </Button>
          <Button
            variant="ghost"
            size="sm"
            title="复制当前播放直链（流地址）"
            disabled={!playback.playUrl?.url}
            onClick={() => {
              if (playback.playUrl?.url) {
                void navigator.clipboard?.writeText(playback.playUrl.url);
              }
            }}
          >
            <Share2 data-icon="inline-start" />
            复制直链
          </Button>
        </div>
      </div>
    </div>
  );
}

function RoomTopBar({ title }: { title: string }) {
  return (
    <header className="flex h-12 shrink-0 items-center justify-center border-b border-border bg-sidebar px-4">
      <p className="max-w-full truncate text-sm font-medium">{title}</p>
    </header>
  );
}
