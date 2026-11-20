import { memo, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CircleDot,
  Clock3,
  Folder,
  FolderInput,
  Heart,
  Inbox,
  Radio,
  RadioTower,
  RefreshCw,
  UserRoundX,
} from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import type { FollowUser } from "@/shared/types/live";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { notify } from "@/components/ui/toast";
import { cn, normalizeImageUrl, SITE_LABELS } from "@/lib/utils";
import { isMobileClient } from "@/shared/clientPlatform";
import { PullToRefresh } from "@/shared/components/PullToRefresh";
import { useLongPressDrawer } from "@/shared/hooks/useLongPressDrawer";
import { isSiteEnabled } from "@/shared/siteId";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import {
  FOLLOW_AUTO_RECORD_QUERY_KEY,
  useFollowRecordingController,
} from "../recording/followRecording";
import {
  FollowCardActionDrawer,
  type FollowCardDrawerAction,
  type FollowCardDrawerGroup,
} from "../follow/FollowCardActionDrawer";
import {
  FOLLOW_GROUPS_QUERY_KEY,
  UNGROUPED_FOLLOW_GROUP_ID,
  followGroupId,
  followIdentity,
  sortFollowGroups,
  tagIdsForFollowGroup,
  type FollowGroup,
} from "../follow/followGroups";
import { FOLLOW_ROOM_SWITCH_STATE } from "./roomNavigation";
import {
  FOLLOW_LIST_QUERY_KEY,
  reconcileFollowList,
  refreshFollows,
  useFollowStatusRefresh,
} from "../follow/followRefresh";
import { formatFollowLiveDuration } from "../follow/followRoute";

const EMPTY_GROUPS: FollowGroup[] = [];

function sortFollows(follows: FollowUser[]): FollowUser[] {
  return [...follows].sort((a, b) => {
    const rank = (item: FollowUser) =>
      item.live_status === true ? 0 : item.live_status === false ? 1 : 2;
    const statusDifference = rank(a) - rank(b);
    if (statusDifference !== 0) return statusDifference;
    return a.user_name.localeCompare(b.user_name, "zh");
  });
}

function statusBadge(user: FollowUser) {
  if (user.live_status === true) {
    return <Badge>直播中</Badge>;
  }
  if (user.live_status === false) {
    return <Badge variant="secondary">未开播</Badge>;
  }
  return <Badge variant="outline">状态未知</Badge>;
}

type FollowPanelItemProps = {
  user: FollowUser;
  groups: readonly FollowGroup[];
  now: number;
  mobile: boolean;
  currentRoom: boolean;
  moving: boolean;
  removing: boolean;
  removeDisabled: boolean;
  recordingSupported: boolean;
  recordingActive: boolean;
  recordingBusy: boolean;
  recordingStarting: boolean;
  autoRecordingBusy: boolean;
  autoRecordingDisabled: boolean;
  onOpen: () => void;
  onMove: (user: FollowUser, groupId: string) => void;
  onRemove: (user: FollowUser) => void;
  onStartRecording: (user: FollowUser) => void;
  onAutoRecordingChange: (user: FollowUser, enabled: boolean) => void;
};

