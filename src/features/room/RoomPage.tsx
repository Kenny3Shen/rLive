import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Car,
  Cast,
  ChevronLeft,
  Heart,
  Link2,
  PanelsTopLeft,
  Share2,
  Timer,
  type LucideIcon,
  UserRoundX,
} from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import { canNavigateBackInApp } from "@/shared/appHistory";
import { copyText } from "@/shared/clipboard";
import { isMobileClient, supportsMultiRoom } from "@/shared/clientPlatform";
import { ErrorState } from "@/shared/components/ErrorState";
import { glassPanelClass, glassTitleClass } from "@/shared/components/player/glassSurface";
import { ToolActiveDot } from "@/shared/components/player/ToolActiveDot";
import type { FollowUser, HistoryItem, LiveRoomDetail, SiteId } from "@/shared/types/live";
import { PlayerPane } from "./PlayerPane";
import type { RoomSideTab } from "./PlayerPane";
import type { RecordingContext } from "@/features/recording/recording";
import { fetchRecordingPlayUrl } from "@/features/recording/recordingSource";
import { RecordingControl } from "@/features/recording/RecordingControl";
import { RecordingLeaveGuard } from "@/features/recording/RecordingLeaveGuard";
import type { PlayerHudRoomAction } from "./PlayerFullscreenHud";
import { useAutoDanmakuSend } from "./danmaku/useAutoDanmakuSend";
import { AutoDanmakuSendMenu, SleepTimerMenu } from "./RoomToolMenus";
import { useSleepTimer } from "./useSleepTimer";
import { RoomHostInfo } from "./RoomHostInfo";
import {
  roomBackTargetFromNavigationState,
  roomSideTabFromNavigationState,
} from "./roomNavigation";
import { usePlaybackController } from "./playback/usePlaybackController";
import { CastMenu } from "./CastMenu";
import { useDanmakuConnection } from "./danmaku/useDanmakuConnection";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { notify } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DrawerScope } from "@/components/ui/drawer";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FOLLOW_LIST_QUERY_KEY } from "../follow/followRefresh";
import { FollowGroupPickerDialog } from "../follow/FollowGroupPickerDialog";
import { tagIdsForFollowGroup, UNGROUPED_FOLLOW_GROUP_ID } from "../follow/followGroups";
import { useMultiRoomStore } from "../multi-room/multiRoomStore";
import { cn } from "@/lib/utils";

export function RoomPage() {
  return (
    <DrawerScope>
      <RoomPageContent />
    </DrawerScope>
  );
}

