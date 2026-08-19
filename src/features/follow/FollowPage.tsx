import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import {
  DndContext,
  DragOverlay,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
  type Announcements,
} from "@dnd-kit/core";
import {
  Activity,
  Check,
  CircleDot,
  CirclePlay,
  Clock3,
  Folder,
  FolderCog,
  FolderInput,
  Home,
  Inbox,
  Layers3,
  Star,
  Trash2,
  UserRoundX,
} from "lucide-react";
import { preloadRouteModule } from "@/app/routeModules";
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
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { notify } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn, normalizeImageUrl, SITE_LABELS } from "@/lib/utils";
import { invokeCmd } from "@/shared/api/tauri";
import { ErrorState } from "@/shared/components/ErrorState";
import { PlatformFilterSelect } from "@/shared/components/PlatformFilterSelect";
import { PullToRefresh } from "@/shared/components/PullToRefresh";
import { RefreshFab } from "@/shared/components/RefreshFab";
import { isMobileClient } from "@/shared/clientPlatform";
import { useHorizontalSwipe } from "@/shared/hooks/useHorizontalSwipe";
import { prefersReducedMotion } from "@/shared/motion/tokens";
import { enabledSiteIds, isSiteEnabled } from "@/shared/siteId";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import type { FollowUser } from "@/shared/types/live";
import {
  FOLLOW_AUTO_RECORD_QUERY_KEY,
  useFollowRecordingController,
} from "@/features/recording/followRecording";
import {
  iptvFavoritesForSource,
  useAllIptvFavorites,
  useIptvFavoriteGroups,
} from "@/features/iptv/favorites";
import {
  iptvFavoriteSourceId,
  playlistSourceFromRoute,
  playlistSourcesForSettings,
} from "@/features/iptv/playlistSource";
import { FollowGroupManagerDialog } from "./FollowGroupManagerDialog";
import { groupTargetCollisionDetection } from "./groupCollisionDetection";
import { IptvFollowView } from "./IptvFollowView";
import { useFollowDndSensors } from "./useFollowDndSensors";
import { useFollowHeaderState } from "./followHeaderState";
import {
  FOLLOW_IPTV_GROUP_PARAM,
  FOLLOW_IPTV_SOURCE_PARAM,
  iptvFollowGroupFromSearch,
  iptvFollowGroups,
  withIptvFollowGroup,
  withIptvFollowSource,
} from "./iptvFollowGroups";
import {
  ALL_FOLLOW_GROUP_ID,
  FOLLOW_GROUPS_QUERY_KEY,
  followBelongsToGroup,
  followGroupId,
  followIdentity,
  sortFollowGroups,
  sortFollowsByStatus,
  tagIdsForFollowGroup,
  UNGROUPED_FOLLOW_GROUP_ID,
  type FollowGroup,
} from "./followGroups";
import { FOLLOW_LIST_QUERY_KEY, refreshFollows, useFollowStatusRefresh } from "./followRefresh";
import {
  FOLLOW_PLATFORM_PARAM,
  FOLLOW_VIEW_PARAM,
  type FollowPlatformFilter,
  type FollowView,
  followPlatformFromSearch,
  followViewFromSearch,
  formatFollowLiveDuration,
  withFollowPlatform,
  withFollowView,
} from "./followRoute";

type LiveFilter = "all" | "live" | "offline";

const EMPTY_FOLLOWS: FollowUser[] = [];
const EMPTY_GROUPS: FollowGroup[] = [];
const FOLLOW_DND_INSTRUCTIONS = {
  draggable: "按空格键选中主播，使用方向键移动，按空格键放入分组，按 Escape 取消。",
};

type GroupTargetProps = {
  groupId: string;
  label: string;
  count: number;
  selected: boolean;
  dragActive: boolean;
  surface: "desktop" | "mobile";
  onSelect: () => void;
};

function GroupTarget({
  groupId,
  label,
  count,
  selected,
  dragActive,
  surface,
  onSelect,
}: GroupTargetProps) {
  const canDrop = groupId !== ALL_FOLLOW_GROUP_ID;
  const { isOver, setNodeRef } = useDroppable({
    id: `${surface}:${groupId}`,
    data: { groupId },
    disabled: !dragActive || !canDrop,
  });
  const Icon =
    groupId === ALL_FOLLOW_GROUP_ID
      ? Layers3
      : groupId === UNGROUPED_FOLLOW_GROUP_ID
        ? Inbox
        : Folder;

  return (
    <Button
      ref={setNodeRef}
      type="button"
      variant={selected ? "secondary" : "ghost"}
      size={surface === "desktop" ? "default" : "sm"}
      aria-current={selected ? "page" : undefined}
      className={cn(
        "justify-start",
        surface === "desktop" ? "w-full" : "shrink-0",
        dragActive && canDrop && "ring-1 ring-border",
        isOver && "bg-primary/15 text-primary ring-2 ring-primary",
      )}
      onClick={onSelect}
    >
      <Icon data-icon="inline-start" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{count}</span>
    </Button>
  );
}

