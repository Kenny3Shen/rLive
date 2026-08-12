import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  Ellipsis,
  Heart,
  Link2,
  PanelsTopLeft,
  Share2,
  UserRoundX,
} from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import { copyText } from "@/shared/clipboard";
import { supportsMultiRoom } from "@/shared/clientPlatform";
import { ErrorState } from "@/shared/components/ErrorState";
import { glassSurfaceClass } from "@/shared/components/player/glassSurface";
import type { FollowUser, HistoryItem, LiveRoomDetail, SiteId } from "@/shared/types/live";
import { PlayerPane } from "./PlayerPane";
import type { PlayerMobileRoomAction, RoomSideTab } from "./PlayerPane";
import type { PlayerHudRoomAction } from "./PlayerFullscreenHud";
import { RoomHostInfo } from "./RoomHostInfo";
import {
  roomBackTargetFromNavigationState,
  roomSideTabFromNavigationState,
} from "./roomNavigation";
import { usePlaybackController } from "./playback/usePlaybackController";
import { useDanmakuConnection } from "./danmaku/useDanmakuConnection";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { notify } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { FOLLOW_LIST_QUERY_KEY } from "../follow/followRefresh";
import { FollowGroupPickerDialog } from "../follow/FollowGroupPickerDialog";
import { tagIdsForFollowGroup, UNGROUPED_FOLLOW_GROUP_ID } from "../follow/followGroups";
import { useMultiRoomStore } from "../multi-room/multiRoomStore";

