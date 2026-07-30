import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Ellipsis, Link2, Share2 } from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import { copyText } from "@/shared/clipboard";
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
import { notify } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { FOLLOW_LIST_QUERY_KEY } from "../follow/followRefresh";

export function RoomPage() {
  const { siteId: siteParam, roomId: roomParam } = useParams<{
    siteId: string;
    roomId: string;
  }>();
  const siteId = siteParam as SiteId | undefined;
  const roomId = roomParam ? decodeURIComponent(roomParam) : undefined;
  const location = useLocation();
  const qc = useQueryClient();
  const recordedHistoryRoomRef = useRef<string | null>(null);

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
    const roomKey = `${detail.site_id}\u0000${detail.room_id}`;
    // Detail queries can refresh after reconnects or cache invalidations. A
    // revisit should update history once, not write SQLite on every payload
    // replacement while the same room remains open.
    if (recordedHistoryRoomRef.current === roomKey) return;
    recordedHistoryRoomRef.current = roomKey;
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
    queryKey: FOLLOW_LIST_QUERY_KEY,
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
          live_started_at: detail.status ? (detail.live_started_at ?? null) : null,
          updated_at: Date.now(),
        };
        await invokeCmd("follow_add", { user });
      }
      await qc.invalidateQueries({ queryKey: FOLLOW_LIST_QUERY_KEY });
      notify.success(isFollowed ? "已取消关注" : "已关注主播");
    } catch {
      notify.error(isFollowed ? "取消关注失败" : "关注失败", "请检查网络后重试。");
    } finally {
      setFollowBusy(false);
    }
  }

  async function copyRoomValue(value: string, successMessage: string) {
    if (await copyText(value)) {
      notify.success(successMessage);
    } else {
      notify.error("复制失败", "请手动选择并复制。");
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
      <RoomTopBar
        title={detail.title || "直播间"}
        returnToHome={returnToHome}
        rightSlot={
          <div className="md:hidden">
            <RoomMobileActions
              roomUrl={detail.url || window.location.href}
              playbackUrl={playback.playUrl?.url}
              onCopy={copyRoomValue}
            />
          </div>
        }
      />

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

      <div className="hidden shrink-0 flex-wrap items-center justify-end gap-1.5 border-t border-border/80 bg-sidebar/90 px-3 pt-1.5 pb-[calc(0.375rem+env(safe-area-inset-bottom))] md:flex">
        <Button
          variant="ghost"
          size="sm"
          className="max-md:h-11 max-md:touch-manipulation"
          onClick={() => void copyRoomValue(detail.url || window.location.href, "已复制房间链接")}
        >
          <Link2 data-icon="inline-start" />
          复制链接
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="max-md:h-11 max-md:touch-manipulation"
          disabled={!playback.playUrl?.url}
          onClick={() => {
            if (playback.playUrl?.url) {
              void copyRoomValue(playback.playUrl.url, "已复制播放直链");
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

function RoomTopBar({
  title,
  returnToHome = false,
  rightSlot,
}: {
  title: string;
  returnToHome?: boolean;
  rightSlot?: ReactNode;
}) {
  const navigate = useNavigate();
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLParagraphElement>(null);
  const reduceMotion = useReducedMotionPreference();

  useLayoutEffect(() => {
    const backButton = backButtonRef.current;
    const roomTitle = titleRef.current;
    if (reduceMotion || !backButton || !roomTitle) return;

    const easing = "cubic-bezier(0.16, 1, 0.3, 1)";
    const animations = [
      backButton.animate(
        [
          { opacity: 0, transform: "translate3d(-12px, 0, 0)" },
          { opacity: 1, transform: "translate3d(0, 0, 0)" },
        ],
        { duration: 320, easing, fill: "both" },
      ),
      roomTitle.animate(
        [
          { opacity: 0, transform: "translate3d(0, -6px, 0)" },
          { opacity: 1, transform: "translate3d(0, 0, 0)" },
        ],
        { delay: 160, duration: 280, easing, fill: "both" },
      ),
    ];
    // Let the regular hover transform control the back button after its
    // entrance motion has finished.
    animations.forEach((animation) => {
      animation.addEventListener("finish", () => animation.cancel(), { once: true });
    });

    return () => {
      animations.forEach((animation) => animation.cancel());
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

  return (
    <header className="relative flex h-11 shrink-0 items-center justify-center border-b border-border/80 bg-sidebar/90 px-3">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              ref={backButtonRef}
              variant="ghost"
              size="icon-sm"
              className="absolute left-3 z-10 rounded-lg transition-transform hover:-translate-x-0.5 hover:bg-muted/70 max-md:size-11 max-md:touch-manipulation"
              aria-label="返回上一页"
              onClick={goBack}
            >
              <ChevronLeft data-icon="inline-start" aria-hidden />
            </Button>
          }
        />
        <TooltipContent side="bottom">返回上一页</TooltipContent>
      </Tooltip>
      <p
        ref={titleRef}
        className="absolute inset-x-20 truncate text-center text-sm font-semibold tracking-tight text-foreground/90"
        title={title}
      >
        {title}
      </p>
      {rightSlot && <div className="absolute right-3 z-10">{rightSlot}</div>}
    </header>
  );
}

function RoomMobileActions({
  roomUrl,
  playbackUrl,
  onCopy,
}: {
  roomUrl: string;
  playbackUrl?: string;
  onCopy: (value: string, successMessage: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);

  function copy(value: string, successMessage: string) {
    setOpen(false);
    void onCopy(value, successMessage);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="size-11 touch-manipulation"
            aria-label="更多房间操作"
          >
            <Ellipsis data-icon="inline-start" aria-hidden />
          </Button>
        }
      />
      <PopoverContent side="bottom" align="end" className="w-52 gap-1 p-1.5">
        <PopoverTitle className="px-2 py-1 text-xs font-medium text-muted-foreground">
          房间操作
        </PopoverTitle>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-11 w-full justify-start text-sm touch-manipulation"
          onClick={() => copy(roomUrl, "已复制房间链接")}
        >
          <Link2 data-icon="inline-start" aria-hidden />
          复制链接
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-11 w-full justify-start text-sm touch-manipulation"
          disabled={!playbackUrl}
          onClick={() => {
            if (playbackUrl) copy(playbackUrl, "已复制播放直链");
          }}
        >
          <Share2 data-icon="inline-start" aria-hidden />
          复制直链
        </Button>
      </PopoverContent>
    </Popover>
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
