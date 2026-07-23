import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Heart,
  Flame,
  MoreHorizontal,
  Share2,
  Link2,
  RefreshCw,
} from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import { ErrorState } from "@/shared/components/ErrorState";
import type {
  FollowUser,
  HistoryItem,
  LivePlayQuality,
  LiveRoomDetail,
  PlayUrl,
  SiteId,
} from "@/shared/types/live";
import { PlayerPane } from "./PlayerPane";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Spinner } from "@/components/ui/spinner";
import { clampIndex } from "@/lib/playUrl";
import { formatOnline, SITE_LABELS, cn } from "@/lib/utils";

function errMessage(e: unknown): string {
  if (typeof e === "object" && e && "message" in e) {
    return String((e as { message: string }).message);
  }
  return String(e ?? "未知错误");
}

export function RoomPage() {
  const navigate = useNavigate();
  const { siteId: siteParam, roomId: roomParam } = useParams<{
    siteId: string;
    roomId: string;
  }>();
  const siteId = siteParam as SiteId | undefined;
  const roomId = roomParam ? decodeURIComponent(roomParam) : undefined;
  const qc = useQueryClient();

  const [qualityIndex, setQualityIndex] = useState(0);
  const [lineIndex, setLineIndex] = useState(0);
  const [followBusy, setFollowBusy] = useState(false);
  const [danmakuStatus, setDanmakuStatus] = useState<string | null>(null);

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

  // Danmaku lifecycle — surface errors instead of swallowing.
  useEffect(() => {
    if (!siteId || !roomId || !detailQuery.data) return;
    let cancelled = false;
    setDanmakuStatus("正在连接弹幕服务器…");
    void invokeCmd("danmaku_connect", { siteId, roomId })
      .then(() => {
        if (!cancelled) setDanmakuStatus(null);
      })
      .catch((e) => {
        if (!cancelled) setDanmakuStatus(`弹幕连接失败：${errMessage(e)}`);
      });
    return () => {
      cancelled = true;
      void invokeCmd("danmaku_disconnect").catch(() => {});
    };
  }, [siteId, roomId, detailQuery.data?.room_id]);

  const followQuery = useQuery({
    queryKey: ["follows"],
    queryFn: () => invokeCmd<FollowUser[]>("follow_list"),
  });

  const isFollowed = useMemo(() => {
    if (!siteId || !roomId || !followQuery.data) return false;
    return followQuery.data.some(
      (f) => f.site_id === siteId && f.room_id === roomId,
    );
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

  const qualitiesQuery = useQuery({
    queryKey: ["play_qualities", siteId, roomId, detailQuery.data?.room_id],
    enabled: !!detailQuery.data,
    queryFn: () =>
      invokeCmd<LivePlayQuality[]>("site_get_play_qualities", {
        siteId,
        detail: detailQuery.data,
      }),
  });

  useEffect(() => {
    setQualityIndex(0);
    setLineIndex(0);
  }, [qualitiesQuery.data]);

  const selectedQuality: LivePlayQuality | null = useMemo(() => {
    const list = qualitiesQuery.data;
    if (!list || list.length === 0) return null;
    return list[Math.min(qualityIndex, list.length - 1)] ?? null;
  }, [qualitiesQuery.data, qualityIndex]);

  useEffect(() => {
    setLineIndex(0);
  }, [selectedQuality?.quality, selectedQuality?.data]);

  const playUrlQuery = useQuery({
    queryKey: [
      "play_urls",
      siteId,
      roomId,
      selectedQuality?.quality,
      selectedQuality?.data,
    ],
    enabled: !!detailQuery.data && !!selectedQuality,
    queryFn: () =>
      invokeCmd<PlayUrl[]>("site_get_play_urls", {
        siteId,
        detail: detailQuery.data,
        quality: selectedQuality,
      }),
  });

  const playUrls = playUrlQuery.data ?? [];
  const playUrl = playUrls[clampIndex(lineIndex, playUrls.length)] ?? null;

  const retryPlay = useCallback(() => {
    void qualitiesQuery.refetch().then(() => playUrlQuery.refetch());
  }, [qualitiesQuery, playUrlQuery]);

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
        <RoomTopBar onBack={() => navigate(-1)} title="加载中…" />
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="size-8 text-primary" />
        </div>
      </div>
    );
  }

  if (detailQuery.isError) {
    return (
      <div className="flex h-full flex-col">
        <RoomTopBar onBack={() => navigate(-1)} title="加载失败" />
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

  const sideHeader = (
    <div className="shrink-0 border-b border-border px-3 py-3">
      <div className="flex items-start gap-2.5">
        <Avatar className="size-11">
          <AvatarImage src={detail.user_avatar || undefined} alt="" />
          <AvatarFallback>
            {(detail.user_name || "?").slice(0, 1)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{detail.user_name}</p>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span>{SITE_LABELS[detail.site_id] ?? detail.site_id}</span>
            <span className="inline-flex items-center gap-0.5 text-orange-400">
              <Flame className="size-3" />
              {formatOnline(detail.online)}
            </span>
          </div>
        </div>
        <Button variant="ghost" size="icon-sm" disabled title="更多">
          <MoreHorizontal />
        </Button>
      </div>
      {detail.title && (
        <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
          {detail.title}
        </p>
      )}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Top chrome is OUTSIDE the mpv HWND host — always visible & clickable */}
      <RoomTopBar
        onBack={() => navigate(-1)}
        title={detail.title || "直播间"}
        subtitle={`${detail.user_name} · ${SITE_LABELS[detail.site_id] ?? detail.site_id}`}
        live={detail.status}
      />

      <div className="min-h-0 flex-1">
        <PlayerPane
          playUrl={playUrl}
          loading={
            qualitiesQuery.isLoading ||
            (qualitiesQuery.isSuccess && playUrlQuery.isLoading)
          }
          error={
            qualitiesQuery.isError
              ? qualitiesQuery.error
              : playUrlQuery.isError
                ? playUrlQuery.error
                : qualitiesQuery.isSuccess &&
                    playUrlQuery.isSuccess &&
                    !playUrl
                  ? {
                      code: "no_play_url",
                      message: "当前清晰度没有可用播放地址",
                      site: siteId,
                      retryable: true,
                    }
                  : undefined
          }
          onRetry={retryPlay}
          title={detail.title}
          danmakuActive={!!detailQuery.data}
          danmakuStatusText={danmakuStatus}
          sideHeader={sideHeader}
          qualities={qualitiesQuery.data ?? []}
          qualityIndex={qualityIndex}
          onQualityChange={(i) => {
            setQualityIndex(i);
            setLineIndex(0);
          }}
          lines={playUrls}
          lineIndex={lineIndex}
          onLineChange={setLineIndex}
        />
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border bg-sidebar px-3 py-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void detailQuery.refetch()}
        >
          <RefreshCw data-icon="inline-start" />
          刷新
        </Button>
        <Button
          variant={isFollowed ? "secondary" : "default"}
          size="sm"
          disabled={followBusy}
          onClick={() => void toggleFollow()}
        >
          <Heart
            data-icon="inline-start"
            className={cn(isFollowed && "fill-current")}
          />
          {isFollowed ? "已关注" : "关注"}
        </Button>

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            title="复制房间页链接"
            onClick={() => {
              void navigator.clipboard?.writeText(
                detail.url || window.location.href,
              );
            }}
          >
            <Link2 data-icon="inline-start" />
            复制链接
          </Button>
          <Button
            variant="secondary"
            size="sm"
            title="复制当前播放直链（流地址）"
            disabled={!playUrl?.url}
            onClick={() => {
              if (playUrl?.url) {
                void navigator.clipboard?.writeText(playUrl.url);
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

function RoomTopBar({
  onBack,
  title,
  subtitle,
  live,
}: {
  onBack: () => void;
  title: string;
  subtitle?: string;
  live?: boolean;
}) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-sidebar px-2">
      <Button
        variant="ghost"
        size="icon"
        onClick={onBack}
        aria-label="返回"
        title="返回"
      >
        <ArrowLeft />
      </Button>
      <Link to="/" className="sr-only" tabIndex={-1}>
        首页
      </Link>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{title}</p>
        {subtitle && (
          <p className="truncate text-[11px] text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {live != null &&
        (live ? (
          <Badge className="animate-live bg-accent text-accent-foreground">
            LIVE
          </Badge>
        ) : (
          <Badge variant="secondary">未开播</Badge>
        ))}
    </header>
  );
}