type FollowCardProps = {
  user: FollowUser;
  groups: readonly FollowGroup[];
  now: number;
  moving: boolean;
  removing: boolean;
  removeDisabled: boolean;
  recordingSupported: boolean;
  recordingActive: boolean;
  recordingBusy: boolean;
  recordingStarting: boolean;
  autoRecordingBusy: boolean;
  autoRecordingDisabled: boolean;
  onNavigate: (path: string) => void;
  onMove: (user: FollowUser, groupId: string) => void;
  onRemove: (user: FollowUser) => void;
  onStartRecording: (user: FollowUser) => void;
  onAutoRecordingChange: (user: FollowUser, enabled: boolean) => void;
};

function FollowCard({
  user,
  groups,
  now,
  moving,
  removing,
  removeDisabled,
  recordingSupported,
  recordingActive,
  recordingBusy,
  recordingStarting,
  autoRecordingBusy,
  autoRecordingDisabled,
  onNavigate,
  onMove,
  onRemove,
  onStartRecording,
  onAutoRecordingChange,
}: FollowCardProps) {
  const identity = followIdentity(user);
  const currentGroupId = followGroupId(user, groups);
  const { attributes, isDragging, listeners, setActivatorNodeRef, setNodeRef } = useDraggable({
    id: identity,
    data: { follow: user },
    disabled: moving,
  });
  const live = user.live_status === true;
  const offline = user.live_status === false;
  const liveDuration = live ? formatFollowLiveDuration(user.live_started_at, now) : null;
  const avatarSrc = normalizeImageUrl(user.face);
  const roomPath = `/room/${user.site_id}/${encodeURIComponent(user.room_id)}`;

  return (
    <li ref={setNodeRef} className={cn("min-w-0", isDragging && "opacity-35")}>
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <Card
              size="sm"
              className={cn(
                "relative h-full gap-2 py-3 transition-[background-color,box-shadow,opacity] hover:bg-card-elevated hover:ring-foreground/20",
                live &&
                  "before:absolute before:inset-y-3 before:left-0 before:w-0.5 before:rounded-r-full before:bg-success",
                moving && "opacity-60",
              )}
            />
          }
        >
          <button
            ref={setActivatorNodeRef}
            type="button"
            className="absolute inset-0 cursor-grab rounded-xl outline-none active:cursor-grabbing focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--focus-ring-color)]"
            aria-label={`打开${user.user_name}的直播间，可拖动卡片或通过菜单移动分组`}
            onPointerEnter={() => preloadRouteModule(roomPath)}
            onFocus={() => preloadRouteModule(roomPath)}
            onClick={() => onNavigate(roomPath)}
            {...attributes}
            {...listeners}
          />

          <CardHeader className="pointer-events-none items-center gap-x-2.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <Avatar size="lg">
                <AvatarImage src={avatarSrc} alt="" referrerPolicy="no-referrer" />
                <AvatarFallback>{(user.user_name || "?").slice(0, 1)}</AvatarFallback>
              </Avatar>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <CardTitle className="truncate" title={user.user_name}>
                  {user.user_name}
                </CardTitle>
                <CardDescription className="truncate">
                  {SITE_LABELS[user.site_id] ?? user.site_id} · 房间 {user.room_id}
                </CardDescription>
              </div>
            </div>

            <CardAction className="pointer-events-auto relative z-10 flex items-center gap-0.5 self-center">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={removeDisabled || moving}
                      className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      aria-label={`删除${user.user_name}关注`}
                      onClick={() => onRemove(user)}
                    />
                  }
                >
                  {removing ? <Spinner aria-hidden /> : <Trash2 aria-hidden />}
                </TooltipTrigger>
                <TooltipContent>删除关注</TooltipContent>
              </Tooltip>
            </CardAction>
          </CardHeader>

          <CardContent className="pointer-events-none flex min-h-5 min-w-0 items-center gap-1.5 overflow-hidden">
            {live && (
              <Badge variant="secondary" className="bg-success/15 text-success">
                直播中
              </Badge>
            )}
            {liveDuration && (
              <Badge variant="outline" title={`开播时长：${liveDuration}`}>
                <Clock3 aria-hidden />
                开播 {liveDuration}
              </Badge>
            )}
            {offline && <Badge variant="secondary">未开播</Badge>}
            {user.live_status == null && <Badge variant="outline">状态未知</Badge>}
            {recordingSupported && user.auto_record && (
              <Badge variant="outline">
                <CircleDot aria-hidden />
                自动录制
              </Badge>
            )}
          </CardContent>
        </ContextMenuTrigger>

        <ContextMenuContent>
          <ContextMenuGroup>
            <ContextMenuItem
              onFocus={() => preloadRouteModule(roomPath)}
              onClick={() => onNavigate(roomPath)}
            >
              <CirclePlay aria-hidden />
              打开直播间
            </ContextMenuItem>
            {recordingSupported && (
              <>
                <ContextMenuItem
                  disabled={!live || recordingBusy || recordingActive}
                  onClick={() => onStartRecording(user)}
                >
                  {recordingStarting ? <Spinner aria-hidden /> : <CircleDot aria-hidden />}
                  {recordingActive
                    ? "正在录制"
                    : recordingStarting
                      ? "正在开启录制…"
                      : "开启录制"}
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
    </li>
  );
}