function FollowPanelItem({
  user,
  groups,
  now,
  mobile,
  currentRoom,
  moving,
  removing,
  removeDisabled,
  recordingSupported,
  recordingActive,
  recordingBusy,
  recordingStarting,
  autoRecordingBusy,
  autoRecordingDisabled,
  onOpen,
  onMove,
  onRemove,
  onStartRecording,
  onAutoRecordingChange,
}: FollowPanelItemProps) {
  const drawer = useLongPressDrawer({ enabled: mobile });
  const avatar = normalizeImageUrl(user.face);
  const platformName = SITE_LABELS[user.site_id] ?? user.site_id;
  const liveDuration =
    user.live_status === true ? formatFollowLiveDuration(user.live_started_at, now) : null;
  const currentGroupId = followGroupId(user, groups);

  function openRoom() {
    // 长按后的抬手点按属于抽屉手势，不应同时切换房间。
    if (drawer.consumeSyntheticClick()) return;
    onOpen();
  }

  const row = (
    <>
      <Avatar>
        <AvatarImage src={avatar} alt="" referrerPolicy="no-referrer" />
        <AvatarFallback>{(user.user_name || "?").slice(0, 1)}</AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium">{user.user_name}</span>
          {user.live_status === true && <Radio data-icon="inline-end" aria-hidden />}
        </span>
        <span
          className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted-foreground"
          title={liveDuration ? `${platformName}，开播时长：${liveDuration}` : platformName}
        >
          <span className="shrink-0">{platformName}</span>
          {liveDuration && (
            <>
              <Clock3 data-icon="inline-start" aria-hidden />
              <span className="truncate">{liveDuration}</span>
            </>
          )}
        </span>
      </span>
      {statusBadge(user)}
    </>
  );
  const rowClassName = cn(
    "h-auto w-full justify-start gap-2 border border-transparent px-2 py-2 text-left",
    currentRoom
      ? "cursor-default border-primary/25 bg-primary/15 text-primary shadow-sm shadow-primary/10 hover:bg-primary/15"
      : "hover:bg-muted/70",
  );

  const recordingActions: FollowCardDrawerAction[] = recordingSupported
    ? [
        {
          id: "start-recording",
          icon: CircleDot,
          label: recordingActive ? "正在录制" : recordingStarting ? "正在开启录制…" : "开启录制",
          disabled: user.live_status !== true || recordingBusy || recordingActive,
          onSelect: () => onStartRecording(user),
        },
        {
          id: "auto-record",
          icon: CircleDot,
          label: "自动录制",
          selected: user.auto_record,
          disabled: autoRecordingDisabled,
          busy: autoRecordingBusy,
          onSelect: () => onAutoRecordingChange(user, !user.auto_record),
        },
      ]
    : [];
  const drawerGroups: FollowCardDrawerGroup[] = [
    ...groups.map((group) => ({
      id: group.id,
      name: group.name,
      icon: Folder,
      current: currentGroupId === group.id,
    })),
    {
      id: UNGROUPED_FOLLOW_GROUP_ID,
      name: "未分组",
      icon: Inbox,
      current: currentGroupId === UNGROUPED_FOLLOW_GROUP_ID,
    },
  ];

  if (mobile) {
    return (
      <>
        <Button
          type="button"
          variant={currentRoom ? "secondary" : "ghost"}
          className={rowClassName}
          aria-current={currentRoom ? "page" : undefined}
          onClick={openRoom}
          onPointerDown={drawer.onPointerDown}
          onPointerMove={drawer.onPointerMove}
          onPointerUp={drawer.onPointerUp}
          onPointerCancel={drawer.onPointerCancel}
          onContextMenu={drawer.onContextMenu}
        >
          {row}
        </Button>
        <FollowCardActionDrawer
          open={drawer.open}
          onOpenChange={drawer.setOpen}
          title={user.user_name || "未知主播"}
          actions={recordingActions}
          groups={drawerGroups}
          moving={moving}
          onMoveGroup={(groupId) => onMove(user, groupId)}
          destructive={{
            id: "remove",
            icon: UserRoundX,
            label: "取消关注",
            disabled: removeDisabled,
            busy: removing,
            destructive: true,
            onSelect: () => onRemove(user),
          }}
        />
      </>
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <Button
            type="button"
            variant={currentRoom ? "secondary" : "ghost"}
            className={rowClassName}
            aria-current={currentRoom ? "page" : undefined}
            onClick={openRoom}
          />
        }
      >
        {row}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuGroup>
          {recordingSupported && (
            <>
              <ContextMenuItem
                disabled={user.live_status !== true || recordingBusy || recordingActive}
                onClick={() => onStartRecording(user)}
              >
                {recordingStarting ? <Spinner aria-hidden /> : <CircleDot aria-hidden />}
                {recordingActive ? "正在录制" : recordingStarting ? "正在开启录制…" : "开启录制"}
              </ContextMenuItem>
              <ContextMenuCheckboxItem
                checked={user.auto_record}
                disabled={autoRecordingDisabled}
                closeOnClick
                onCheckedChange={(checked) => onAutoRecordingChange(user, checked)}
              >
                {autoRecordingBusy ? <Spinner aria-hidden /> : <CircleDot aria-hidden />}
                自动录制
              </ContextMenuCheckboxItem>
            </>
          )}
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <FolderInput aria-hidden />
              移至分组
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuGroup>
                {groups.map((group) => (
                  <ContextMenuItem
                    key={group.id}
                    disabled={moving || currentGroupId === group.id}
                    onClick={() => onMove(user, group.id)}
                  >
                    <Folder aria-hidden />
                    {group.name}
                    {currentGroupId === group.id && <Check aria-hidden />}
                  </ContextMenuItem>
                ))}
                <ContextMenuItem
                  disabled={moving || currentGroupId === UNGROUPED_FOLLOW_GROUP_ID}
                  onClick={() => onMove(user, UNGROUPED_FOLLOW_GROUP_ID)}
                >
                  <Inbox aria-hidden />
                  未分组
                  {currentGroupId === UNGROUPED_FOLLOW_GROUP_ID && <Check aria-hidden />}
                </ContextMenuItem>
              </ContextMenuGroup>
            </ContextMenuSubContent>
          </ContextMenuSub>
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuGroup>
          <ContextMenuItem
            variant="destructive"
            disabled={removeDisabled}
            onClick={() => onRemove(user)}
          >
            {removing ? <Spinner aria-hidden /> : <UserRoundX aria-hidden />}
            取消关注
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * 房间侧栏的紧凑关注列表。
 *
 * 它与关注页共享状态刷新节奏和缓存条目，房间保持打开时直播角标持续更新。
 * `refreshFollows` 会对远程调用去重，
 * 两个视图同时挂载也不会让工作量翻倍。
 */
export const FollowPanel = memo(function FollowPanel({ className }: { className?: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  useFollowStatusRefresh();
  const { siteId: routeSiteId, roomId: routeRoomId } = useParams<{
    siteId: string;
    roomId: string;
  }>();
  const currentRoomId = routeRoomId ? decodeURIComponent(routeRoomId) : undefined;
  const disabledSiteIds = useSettingsStore((state) => state.disabledSiteIds);
  const mobile = isMobileClient();
  const showRefreshButton = !mobile;

  const followsQuery = useQuery({
    queryKey: FOLLOW_LIST_QUERY_KEY,
    queryFn: () => invokeCmd<FollowUser[]>("follow_list"),
    // RoomPage 已经为关注按钮订阅了这个查询。从本面板切换房间时复用其短时效缓存。
    staleTime: 15_000,
  });
  const groupsQuery = useQuery({
    queryKey: FOLLOW_GROUPS_QUERY_KEY,
    queryFn: () => invokeCmd<FollowGroup[]>("tag_list"),
    staleTime: 30_000,
    select: sortFollowGroups,
  });
  const groups = groupsQuery.data ?? EMPTY_GROUPS;
  const recording = useFollowRecordingController();

  const refreshMutation = useMutation({
    mutationFn: () => refreshFollows(queryClient),
    onSuccess: (outcome) => {
      // 部分失败不是整体失败：列表仍然可用，只把未确认的条数与重试入口说出来。
      if (outcome.failures.length > 0) {
        notify.error(
          `${outcome.failures.length} 个关注未能确认状态`,
          "它们保留上一次的结论，可再次刷新重试。",
        );
      }
    },
    onError: () => {
      notify.error("刷新关注列表失败", "请检查网络后重试。");
    },
  });

  const follows = useMemo(
    () =>
      sortFollows(
        (followsQuery.data ?? []).filter((follow) =>
          isSiteEnabled(follow.site_id, disabledSiteIds),
        ),
      ),
    [disabledSiteIds, followsQuery.data],
  );
  const [pendingRemove, setPendingRemove] = useState<FollowUser | null>(null);
  const hasLiveDuration = follows.some(
    (follow) => follow.live_status === true && follow.live_started_at != null,
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!hasLiveDuration) return;

    let interval: number | undefined;
    const updateClock = () => setNow(Date.now());
    updateClock();
    const untilNextMinute = 60_000 - (Date.now() % 60_000) + 50;
    const timeout = window.setTimeout(() => {
      updateClock();
      interval = window.setInterval(updateClock, 60_000);
    }, untilNextMinute);

    return () => {
      window.clearTimeout(timeout);
      if (interval != null) window.clearInterval(interval);
    };
  }, [hasLiveDuration]);

  const removeMutation = useMutation({
    mutationFn: (user: FollowUser) =>
      invokeCmd("follow_remove", {
        siteId: user.site_id,
        roomId: user.room_id,
      }),
    onSuccess: (_, user) => {
      reconcileFollowList(queryClient, "unfollowed", user);
      setPendingRemove(null);
      notify.success("已取消关注");
    },
    onError: () => notify.error("取消关注失败", "请检查网络后重试。"),
  });
  const moveMutation = useMutation({
    mutationFn: ({ user, groupId }: { user: FollowUser; groupId: string }) =>
      invokeCmd("follow_set_tags", {
        siteId: user.site_id,
        roomId: user.room_id,
        tagIds: tagIdsForFollowGroup(groupId),
      }),
    onMutate: async ({ user, groupId }) => {
      await queryClient.cancelQueries({ queryKey: FOLLOW_LIST_QUERY_KEY });
      const previous = queryClient.getQueryData<FollowUser[]>(FOLLOW_LIST_QUERY_KEY);
      queryClient.setQueryData<FollowUser[]>(FOLLOW_LIST_QUERY_KEY, (current = []) =>
        current.map((item) =>
          followIdentity(item) === followIdentity(user)
            ? { ...item, tag_ids: tagIdsForFollowGroup(groupId) }
            : item,
        ),
      );
      return { previous };
    },
    onSuccess: (_, { groupId }) => {
      const groupName =
        groupId === UNGROUPED_FOLLOW_GROUP_ID
          ? "未分组"
          : (groups.find((group) => group.id === groupId)?.name ?? "目标分组");
      notify.success(`已移至${groupName}`);
    },
    onError: (_, __, context) => {
      if (context?.previous) {
        queryClient.setQueryData(FOLLOW_LIST_QUERY_KEY, context.previous);
      }
      notify.error("移动分组失败", "请稍后重试。");
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: FOLLOW_LIST_QUERY_KEY }),
  });
  const autoRecordMutation = useMutation({
    mutationFn: ({ user, enabled }: { user: FollowUser; enabled: boolean }) =>
      invokeCmd("follow_set_auto_record", {
        siteId: user.site_id,
        roomId: user.room_id,
        autoRecord: enabled,
      }),
    onMutate: async ({ user, enabled }) => {
      await queryClient.cancelQueries({ queryKey: FOLLOW_LIST_QUERY_KEY });
      const previous = queryClient.getQueryData<FollowUser[]>(FOLLOW_LIST_QUERY_KEY);
      queryClient.setQueryData<FollowUser[]>(FOLLOW_LIST_QUERY_KEY, (current = []) =>
        current.map((item) =>
          followIdentity(item) === followIdentity(user) ? { ...item, auto_record: enabled } : item,
        ),
      );
      return { previous };
    },
    onSuccess: (_, { user, enabled }) => {
      notify.success(
        enabled ? "已开启自动录制" : "已关闭自动录制",
        enabled ? `${user.user_name}开播后将自动开始录制。` : user.user_name,
      );
    },
    onError: (_, __, context) => {
      if (context?.previous) {
        queryClient.setQueryData(FOLLOW_LIST_QUERY_KEY, context.previous);
      }
      notify.error("自动录制设置失败", "请稍后重试。");
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: FOLLOW_LIST_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: FOLLOW_AUTO_RECORD_QUERY_KEY });
    },
  });

  function switchRoom(user: FollowUser) {
    const isCurrentRoom = user.site_id === routeSiteId && user.room_id === currentRoomId;
    if (isCurrentRoom) return;
    const roomPath = `/room/${user.site_id}/${encodeURIComponent(user.room_id)}`;
    // 替换而不是压栈，避免房间堆满历史。显式目标让 Back 回到关注网格，
    // 而不是在之前的房间之间来回弹跳。
    navigate(roomPath, {
      replace: true,
      state: FOLLOW_ROOM_SWITCH_STATE,
    });
  }

  function moveFollow(user: FollowUser, groupId: string) {
    if (followGroupId(user, groups) === groupId || moveMutation.isPending) return;
    moveMutation.mutate({ user, groupId });
  }

  return (
    <section
      className={cn("relative flex min-h-0 flex-1 flex-col", className)}
      aria-label="关注直播间"
    >
      <ScrollArea className="min-h-0 flex-1">
        <PullToRefresh
          onRefresh={() => refreshMutation.mutateAsync().catch(() => undefined)}
          refreshing={refreshMutation.isPending || followsQuery.isFetching}
          className="h-full min-h-0 p-2 pb-14"
        >
          {followsQuery.isLoading && (
            // 关注列表的行数无法预测：给一个居中的加载指示，不画一组随后会被
            // 真实卡片整体替换的假条目。缓存刷新时列表仍在，不进入这个分支。
            <div className="flex min-h-14 items-center justify-center">
              <Spinner className="size-5 text-muted-foreground" aria-label="正在加载关注列表" />
            </div>
          )}

          {followsQuery.isError && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-5 text-center text-sm text-muted-foreground">
              <p>关注列表加载失败</p>
              <Button variant="outline" size="sm" onClick={() => void followsQuery.refetch()}>
                重试
              </Button>
            </div>
          )}

          {!followsQuery.isLoading && !followsQuery.isError && follows.length === 0 && (
            <Empty className="min-h-0 border-0 px-5">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Heart aria-hidden />
                </EmptyMedia>
                <EmptyTitle>还没有关注主播</EmptyTitle>
                <EmptyDescription>在直播间点击“关注”后会显示在这里。</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button variant="outline" size="sm" onClick={() => navigate("/")}>
                  <RadioTower data-icon="inline-start" aria-hidden />
                  去直播看看
                </Button>
              </EmptyContent>
            </Empty>
          )}

          {follows.length > 0 && (
            <ul className="flex flex-col gap-1">
              {follows.map((user) => {
                const isCurrentRoom =
                  user.site_id === routeSiteId && user.room_id === currentRoomId;
                const identity = followIdentity(user);
                const recordingStarting =
                  recording.pendingTarget != null &&
                  followIdentity(recording.pendingTarget) === identity;
                const autoRecordingBusy =
                  autoRecordMutation.isPending &&
                  followIdentity(autoRecordMutation.variables.user) === identity;
                return (
                  <li key={`${user.site_id}:${user.room_id}`}>
                    <FollowPanelItem
                      user={user}
                      groups={groups}
                      now={now}
                      mobile={mobile}
                      currentRoom={isCurrentRoom}
                      moving={
                        moveMutation.isPending &&
                        followIdentity(moveMutation.variables.user) === identity
                      }
                      removing={
                        removeMutation.isPending &&
                        followIdentity(removeMutation.variables) === identity
                      }
                      removeDisabled={removeMutation.isPending}
                      recordingSupported={recording.supported}
                      recordingActive={Boolean(recording.activeFor(user))}
                      recordingBusy={recording.busy}
                      recordingStarting={recordingStarting}
                      autoRecordingBusy={autoRecordingBusy}
                      autoRecordingDisabled={autoRecordMutation.isPending}
                      onOpen={() => switchRoom(user)}
                      onMove={moveFollow}
                      onRemove={setPendingRemove}
                      onStartRecording={recording.start}
                      onAutoRecordingChange={(target, enabled) => {
                        if (!autoRecordMutation.isPending) {
                          autoRecordMutation.mutate({ user: target, enabled });
                        }
                      }}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </PullToRefresh>
      </ScrollArea>

      {showRefreshButton && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-lg"
                className="absolute right-3 bottom-3 rounded-full"
                disabled={refreshMutation.isPending || followsQuery.isLoading}
                aria-label={refreshMutation.isPending ? "正在刷新关注状态" : "刷新关注状态"}
                onClick={() => refreshMutation.mutate()}
              />
            }
          >
            {refreshMutation.isPending ? (
              <Spinner data-icon="inline-start" aria-hidden />
            ) : (
              <RefreshCw data-icon="inline-start" aria-hidden />
            )}
          </TooltipTrigger>
          <TooltipContent side="left">
            {refreshMutation.isPending ? "正在刷新关注状态" : "刷新关注状态"}
          </TooltipContent>
        </Tooltip>
      )}

      <ConfirmDialog
        open={pendingRemove != null}
        onOpenChange={(open) => {
          if (removeMutation.isPending) return;
          if (!open) setPendingRemove(null);
        }}
        icon={<UserRoundX aria-hidden />}
        title="取消关注"
        description={
          <>确定不再关注 {pendingRemove?.user_name} 吗？取消后将不再显示在关注列表中。</>
        }
        disabled={removeMutation.isPending}
        busy={removeMutation.isPending}
        busyText="正在取消…"
        actionIcon={<UserRoundX data-icon="inline-start" aria-hidden />}
        confirmText="取消关注"
        onConfirm={() => {
          if (pendingRemove) removeMutation.mutate(pendingRemove);
        }}
      />
    </section>
  );
});