function RoomPageContent() {
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
  const mobileClient = isMobileClient();

  const [followBusy, setFollowBusy] = useState(false);
  const [castingDevice, setCastingDevice] = useState<string | null>(null);
  const [followGroupOpen, setFollowGroupOpen] = useState(false);
  const [confirmUnfollowOpen, setConfirmUnfollowOpen] = useState(false);
  const requestedSideTab = roomSideTabFromNavigationState(location.state);
  const backTarget = roomBackTargetFromNavigationState(location.state);
  const [sideTab, setSideTab] = useState<RoomSideTab>(requestedSideTab);
  // 网页全屏（桌面）：画面占满应用窗口，不进入原生全屏。状态留在本页而不是 PlayerPane，
  // 因为要让位的上下两条栏属于本页；右侧栏那部分由 PlayerPane 自己根据此值隐藏。
  const [webFullscreen, setWebFullscreen] = useState(false);

  // 普通房间导航从聊天开始，而由 FollowPanel 发起的导航保持关注选择器打开。
  // 这也覆盖了参数变化时复用 RoomPage 而不重新挂载的路由配置。
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
    // 详情查询可能在重连或缓存失效后刷新。回访应当更新一次历史，
    // 而不是在同一房间保持打开期间、每次负载替换都写 SQLite。
    if (recordedHistoryRoomRef.current === roomKey) return;
    recordedHistoryRoomRef.current = roomKey;
    const item: HistoryItem = {
      site_id: detail.site_id,
      room_id: detail.room_id,
      title: detail.title,
      user_name: detail.user_name,
      cover: detail.cover,
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

  const detail = detailQuery.data;
  const roomSessionKey = siteId && roomId ? `${siteId}:${roomId}` : undefined;
  const activeQuality = playback.qualities[playback.qualityIndex];
  const recordingContext = useMemo<RecordingContext | null>(
    () =>
      playback.playUrl
        ? {
            source: playback.playUrl,
            sourceKey: `live:${siteId}:${(roomId ?? "").trim()}`,
            sourceKind: "live",
            siteId: detail?.site_id ?? siteId,
            roomId: detail?.room_id ?? roomId,
            title: detail?.title ?? "直播间",
            userName: detail?.user_name ?? "",
            cover: detail?.cover || detail?.user_avatar || "",
            userAvatar: detail?.user_avatar || "",
            // `playback.playUrl` 是本页播放器正在推流的地址，
            // 录制因此向站点另行申请一条自己的线路。
            resolveRecordingSource:
              siteId && detail && activeQuality
                ? () =>
                    fetchRecordingPlayUrl(
                      siteId,
                      detail,
                      activeQuality,
                      playback.playUrl?.source_id,
                    )
                : undefined,
          }
        : null,
    [activeQuality, detail, playback.playUrl, roomId, siteId],
  );
  // 这些控制属于房间会话而不是设置页签，
  // 因此标题栏与全屏表面使用同一个实时控制器。
  const autoDanmakuSend = useAutoDanmakuSend({
    siteId,
    roomId: detail?.room_id,
    roomTitle: detail?.title,
    roomUserName: detail?.user_name,
    roomSessionKey,
  });
  const sleepTimer = useSleepTimer(roomSessionKey);

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
          auto_record: false,
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

  /**
   * 离开房间。`backTarget` 由发起导航的入口写进 location state：从首页/关注页
   * 进来时直接 replace 回那条路由，避免在列表页之间累积返回栈。
   *
   * 移动端没有流内顶栏，这个回调由画面内 HUD 的返回箭头（退尽全屏层之后）调用。
   */
  const goBack = useCallback(() => {
    if (backTarget === "home" || backTarget === "follow") {
      navigate(backTarget === "follow" ? "/follow" : "/", { replace: true });
      return;
    }
    if (canNavigateBackInApp(window.history.state)) {
      navigate(-1);
      return;
    }
    navigate("/", { replace: true });
  }, [backTarget, navigate]);

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

  if (detailQuery.isLoading) {
    return (
      <div className="flex h-full flex-col">
        <RoomTopBar title="加载中…" onBack={goBack} />
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="size-8 text-primary" />
        </div>
      </div>
    );
  }

  if (detailQuery.isError) {
    return (
      <div className="flex h-full flex-col">
        <RoomTopBar title="加载失败" onBack={goBack} />
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

  // 全屏舞台盖住了应用 chrome，因此通常位于顶栏和底部操作行的房间级操作被重新
  // 发布到播放器自己的溢出菜单。关注与多房间要经对话框或路由变更应答，
  // 而这些只存在于非全屏状态。
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
      {/* 移动端不渲染流内顶栏：房间身份与工具由 PlayerPane 的画面内 HUD
          承担（`stageOwnsRoomTopBar`），顶部状态栏空间仍由 Shell 预留。 */}
      {!webFullscreen && !mobileClient && (
        <RoomTopBar
          title={detail.title || "直播间"}
          onBack={goBack}
          rightSlot={
            <div className="flex items-center gap-1">
              <RecordingControl context={recordingContext} />
              {/* 顶栏本身已限定桌面，工具行不再按视口宽度隐藏：窄窗口下移动端抽屉
                  已经不存在，再藏起来就没有入口了。 */}
              <div className="flex items-center gap-1">
                <RoomToolPopover icon={Timer} label="定时关闭" active={sleepTimer.active}>
                  <SleepTimerMenu timer={sleepTimer} showTrigger={false} showHeader={false} />
                </RoomToolPopover>
                <RoomToolPopover icon={Cast} label="投屏" active={castingDevice != null}>
                  <CastMenu
                    castUrl={playback.playUrl?.url ?? null}
                    headers={playback.playUrl?.headers ?? {}}
                    title={detail.title || "rLive 直播"}
                    showHeader={false}
                    onCastingDeviceChange={setCastingDevice}
                  />
                </RoomToolPopover>
                <RoomToolPopover
                  icon={Car}
                  label="自动发送弹幕"
                  wide
                  active={autoDanmakuSend.enabled}
                >
                  <AutoDanmakuSendMenu
                    autoSend={autoDanmakuSend}
                    idPrefix="title-auto-danmaku"
                    showHeader={false}
                  />
                </RoomToolPopover>
              </div>
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
          }
        />
      )}

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
          autoDanmakuSend={autoDanmakuSend}
          sleepTimer={sleepTimer}
          fullscreenRoomActions={fullscreenRoomActions}
          webFullscreen={webFullscreen}
          onWebFullscreenChange={setWebFullscreen}
          // 顶栏隐藏后录制入口会跟着消失，因此把同一个控件补进画面内的 HUD。
          hudToolsSlot={<RecordingControl context={recordingContext} />}
          onNavigateBack={goBack}
        />
      </div>

      {!webFullscreen && (
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
      )}

      <ConfirmDialog
        open={confirmUnfollowOpen}
        onOpenChange={(open) => {
          if (followBusy) return;
          setConfirmUnfollowOpen(open);
        }}
        icon={<UserRoundX aria-hidden />}
        title="取消关注"
        description={<>确定不再关注 {detail.user_name} 吗？取消后将不再显示在关注列表中。</>}
        busy={followBusy}
        busyText="正在取消…"
        actionIcon={<UserRoundX data-icon="inline-start" aria-hidden />}
        confirmText="取消关注"
        onConfirm={() => {
          setConfirmUnfollowOpen(false);
          void toggleFollow();
        }}
      />

      <FollowGroupPickerDialog
        open={followGroupOpen}
        subjectName={detail.user_name}
        pending={followBusy}
        onOpenChange={setFollowGroupOpen}
        onConfirm={async (groupId) => {
          if (await toggleFollow(groupId)) setFollowGroupOpen(false);
        }}
      />
      <RecordingLeaveGuard context={recordingContext} />
    </div>
  );
}

function RoomTopBar({
  title,
  onBack,
  rightSlot,
}: {
  title: string;
  onBack: () => void;
  rightSlot?: ReactNode;
}) {
  return (
    <header className="relative flex min-h-11 shrink-0 items-center justify-center border-b border-border/80 bg-sidebar/90 px-3">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="motion-back-button absolute left-3 z-10 rounded-lg hover:bg-muted/70 max-md:size-11 max-md:touch-manipulation"
              aria-label="返回上一页"
              onClick={onBack}
            >
              <ChevronLeft data-icon="inline-start" aria-hidden />
            </Button>
          }
        />
        <TooltipContent side="bottom">返回上一页</TooltipContent>
      </Tooltip>
      <p
        className="absolute inset-x-24 truncate text-center text-sm font-medium tracking-tight md:inset-x-40"
        title={title}
      >
        {title}
      </p>
      {rightSlot && <div className="absolute right-3 z-10">{rightSlot}</div>}
    </header>
  );
}

function RoomToolPopover({
  icon: Icon,
  label,
  wide = false,
  active = false,
  children,
}: {
  icon: LucideIcon;
  label: string;
  wide?: boolean;
  /** 工具当前是否开启；渲染开启状态的图标。 */
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant={active ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label={label}
            title={label}
            aria-pressed={active}
          />
        }
      >
        <span className="relative inline-flex">
          <Icon data-icon="inline-start" aria-hidden className={cn(active && "text-primary")} />
          {active && <ToolActiveDot />}
        </span>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        collisionPadding={12}
        glass
        className={cn(
          "max-h-[calc(100vh-4rem)] overflow-y-auto p-3",
          glassPanelClass(),
          wide
            ? "w-[min(30rem,calc(100vw-1.5rem))] max-w-[calc(100vw-1.5rem)]"
            : "w-[min(20rem,calc(100vw-1.5rem))] max-w-[calc(100vw-1.5rem)]",
        )}
      >
        <PopoverTitle className={cn("mb-2 px-0.5", glassTitleClass())}>{label}</PopoverTitle>
        {children}
      </PopoverContent>
    </Popover>
  );
}