function FollowDragOverlay({ user }: { user: FollowUser }) {
  return (
    <Card size="sm" className="w-64 gap-2 py-3 shadow-lg ring-2 ring-primary/50">
      <CardHeader className="items-center gap-x-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <Avatar size="lg">
            <AvatarImage src={normalizeImageUrl(user.face)} alt="" referrerPolicy="no-referrer" />
            <AvatarFallback>{(user.user_name || "?").slice(0, 1)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <CardTitle className="truncate">{user.user_name}</CardTitle>
            <CardDescription className="truncate">
              {SITE_LABELS[user.site_id] ?? user.site_id}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
    </Card>
  );
}

export function FollowPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const activeView = followViewFromSearch(searchParams.get(FOLLOW_VIEW_PARAM));
  const viewMotionRef = useRef<HTMLDivElement>(null);
  const previousViewRef = useRef<FollowView>(activeView);
  const skipViewMotionRef = useRef(false);
  const [liveFilter, setLiveFilter] = useState<LiveFilter>("all");
  const [selectedGroupId, setSelectedGroupId] = useState(ALL_FOLLOW_GROUP_ID);
  const [activeFollow, setActiveFollow] = useState<FollowUser | null>(null);
  const [groupManagerOpen, setGroupManagerOpen] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<FollowUser | null>(null);
  const disabledSiteIds = useSettingsStore((state) => state.disabledSiteIds);
  const iptvCustomM3uUrl = useSettingsStore((state) => state.iptvCustomM3uUrl);
  const recording = useFollowRecordingController();
  const sensors = useFollowDndSensors();

  useFollowStatusRefresh(activeView === "live");
  const platformFilter = followPlatformFromSearch(
    searchParams.get(FOLLOW_PLATFORM_PARAM),
    disabledSiteIds,
  );
  const visibleSiteIds = useMemo(() => enabledSiteIds(disabledSiteIds), [disabledSiteIds]);
  const rawPlatform = followPlatformFromSearch(searchParams.get(FOLLOW_PLATFORM_PARAM));

  useEffect(() => {
    if (rawPlatform === platformFilter) return;
    setSearchParams((current) => withFollowPlatform(current, platformFilter), { replace: true });
  }, [platformFilter, rawPlatform, setSearchParams]);

  const followsQuery = useQuery({
    queryKey: FOLLOW_LIST_QUERY_KEY,
    queryFn: () => invokeCmd<FollowUser[]>("follow_list"),
  });
  const groupsQuery = useQuery({
    queryKey: FOLLOW_GROUPS_QUERY_KEY,
    queryFn: () => invokeCmd<FollowGroup[]>("tag_list"),
    staleTime: 30_000,
    select: sortFollowGroups,
  });
  const iptvFavoritesQuery = useAllIptvFavorites();
  const iptvGroupsQuery = useIptvFavoriteGroups();
  const iptvSource = useMemo(
    () => playlistSourceFromRoute(searchParams.get(FOLLOW_IPTV_SOURCE_PARAM), iptvCustomM3uUrl),
    [iptvCustomM3uUrl, searchParams],
  );
  const iptvSources = useMemo(() => {
    const sources = playlistSourcesForSettings(iptvCustomM3uUrl);
    if (iptvSource.id === "custom" && !sources.some((candidate) => candidate.id === "custom")) {
      sources.push(iptvSource);
    }
    return sources;
  }, [iptvCustomM3uUrl, iptvSource]);
  const iptvSourceFavorites = useMemo(
    () => iptvFavoritesForSource(iptvFavoritesQuery.data ?? [], iptvFavoriteSourceId(iptvSource)),
    [iptvFavoritesQuery.data, iptvSource],
  );
  const iptvGroupOptions = useMemo(
    () => iptvFollowGroups(iptvSourceFavorites, iptvGroupsQuery.data ?? []),
    [iptvGroupsQuery.data, iptvSourceFavorites],
  );
  const rawIptvGroup = searchParams.get(FOLLOW_IPTV_GROUP_PARAM);
  const selectedIptvGroup =
    rawIptvGroup && (iptvFavoritesQuery.data === undefined || iptvGroupsQuery.data === undefined)
      ? rawIptvGroup
      : iptvFollowGroupFromSearch(rawIptvGroup, iptvGroupOptions);

  useEffect(() => {
    if (
      activeView !== "iptv" ||
      iptvFavoritesQuery.data === undefined ||
      iptvGroupsQuery.data === undefined ||
      rawIptvGroup === selectedIptvGroup
    ) {
      return;
    }
    setSearchParams((current) => withIptvFollowGroup(current, selectedIptvGroup), {
      replace: true,
    });
  }, [
    activeView,
    iptvFavoritesQuery.data,
    iptvGroupsQuery.data,
    rawIptvGroup,
    selectedIptvGroup,
    setSearchParams,
  ]);

  useGSAP(
    () => {
      const previousView = previousViewRef.current;
      previousViewRef.current = activeView;
      if (previousView === activeView) return;

      const panel = viewMotionRef.current?.querySelector<HTMLElement>(
        `[data-follow-view-panel="${activeView}"]`,
      );
      if (!panel) return;
      if (skipViewMotionRef.current) {
        skipViewMotionRef.current = false;
        gsap.set(panel, { clearProps: "transform,opacity,visibility,willChange" });
        return;
      }
      if (prefersReducedMotion()) {
        gsap.set(panel, { clearProps: "transform,opacity,visibility,willChange" });
        return;
      }

      gsap.fromTo(
        panel,
        { autoAlpha: 0, x: activeView === "iptv" ? 18 : -18 },
        {
          autoAlpha: 1,
          x: 0,
          duration: 0.24,
          ease: "power2.out",
          overwrite: "auto",
          willChange: "transform,opacity",
          clearProps: "transform,opacity,visibility,willChange",
        },
      );
    },
    { dependencies: [activeView], scope: viewMotionRef, revertOnUpdate: true },
  );

  const refreshMutation = useMutation({
    mutationFn: () => refreshFollows(queryClient),
    onError: () => notify.error("刷新关注列表失败", "请检查网络后重试。"),
  });

  const removeMutation = useMutation({
    mutationFn: (user: FollowUser) =>
      invokeCmd("follow_remove", {
        siteId: user.site_id,
        roomId: user.room_id,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: FOLLOW_LIST_QUERY_KEY });
      notify.success("已取消关注");
    },
    onError: () => notify.error("取消关注失败", "请检查网络后重试。"),
  });

  const groups = groupsQuery.data ?? EMPTY_GROUPS;
  const allFollows = followsQuery.data ?? EMPTY_FOLLOWS;
  const platformItems = useMemo(() => {
    let list = allFollows.filter((follow) => isSiteEnabled(follow.site_id, disabledSiteIds));
    if (platformFilter !== "all") {
      list = list.filter((follow) => follow.site_id === platformFilter);
    }
    return list;
  }, [allFollows, disabledSiteIds, platformFilter]);

  const statusItems = useMemo(() => {
    if (liveFilter === "live") return platformItems.filter((follow) => follow.live_status === true);
    if (liveFilter === "offline") {
      return platformItems.filter((follow) => follow.live_status === false);
    }
    return platformItems;
  }, [liveFilter, platformItems]);

  const items = useMemo(
    () =>
      sortFollowsByStatus(
        statusItems.filter((follow) => followBelongsToGroup(follow, selectedGroupId, groups)),
      ),
    [groups, selectedGroupId, statusItems],
  );

  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>([[ALL_FOLLOW_GROUP_ID, statusItems.length]]);
    for (const group of groups) counts.set(group.id, 0);
    counts.set(UNGROUPED_FOLLOW_GROUP_ID, 0);
    for (const follow of statusItems) {
      const id = followGroupId(follow, groups);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [groups, statusItems]);

  const allGroupCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const group of groups) counts.set(group.id, 0);
    for (const follow of allFollows) {
      const id = followGroupId(follow, groups);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [allFollows, groups]);

  useEffect(() => {
    if (
      selectedGroupId !== ALL_FOLLOW_GROUP_ID &&
      selectedGroupId !== UNGROUPED_FOLLOW_GROUP_ID &&
      !groups.some((group) => group.id === selectedGroupId)
    ) {
      setSelectedGroupId(ALL_FOLLOW_GROUP_ID);
    }
  }, [groups, selectedGroupId]);

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
          followIdentity(item) === followIdentity(user)
            ? { ...item, auto_record: enabled }
            : item,
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

  const hasLiveDuration = items.some(
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

  const groupTargets = [
    { id: ALL_FOLLOW_GROUP_ID, name: "全部关注" },
    ...groups,
    { id: UNGROUPED_FOLLOW_GROUP_ID, name: "未分组" },
  ];
  const selectedGroupName =
    selectedGroupId === ALL_FOLLOW_GROUP_ID
      ? "全部关注"
      : selectedGroupId === UNGROUPED_FOLLOW_GROUP_ID
        ? "未分组"
        : (groups.find((group) => group.id === selectedGroupId)?.name ?? "全部关注");
  const dragAnnouncements = useMemo<Announcements>(() => {
    const userName = (active: DragStartEvent["active"]) =>
      (active.data.current?.follow as FollowUser | undefined)?.user_name ?? "主播";
    const targetName = (over: DragEndEvent["over"]) => {
      const groupId = over?.data.current?.groupId as string | undefined;
      if (!groupId) return null;
      if (groupId === UNGROUPED_FOLLOW_GROUP_ID) return "未分组";
      return groups.find((group) => group.id === groupId)?.name ?? null;
    };
    return {
      onDragStart: ({ active }) => `已选中${userName(active)}。`,
      onDragOver: ({ active, over }) => {
        const groupName = targetName(over);
        return groupName
          ? `${userName(active)}已移动到${groupName}上方。`
          : `${userName(active)}当前不在分组上方。`;
      },
      onDragEnd: ({ active, over }) => {
        const groupName = targetName(over);
        return groupName ? `${userName(active)}已移至${groupName}。` : "移动已取消。";
      },
      onDragCancel: () => "移动已取消。",
    };
  }, [groups]);

  function moveFollow(user: FollowUser, groupId: string) {
    if (followGroupId(user, groups) === groupId || moveMutation.isPending) return;
    moveMutation.mutate({ user, groupId });
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveFollow((event.active.data.current?.follow as FollowUser | undefined) ?? null);
  }

  function handleDragEnd(event: DragEndEvent) {
    const user = event.active.data.current?.follow as FollowUser | undefined;
    const groupId = event.over?.data.current?.groupId as string | undefined;
    setActiveFollow(null);
    if (user && groupId) moveFollow(user, groupId);
  }

  const loading = followsQuery.isLoading || groupsQuery.isLoading;
  const activeLoading =
    activeView === "live" ? loading : iptvFavoritesQuery.isLoading || iptvGroupsQuery.isLoading;
  const activeRefreshing =
    activeView === "live"
      ? refreshMutation.isPending
      : iptvFavoritesQuery.isFetching || iptvGroupsQuery.isFetching;

  async function refreshActiveView() {
    if (activeView === "live") {
      await refreshMutation.mutateAsync();
      return;
    }
    const [favoritesResult, groupsResult] = await Promise.all([
      iptvFavoritesQuery.refetch(),
      iptvGroupsQuery.refetch(),
    ]);
    if (favoritesResult.isError) throw favoritesResult.error;
    if (groupsResult.isError) throw groupsResult.error;
  }

  const handleViewChange = useCallback(
    (value: string | FollowView) => {
      const view = value as FollowView;
      setSearchParams((current) => withFollowView(current, view));
    },
    [setSearchParams],
  );

  const handleViewChangeFromSwipe = useCallback(
    (view: FollowView) => {
      skipViewMotionRef.current = true;
      handleViewChange(view);
    },
    [handleViewChange],
  );

  const followTabSwipe = useHorizontalSwipe({
    items: ["live", "iptv"] as const,
    value: activeView,
    onChange: handleViewChangeFromSwipe,
    enabled: isMobileClient(),
    // Clicked tabs use the existing GSAP fade; a committed gesture settles
    // directly from the pointer release in the hook.
    animate: false,
    layout: "track",
  });

  const headerState = useMemo(
    () => ({
      view: activeView,
      onViewChange: handleViewChange,
    }),
    [activeView, handleViewChange],
  );
  useFollowHeaderState(headerState);

  const handlePlatformChange = useCallback(
    (value: FollowPlatformFilter) => {
      setSearchParams((current) => withFollowPlatform(current, value));
    },
    [setSearchParams],
  );

  const handleIptvSourceChange = useCallback(
    (sourceId: string) => {
      if (!iptvSources.some((source) => source.id === sourceId)) return;
      setSearchParams((current) => withIptvFollowSource(current, sourceId));
    },
    [iptvSources, setSearchParams],
  );

  return (
    <PullToRefresh
      data-horizontal-swipe-surface
      onRefresh={refreshActiveView}
      refreshing={activeRefreshing}
      className="mx-auto max-w-[1600px]"
      onPointerDownCapture={followTabSwipe.onPointerDownCapture}
      onPointerMoveCapture={followTabSwipe.onPointerMoveCapture}
      onPointerUpCapture={followTabSwipe.onPointerUpCapture}
      onPointerCancelCapture={followTabSwipe.onPointerCancelCapture}
      onClickCapture={followTabSwipe.onClickCapture}
    >
      <RefreshFab
        onRefresh={refreshActiveView}
        pending={activeRefreshing || activeLoading}
        label={activeView === "live" ? "刷新直播关注" : "刷新 IPTV 关注"}
      />

      <div ref={viewMotionRef}>
        <Tabs value={activeView} onValueChange={handleViewChange} className="gap-4">
          <div data-slot="horizontal-swipe-viewport" className="min-w-0 overflow-x-clip">
            <div
              ref={followTabSwipe.bindPage}
              data-slot="horizontal-swipe-track"
              className="flex items-start"
              style={{ width: "200%" }}
            >
              <TabsContent
                value="live"
                keepMounted
                hidden={false}
                inert={activeView === "live" ? undefined : true}
                className="mt-0 min-w-0 shrink-0 overflow-x-clip px-px"
                style={{ width: "50%" }}
              >
                <div data-follow-view-panel="live" className="flex flex-col gap-4">
                  {(followsQuery.isError || groupsQuery.isError) && (
                    <ErrorState
                      error={followsQuery.error ?? groupsQuery.error}
                      title="关注列表加载失败"
                      onRetry={() => {
                        void followsQuery.refetch();
                        void groupsQuery.refetch();
                      }}
                    />
                  )}

                  {!followsQuery.isError && !groupsQuery.isError && (
                    <DndContext
                      sensors={sensors}
                      collisionDetection={groupTargetCollisionDetection}
                      accessibility={{
                        announcements: dragAnnouncements,
                        screenReaderInstructions: FOLLOW_DND_INSTRUCTIONS,
                      }}
                      onDragStart={handleDragStart}
                      onDragCancel={() => setActiveFollow(null)}
                      onDragEnd={handleDragEnd}
                    >
                      <div className="grid min-w-0 items-start gap-4 md:grid-cols-[13rem_minmax(0,1fr)]">
                        <nav
                          aria-label="直播分组"
                          className="sticky top-3 hidden max-h-[calc(100dvh-7rem)] min-w-0 flex-col gap-1 border-r border-border pr-3 md:flex"
                        >
                          <div className="flex flex-col gap-2">
                            <PlatformFilterSelect
                              value={platformFilter}
                              sites={visibleSiteIds}
                              compact={false}
                              onValueChange={handlePlatformChange}
                            />
                            <Select
                              value={liveFilter}
                              onValueChange={(value) => {
                                const next = value as LiveFilter | null;
                                if (next) setLiveFilter(next);
                              }}
                            >
                              <SelectTrigger
                                size="sm"
                                className="w-full border border-input bg-background"
                                aria-label="关注状态筛选"
                              >
                                <Activity data-icon="inline-start" aria-hidden />
                                <SelectValue>
                                  {liveFilter === "live"
                                    ? "直播中"
                                    : liveFilter === "offline"
                                      ? "未开播"
                                      : "全部状态"}
                                </SelectValue>
                              </SelectTrigger>
                              <SelectContent align="start">
                                <SelectGroup>
                                  <SelectItem value="all">全部状态</SelectItem>
                                  <SelectItem value="live">直播中</SelectItem>
                                  <SelectItem value="offline">未开播</SelectItem>
                                </SelectGroup>
                              </SelectContent>
                            </Select>
                          </div>
                          <Separator className="my-1" />
                          <div className="mb-1 flex items-center justify-between gap-2 px-2">
                            <span className="text-xs font-medium text-muted-foreground">
                              直播分组
                            </span>
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-xs"
                                    aria-label="管理关注分组"
                                    onClick={() => setGroupManagerOpen(true)}
                                  />
                                }
                              >
                                <FolderCog aria-hidden />
                              </TooltipTrigger>
                              <TooltipContent>管理分组</TooltipContent>
                            </Tooltip>
                          </div>
                          <div className="flex min-h-0 flex-col gap-1 overflow-y-auto py-0.5">
                            {groupTargets.map((group) => (
                              <GroupTarget
                                key={group.id}
                                groupId={group.id}
                                label={group.name}
                                count={groupCounts.get(group.id) ?? 0}
                                selected={selectedGroupId === group.id}
                                dragActive={activeFollow != null}
                                surface="desktop"
                                onSelect={() => setSelectedGroupId(group.id)}
                              />
                            ))}
                          </div>
                        </nav>

                        <section
                          className="flex min-w-0 flex-col gap-3"
                          aria-label={selectedGroupName}
                        >
                          <div className="flex min-w-0 gap-2 md:hidden">
                            <PlatformFilterSelect
                              value={platformFilter}
                              sites={visibleSiteIds}
                              compact={false}
                              className="min-w-0 flex-1"
                              onValueChange={handlePlatformChange}
                            />
                            <Select
                              value={liveFilter}
                              onValueChange={(value) => {
                                const next = value as LiveFilter | null;
                                if (next) setLiveFilter(next);
                              }}
                            >
                              <SelectTrigger
                                size="sm"
                                className="min-w-0 flex-1 border border-input bg-background"
                                aria-label="关注状态筛选"
                              >
                                <Activity data-icon="inline-start" aria-hidden />
                                <SelectValue>
                                  {liveFilter === "live"
                                    ? "直播中"
                                    : liveFilter === "offline"
                                      ? "未开播"
                                      : "全部状态"}
                                </SelectValue>
                              </SelectTrigger>
                              <SelectContent align="start">
                                <SelectGroup>
                                  <SelectItem value="all">全部状态</SelectItem>
                                  <SelectItem value="live">直播中</SelectItem>
                                  <SelectItem value="offline">未开播</SelectItem>
                                </SelectGroup>
                              </SelectContent>
                            </Select>
                          </div>
                          <div
                            data-horizontal-swipe-surface
                            className="-mx-1 flex items-center gap-1 overflow-x-auto px-1 pb-1 md:hidden"
                          >
                            {groupTargets.map((group) => (
                              <GroupTarget
                                key={group.id}
                                groupId={group.id}
                                label={group.name}
                                count={groupCounts.get(group.id) ?? 0}
                                selected={selectedGroupId === group.id}
                                dragActive={activeFollow != null}
                                surface="mobile"
                                onSelect={() => setSelectedGroupId(group.id)}
                              />
                            ))}
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              className="shrink-0"
                              aria-label="管理关注分组"
                              onClick={() => setGroupManagerOpen(true)}
                            >
                              <FolderCog aria-hidden />
                            </Button>
                          </div>

                          {loading && (
                            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,17rem),1fr))] gap-2.5">
                              {Array.from({ length: 10 }).map((_, index) => (
                                <Card key={index} size="sm" className="gap-2">
                                  <CardHeader className="items-center gap-x-2.5">
                                    <div className="flex min-w-0 items-center gap-2.5">
                                      <Skeleton className="size-10 shrink-0 rounded-full" />
                                      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                                        <Skeleton className="h-3.5 w-3/5" />
                                        <Skeleton className="h-3 w-4/5" />
                                      </div>
                                    </div>
                                    <CardAction className="self-center">
                                      <Skeleton className="size-7 rounded-lg" />
                                    </CardAction>
                                  </CardHeader>
                                  <CardContent className="flex min-h-5 items-center gap-1.5">
                                    <Skeleton className="h-5 w-14 rounded-full" />
                                  </CardContent>
                                </Card>
                              ))}
                            </div>
                          )}

                          {!loading && allFollows.length === 0 && (
                            <Empty className="min-h-64 py-12">
                              <EmptyHeader>
                                <EmptyMedia variant="icon">
                                  <Star aria-hidden />
                                </EmptyMedia>
                                <EmptyTitle>还没有关注任何主播</EmptyTitle>
                                <EmptyDescription>打开直播间后即可添加关注。</EmptyDescription>
                              </EmptyHeader>
                              <EmptyContent>
                                <Button variant="outline" size="sm" onClick={() => navigate("/")}>
                                  <Home data-icon="inline-start" aria-hidden />
                                  去首页看看
                                </Button>
                              </EmptyContent>
                            </Empty>
                          )}

                          {!loading && allFollows.length > 0 && items.length === 0 && (
                            <Empty className="min-h-56 py-10">
                              <EmptyHeader>
                                <EmptyMedia variant="icon">
                                  <Folder aria-hidden />
                                </EmptyMedia>
                                <EmptyTitle>当前没有主播</EmptyTitle>
                                <EmptyDescription>这个分组或筛选条件下暂无内容。</EmptyDescription>
                              </EmptyHeader>
                              <EmptyContent>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => {
                                    setSelectedGroupId(ALL_FOLLOW_GROUP_ID);
                                    setLiveFilter("all");
                                  }}
                                >
                                  <Layers3 data-icon="inline-start" aria-hidden />
                                  查看全部关注
                                </Button>
                              </EmptyContent>
                            </Empty>
                          )}

                          {items.length > 0 && (
                            <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,17rem),1fr))] gap-2.5">
                              {items.map((user) => {
                                const identity = followIdentity(user);
                                const recordingStarting =
                                  recording.pendingTarget != null &&
                                  followIdentity(recording.pendingTarget) === identity;
                                const autoRecordingBusy =
                                  autoRecordMutation.isPending &&
                                  followIdentity(autoRecordMutation.variables.user) === identity;
                                return (
                                  <FollowCard
                                    key={identity}
                                    user={user}
                                    groups={groups}
                                    now={now}
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
                                    onNavigate={(path) => navigate(path)}
                                    onMove={moveFollow}
                                    onRemove={setPendingRemove}
                                    onStartRecording={recording.start}
                                    onAutoRecordingChange={(target, enabled) => {
                                      if (!autoRecordMutation.isPending) {
                                        autoRecordMutation.mutate({ user: target, enabled });
                                      }
                                    }}
                                  />
                                );
                              })}
                            </ul>
                          )}
                        </section>
                      </div>

                      <DragOverlay dropAnimation={{ duration: 160, easing: "ease-out" }}>
                        {activeFollow ? <FollowDragOverlay user={activeFollow} /> : null}
                      </DragOverlay>
                    </DndContext>
                  )}
                </div>
              </TabsContent>

              <TabsContent
                value="iptv"
                keepMounted
                hidden={false}
                inert={activeView === "iptv" ? undefined : true}
                className="mt-0 min-w-0 shrink-0 overflow-x-clip px-px"
                style={{ width: "50%" }}
              >
                <div data-follow-view-panel="iptv">
                  <IptvFollowView
                    source={iptvSource}
                    sources={iptvSources}
                    favorites={iptvSourceFavorites}
                    groups={iptvGroupsQuery.data ?? []}
                    selectedGroup={selectedIptvGroup}
                    loading={iptvFavoritesQuery.isLoading || iptvGroupsQuery.isLoading}
                    error={iptvFavoritesQuery.error ?? iptvGroupsQuery.error}
                    onRetry={() => {
                      void iptvFavoritesQuery.refetch();
                      void iptvGroupsQuery.refetch();
                    }}
                    onGroupChange={(groupId) =>
                      setSearchParams((current) => withIptvFollowGroup(current, groupId))
                    }
                    onSourceChange={handleIptvSourceChange}
                  />
                </div>
              </TabsContent>
            </div>
          </div>
        </Tabs>
      </div>

      <FollowGroupManagerDialog
        open={groupManagerOpen}
        groups={groups}
        counts={allGroupCounts}
        onOpenChange={setGroupManagerOpen}
      />

      <AlertDialog
        open={pendingRemove != null}
        onOpenChange={(open) => {
          if (removeMutation.isPending) return;
          if (!open) setPendingRemove(null);
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10 text-destructive">
              <UserRoundX aria-hidden />
            </AlertDialogMedia>
            <AlertDialogTitle>取消关注</AlertDialogTitle>
            <AlertDialogDescription>
              确定不再关注 {pendingRemove?.user_name} 吗？取消后将不再显示在关注列表中。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removeMutation.isPending}>取消</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              variant="destructive"
              disabled={removeMutation.isPending}
              onClick={() => {
                if (pendingRemove) removeMutation.mutate(pendingRemove);
                setPendingRemove(null);
              }}
            >
              <UserRoundX data-icon="inline-start" aria-hidden />
              取消关注
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PullToRefresh>
  );
}
