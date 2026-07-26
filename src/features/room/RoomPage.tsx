import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Share2, Link2 } from "lucide-react";
import { gsap } from "gsap";
import { invokeCmd } from "@/shared/api/tauri";
import { ErrorState } from "@/shared/components/ErrorState";
import type { FollowUser, HistoryItem, LiveRoomDetail, SiteId } from "@/shared/types/live";
import { PlayerPane } from "./PlayerPane";
import type { RoomSideTab } from "./PlayerPane";
import { RoomHostInfo } from "./RoomHostInfo";
import { roomNavigationReturnsHome, roomSideTabFromNavigationState } from "./roomNavigation";
import { usePlaybackController } from "./playback/usePlaybackController";
import { useDanmakuConnection } from "./danmaku/useDanmakuConnection";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export function RoomPage() {
  const { siteId: siteParam, roomId: roomParam } = useParams<{
    siteId: string;
    roomId: string;
  }>();
  const siteId = siteParam as SiteId | undefined;
  const roomId = roomParam ? decodeURIComponent(roomParam) : undefined;
  const location = useLocation();
  const qc = useQueryClient();

  const [followBusy, setFollowBusy] = useState(false);
  const requestedSideTab = roomSideTabFromNavigationState(location.state);
  const returnToHome = roomNavigationReturnsHome(location.state);
  const [sideTab, setSideTab] = useState<RoomSideTab>(requestedSideTab);

  // A regular room navigation starts at chat, while a navigation initiated by
  // FollowPanel keeps the follow picker open. This also covers a router setup
  // that reuses RoomPage instead of remounting it for param-only changes.
  useEffect(() => {
    setSideTab(requestedSideTab);
  }, [location.key, requestedSideTab]);

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
        <RoomTopBar title="加载中…" returnToHome={returnToHome} />
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="size-8 text-primary" />
        </div>
      </div>
    );
  }

  if (detailQuery.isError) {
    return (
      <div className="flex h-full flex-col">
        <RoomTopBar title="加载失败" returnToHome={returnToHome} />
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
    <RoomHostInfo
      detail={detail}
      isFollowed={isFollowed}
      followBusy={followBusy}
      onToggleFollow={() => void toggleFollow()}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <RoomTopBar title={detail.title || "直播间"} returnToHome={returnToHome} />

      <div className="flex min-h-0 flex-1 flex-col">
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
          siteId={siteId}
          roomId={detail.room_id}
        />
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 border-t border-border/80 bg-sidebar/90 px-3 py-1.5">
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
  );
}

function RoomTopBar({ title, returnToHome = false }: { title: string; returnToHome?: boolean }) {
  const navigate = useNavigate();
  const topBarRef = useRef<HTMLElement>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLParagraphElement>(null);
  const reduceMotion = useReducedMotionPreference();

  useLayoutEffect(() => {
    const topBar = topBarRef.current;
    const backButton = backButtonRef.current;
    const roomTitle = titleRef.current;
    if (reduceMotion || !topBar || !backButton || !roomTitle) return;

    const context = gsap.context(() => {
      gsap
        .timeline({ defaults: { ease: "power3.out" } })
        .from(backButton, { autoAlpha: 0, duration: 0.32, x: -12 })
        .from(roomTitle, { autoAlpha: 0, duration: 0.28, y: -6 }, "-=0.16");
    }, topBar);

    return () => {
      gsap.killTweensOf(backButton);
      context.revert();
    };
  }, [reduceMotion]);

  function goBack() {
    if (returnToHome) {
      navigate("/", { replace: true });
      return;
    }
    const historyState = window.history.state as { idx?: number } | null;
    if (typeof historyState?.idx === "number" && historyState.idx > 0) {
      navigate(-1);
      return;
    }
    navigate("/", { replace: true });
  }

  function animateBackButton(offset: number) {
    if (reduceMotion || !backButtonRef.current) return;
    gsap.to(backButtonRef.current, {
      duration: 0.18,
      ease: "power2.out",
      overwrite: "auto",
      x: offset,
    });
  }

  return (
    <header
      ref={topBarRef}
      className="relative flex h-11 shrink-0 items-center justify-center border-b border-border/80 bg-sidebar/90 px-3"
    >
      <Button
        ref={backButtonRef}
        variant="ghost"
        size="icon-sm"
        className="absolute left-3 z-10 rounded-lg hover:bg-muted/70"
        aria-label="返回上一页"
        title="返回上一页"
        onClick={goBack}
        onPointerEnter={() => animateBackButton(-2)}
        onPointerLeave={() => animateBackButton(0)}
      >
        <ChevronLeft data-icon="inline-start" aria-hidden />
      </Button>
      <p
        ref={titleRef}
        className="absolute inset-x-14 truncate text-center text-sm font-semibold tracking-tight text-foreground/90"
        title={title}
      >
        {title}
      </p>
    </header>
  );
}

function useReducedMotionPreference() {
  const [reduceMotion, setReduceMotion] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setReduceMotion(query.matches);
    updatePreference();
    query.addEventListener("change", updatePreference);
    return () => query.removeEventListener("change", updatePreference);
  }, []);

  return reduceMotion;
}