export function RoomPage() {
  const { siteId: siteParam, roomId: roomParam } = useParams<{
    siteId: string;
    roomId: string;
  }>();
  const siteId = siteParam as SiteId | undefined;
  const roomId = roomParam ? decodeURIComponent(roomParam) : undefined;
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const recordedHistoryRoomRef = useRef<string | null>(null);

  const [followBusy, setFollowBusy] = useState(false);
  const [followGroupOpen, setFollowGroupOpen] = useState(false);
  const [confirmUnfollowOpen, setConfirmUnfollowOpen] = useState(false);
  const requestedSideTab = roomSideTabFromNavigationState(location.state);
  const backTarget = roomBackTargetFromNavigationState(location.state);
  const [sideTab, setSideTab] = useState<RoomSideTab>(requestedSideTab);
  const [playerMobileActions, setPlayerMobileActions] = useState<readonly PlayerMobileRoomAction[]>(
    [],
  );

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
  const refetchRoomDetail = detailQuery.refetch;
  const refreshPlaybackDetail = useCallback(async () => {
    const result = await refetchRoomDetail();
    if (result.isError) throw result.error;
    return result.data;
  }, [refetchRoomDetail]);

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
      cover: detail.cover || undefined,
      watched_at: Date.now(),
    };
    void invokeCmd<void>("history_add", { item })
      .then(() => qc.invalidateQueries({ queryKey: ["history"] }))
      .catch(() => {
        if (recordedHistoryRoomRef.current === roomKey) {
          recordedHistoryRoomRef.current = null;
        }
      });
  }, [detailQuery.data, qc]);

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
    refreshDetail: refreshPlaybackDetail,
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

  async function toggleFollow(groupId = UNGROUPED_FOLLOW_GROUP_ID): Promise<boolean> {
    const detail = detailQuery.data;
    if (!detail || !siteId || !roomId) return false;
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
          tag_ids: tagIdsForFollowGroup(groupId),
          live_status: detail.status,
          live_started_at: detail.status ? (detail.live_started_at ?? null) : null,
          updated_at: Date.now(),
        };
        await invokeCmd("follow_add", { user });
      }
      await qc.invalidateQueries({ queryKey: FOLLOW_LIST_QUERY_KEY });
      notify.success(isFollowed ? "已取消关注" : "已关注主播");
      return true;
    } catch {
      notify.error(isFollowed ? "取消关注失败" : "关注失败", "请检查网络后重试。");
      return false;
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

  function requestFollowToggle() {
    if (isFollowed) {
      setConfirmUnfollowOpen(true);
    } else {
      setFollowGroupOpen(true);
    }
  }

  function openInMultiRoom() {
    if (!detailQuery.data) return;
    const detail = detailQuery.data;
    const result = useMultiRoomStore.getState().addRoom({
      site_id: detail.site_id,
      room_id: detail.room_id,
      title: detail.title,
      user_name: detail.user_name,
      cover: detail.cover,
    });
    if (result === "added") notify.success("已加入多画面");
    else if (result === "exists") notify.info("该直播间已在多画面中");
    else {
      const { layout } = useMultiRoomStore.getState();
      notify.error("多画面已满", `当前布局最多同时添加 ${layout} 个直播间。`);
    }
    navigate("/multi-room");
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
        <RoomTopBar title="加载中…" backTarget={backTarget} />
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="size-8 text-primary" />
        </div>
      </div>
    );
  }

  if (detailQuery.isError) {
    return (
      <div className="flex h-full flex-col">
        <RoomTopBar title="加载失败" backTarget={backTarget} />
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

  // The fullscreen stage covers the app chrome, so the room-level actions that
  // normally live in the top bar and the bottom action row are republished into
  // the player's own overflow menu. Follow and multi-room answer through a
  // dialog or a route change, which only exist outside fullscreen.
  const fullscreenRoomActions: readonly PlayerHudRoomAction[] = [
    {
      id: "copy-room-url",
      label: "复制链接",
      icon: Link2,
      onSelect: () => void copyRoomValue(detail.url || window.location.href, "已复制房间链接"),
    },
    {
      id: "copy-play-url",
      label: "复制直链",
      icon: Share2,
      disabled: !playback.playUrl?.url,
      onSelect: () => {
        if (playback.playUrl?.url) void copyRoomValue(playback.playUrl.url, "已复制播放直链");
      },
    },
    {
      id: "follow",
      label: isFollowed ? "取消关注" : "关注",
      icon: Heart,
      pressed: isFollowed,
      disabled: followBusy,
      exitsFullscreen: true,
      onSelect: requestFollowToggle,
    },
    ...(supportsMultiRoom()
      ? [
          {
            id: "multi-room",
            label: "多画面",
            icon: PanelsTopLeft,
            exitsFullscreen: true,
            onSelect: openInMultiRoom,
          },
        ]
      : []),
  ];

  const sideHeader = (
    <RoomHostInfo
      detail={detail}
      isFollowed={isFollowed}
      followBusy={followBusy}
      onToggleFollow={requestFollowToggle}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <RoomTopBar
        title={detail.title || "直播间"}
        backTarget={backTarget}
        rightSlot={
          <div className="flex items-center gap-1">
            <div className="hidden md:block">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="加入并打开多画面"
                      onClick={openInMultiRoom}
                    />
                  }
                >
                  <PanelsTopLeft data-icon="inline-start" aria-hidden />
                </TooltipTrigger>
                <TooltipContent side="bottom">加入并打开多画面</TooltipContent>
              </Tooltip>
            </div>
            <div className="md:hidden">
              <RoomMobileActions
                roomUrl={detail.url || window.location.href}
                playbackUrl={playback.playUrl?.url}
                playerActions={playerMobileActions}
                onCopy={copyRoomValue}
              />
            </div>
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
          roomTitle={detail.title}
          roomUserName={detail.user_name}
          roomUserAvatar={detail.user_avatar}
          roomOnline={detail.online}
          fullscreenRoomActions={fullscreenRoomActions}
          onMobileRoomActionsChange={setPlayerMobileActions}
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

      <AlertDialog
        open={confirmUnfollowOpen}
        onOpenChange={(open) => {
          if (followBusy) return;
          setConfirmUnfollowOpen(open);
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10 text-destructive">
              <UserRoundX aria-hidden />
            </AlertDialogMedia>
            <AlertDialogTitle>取消关注</AlertDialogTitle>
            <AlertDialogDescription>
              确定不再关注 {detail.user_name} 吗？取消后将不再显示在关注列表中。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={followBusy}>取消</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              variant="destructive"
              disabled={followBusy}
              onClick={() => {
                setConfirmUnfollowOpen(false);
                void toggleFollow();
              }}
            >
              {followBusy ? (
                <>
                  <Spinner data-icon="inline-start" aria-hidden />
                  正在取消…
                </>
              ) : (
                <>
                  <UserRoundX data-icon="inline-start" aria-hidden />
                  取消关注
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <FollowGroupPickerDialog
        open={followGroupOpen}
        subjectName={detail.user_name}
        pending={followBusy}
        onOpenChange={setFollowGroupOpen}
        onConfirm={async (groupId) => {
          if (await toggleFollow(groupId)) setFollowGroupOpen(false);
        }}
      />
    </div>
  );
}

function RoomTopBar({
  title,
  backTarget,
  rightSlot,
}: {
  title: string;
  backTarget?: "home" | "follow" | null;
  rightSlot?: ReactNode;
}) {
  const navigate = useNavigate();

  function goBack() {
    if (backTarget === "home" || backTarget === "follow") {
      navigate(backTarget === "follow" ? "/follow" : "/", { replace: true });
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
              variant="ghost"
              size="icon-sm"
              className="motion-back-button absolute left-3 z-10 rounded-lg hover:bg-muted/70 max-md:size-11 max-md:touch-manipulation"
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
  playerActions,
  onCopy,
}: {
  roomUrl: string;
  playbackUrl?: string;
  playerActions: readonly PlayerMobileRoomAction[];
  onCopy: (value: string, successMessage: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);

  function copy(value: string, successMessage: string) {
    setOpen(false);
    void onCopy(value, successMessage);
  }

  function runPlayerAction(action: PlayerMobileRoomAction) {
    setOpen(false);
    action.onSelect();
  }

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger
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
      <DrawerContent side="bottom" glass className={`space-y-4 ${glassSurfaceClass()}`}>
        <DrawerTitle>房间操作</DrawerTitle>
        {/* Top row: link/copy actions. Bottom row: player feature toggles.
           Both are icon-over-label tiles so touch targets stay large. */}
        <div className="grid grid-cols-4 gap-2">
          <Button
            type="button"
            variant="ghost"
            className="h-auto flex-col gap-1.5 py-3 text-xs font-normal touch-manipulation"
            onClick={() => copy(roomUrl, "已复制房间链接")}
          >
            <Link2 className="size-5" aria-hidden />
            复制链接
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="h-auto flex-col gap-1.5 py-3 text-xs font-normal touch-manipulation"
            disabled={!playbackUrl}
            onClick={() => {
              if (playbackUrl) copy(playbackUrl, "已复制播放直链");
            }}
          >
            <Share2 className="size-5" aria-hidden />
            复制直链
          </Button>
        </div>
        {playerActions.length > 0 && (
          <>
            <Separator />
            <div className="grid grid-cols-4 gap-2">
              {playerActions.map((action) => {
                const Icon = action.icon;
                return (
                  <Button
                    key={action.id}
                    type="button"
                    variant={action.pressed ? "secondary" : "ghost"}
                    className="h-auto flex-col gap-1.5 py-3 text-xs font-normal touch-manipulation"
                    disabled={action.disabled}
                    aria-pressed={action.pressed}
                    onClick={() => runPlayerAction(action)}
                  >
                    <Icon className="size-5" aria-hidden />
                    {action.label}
                  </Button>
                );
              })}
            </div>
          </>
        )}
      </DrawerContent>
    </Drawer>
  );
}
