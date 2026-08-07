import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  Check,
  CirclePlay,
  Folder,
  FolderCog,
  FolderInput,
  Heart,
  Inbox,
  Layers3,
  Trash2,
  Tv,
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  type IptvFavorite,
  type IptvFavoriteGroup,
  useRemoveIptvFavoriteMutation,
  useSetIptvFavoriteGroupMutation,
} from "@/features/iptv/favorites";
import { iptvHomePath, iptvPlayerPath } from "@/features/iptv/iptvRoute";
import {
  iptvFavoriteSourceLabel,
  playlistSourceForFavorite,
  type PlaylistSource,
} from "@/features/iptv/playlistSource";
import { ErrorState } from "@/shared/components/ErrorState";
import { cn } from "@/lib/utils";
import { PagePan } from "@/shared/motion/PagePan";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { IptvFollowGroupManagerDialog } from "./IptvFollowGroupManagerDialog";
import { groupTargetCollisionDetection } from "./groupCollisionDetection";
import {
  IPTV_FOLLOW_UNGROUPED_ID,
  IPTV_FOLLOW_UNGROUPED_NAME,
  iptvFavoriteBelongsToGroup,
  iptvFavoriteGroupId,
  iptvFollowGroups,
  iptvM3uGroupName,
  type IptvFollowGroup,
} from "./iptvFollowGroups";

function favoriteIdentity(favorite: IptvFavorite): string {
  return `${favorite.source_id}\0${favorite.url}`;
}

const IPTV_FOLLOW_DND_INSTRUCTIONS = {
  draggable: "按空格键选中频道，使用方向键移动，按空格键放入分组，按 Escape 取消。",
};

function IptvGroupTarget({
  group,
  total,
  selected,
  dragActive,
  surface,
  onSelect,
}: {
  group: IptvFollowGroup | null;
  total: number;
  selected: boolean;
  dragActive: boolean;
  surface: "desktop" | "mobile";
  onSelect: () => void;
}) {
  const groupId = group?.id ?? null;
  const canDrop = groupId !== null;
  const { isOver, setNodeRef } = useDroppable({
    id: `${surface}:${groupId ?? "all"}`,
    data: { groupId },
    disabled: !dragActive || !canDrop,
  });
  const Icon = groupId === null ? Layers3 : groupId === IPTV_FOLLOW_UNGROUPED_ID ? Inbox : Folder;
  const label = group?.name ?? "全部频道";
  const count = group?.count ?? total;

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

function IptvFavoriteCard({
  favorite,
  groups,
  showFavoriteGroup,
  moving,
  removing,
  removeDisabled,
  onOpen,
  onMove,
  onRemove,
}: {
  favorite: IptvFavorite;
  groups: readonly IptvFavoriteGroup[];
  showFavoriteGroup: boolean;
  moving: boolean;
  removing: boolean;
  removeDisabled: boolean;
  onOpen: (favorite: IptvFavorite) => void;
  onMove: (favorite: IptvFavorite, groupId: string) => void;
  onRemove: (favorite: IptvFavorite) => void;
}) {
  const sourceLabel = iptvFavoriteSourceLabel(favorite.source_id);
  const currentGroupId = iptvFavoriteGroupId(favorite, groups);
  const currentGroupName =
    currentGroupId === IPTV_FOLLOW_UNGROUPED_ID
      ? IPTV_FOLLOW_UNGROUPED_NAME
      : (groups.find((group) => group.id === currentGroupId)?.name ?? IPTV_FOLLOW_UNGROUPED_NAME);
  const { attributes, isDragging, listeners, setActivatorNodeRef, setNodeRef } = useDraggable({
    id: favoriteIdentity(favorite),
    data: { favorite },
    disabled: moving,
  });

  return (
    <li ref={setNodeRef} className={cn("min-w-0", isDragging && "opacity-35")}>
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <Card
              size="sm"
              className={cn(
                "relative h-full gap-2 py-3 transition-[background-color,box-shadow,opacity] hover:bg-card-elevated hover:ring-foreground/20",
                moving && "opacity-60",
              )}
            />
          }
        >
          <button
            ref={setActivatorNodeRef}
            type="button"
            className="absolute inset-0 cursor-grab rounded-xl outline-none active:cursor-grabbing focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            aria-label={`播放 ${favorite.name}，拖动卡片可移动分组`}
            onPointerEnter={() => preloadRouteModule("/iptv/play")}
            onFocus={() => preloadRouteModule("/iptv/play")}
            onClick={() => onOpen(favorite)}
            {...attributes}
            {...listeners}
          />

          <CardHeader className="pointer-events-none items-center gap-x-2.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted ring-1 ring-border-subtle">
                {favorite.logo ? (
                  <img
                    src={favorite.logo}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    referrerPolicy="no-referrer"
                    className="size-full object-contain p-1"
                  />
                ) : (
                  <Tv className="size-5 text-muted-foreground" aria-hidden />
                )}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <CardTitle className="truncate" title={favorite.name}>
                  {favorite.name || "未命名频道"}
                </CardTitle>
                <CardDescription className="truncate" title={sourceLabel}>
                  {sourceLabel}
                </CardDescription>
              </div>
            </div>

            <CardAction className="pointer-events-auto relative z-10 self-center">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={removeDisabled || moving}
                      className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      aria-label={`删除${favorite.name}关注`}
                      onClick={() => onRemove(favorite)}
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
            <Badge
              variant="outline"
              className="min-w-0 shrink"
              title={`播放列表分类：${iptvM3uGroupName(favorite)}`}
            >
              <Folder aria-hidden />
              <span className="truncate">{iptvM3uGroupName(favorite)}</span>
            </Badge>
            {showFavoriteGroup && (
              <Badge variant="outline" className="min-w-0 shrink" title={currentGroupName}>
                <FolderInput aria-hidden />
                <span className="truncate">{currentGroupName}</span>
              </Badge>
            )}
          </CardContent>
        </ContextMenuTrigger>

        <ContextMenuContent>
          <ContextMenuGroup>
            <ContextMenuItem
              onFocus={() => preloadRouteModule("/iptv/play")}
              onClick={() => onOpen(favorite)}
            >
              <CirclePlay aria-hidden />
              播放频道
            </ContextMenuItem>
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
                      onClick={() => onMove(favorite, group.id)}
                    >
                      <Folder aria-hidden />
                      {group.name}
                      {currentGroupId === group.id && <Check aria-hidden />}
                    </ContextMenuItem>
                  ))}
                  <ContextMenuItem
                    disabled={moving || currentGroupId === IPTV_FOLLOW_UNGROUPED_ID}
                    onClick={() => onMove(favorite, IPTV_FOLLOW_UNGROUPED_ID)}
                  >
                    <Inbox aria-hidden />
                    {IPTV_FOLLOW_UNGROUPED_NAME}
                    {currentGroupId === IPTV_FOLLOW_UNGROUPED_ID && <Check aria-hidden />}
                  </ContextMenuItem>
                </ContextMenuGroup>
              </ContextMenuSubContent>
            </ContextMenuSub>
          </ContextMenuGroup>
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            disabled={removeDisabled}
            onClick={() => onRemove(favorite)}
          >
            {removing ? <Spinner aria-hidden /> : <Trash2 aria-hidden />}
            删除关注
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </li>
  );
}

function IptvFollowSkeleton() {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,17rem),1fr))] gap-2.5">
      {Array.from({ length: 10 }).map((_, index) => (
        <Card key={index} size="sm" className="gap-2">
          <CardHeader className="items-center gap-x-2.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <Skeleton className="size-10 shrink-0 rounded-lg" />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Skeleton className="h-3.5 w-3/5" />
                <Skeleton className="h-3 w-2/5" />
              </div>
            </div>
            <CardAction className="self-center">
              <Skeleton className="size-7 rounded-lg" />
            </CardAction>
          </CardHeader>
          <CardContent>
            <Skeleton className="h-5 w-14 rounded-full" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function IptvFavoriteDragOverlay({ favorite }: { favorite: IptvFavorite }) {
  return (
    <Card size="sm" className="w-[min(22rem,80vw)] gap-2 py-3 opacity-95 shadow-xl">
      <CardHeader className="items-center gap-x-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted ring-1 ring-border-subtle">
            {favorite.logo ? (
              <img
                src={favorite.logo}
                alt=""
                referrerPolicy="no-referrer"
                className="size-full object-contain p-1"
              />
            ) : (
              <Tv className="size-5 text-muted-foreground" aria-hidden />
            )}
          </div>
          <div className="min-w-0">
            <CardTitle className="truncate">{favorite.name || "未命名频道"}</CardTitle>
            <CardDescription className="truncate">
              {iptvFavoriteSourceLabel(favorite.source_id)}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
    </Card>
  );
}

export function IptvFollowView({
  source,
  favorites,
  groups,
  selectedGroup,
  loading,
  error,
  onRetry,
  onGroupChange,
}: {
  source: PlaylistSource;
  favorites: readonly IptvFavorite[];
  groups: readonly IptvFavoriteGroup[];
  selectedGroup: string | null;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  onGroupChange: (groupId: string | null) => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const customM3uUrl = useSettingsStore((state) => state.iptvCustomM3uUrl);
  const [pendingRemove, setPendingRemove] = useState<IptvFavorite | null>(null);
  const [activeFavorite, setActiveFavorite] = useState<IptvFavorite | null>(null);
  const [groupManagerOpen, setGroupManagerOpen] = useState(false);
  const removeMutation = useRemoveIptvFavoriteMutation();
  const moveMutation = useSetIptvFavoriteGroupMutation(groups);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 6 } }),
    useSensor(KeyboardSensor),
  );

  const groupOptions = useMemo(() => iptvFollowGroups(favorites, groups), [favorites, groups]);
  const groupCounts = useMemo(
    () => new Map(groupOptions.map((group) => [group.id, group.count])),
    [groupOptions],
  );
  const items = useMemo(
    () =>
      favorites.filter((favorite) => iptvFavoriteBelongsToGroup(favorite, selectedGroup, groups)),
    [favorites, groups, selectedGroup],
  );
  const previousGroupRef = useRef<string | null>(selectedGroup);
  const previousGroup = previousGroupRef.current;
  const groupIds = useMemo(() => groupOptions.map((group) => group.id), [groupOptions]);
  const previousGroupIndex = previousGroup === null ? 0 : groupIds.indexOf(previousGroup) + 1;
  const selectedGroupIndex = selectedGroup === null ? 0 : groupIds.indexOf(selectedGroup) + 1;
  const groupDirection =
    previousGroupIndex >= 0 && selectedGroupIndex >= 0 && selectedGroupIndex < previousGroupIndex
      ? -1
      : 1;

  useEffect(() => {
    previousGroupRef.current = selectedGroup;
  }, [selectedGroup]);

  const selectedGroupName =
    selectedGroup === null
      ? "全部 IPTV 频道"
      : (groupOptions.find((group) => group.id === selectedGroup)?.name ?? "全部 IPTV 频道");
  const dragAnnouncements = useMemo<Announcements>(() => {
    const channelName = (active: DragStartEvent["active"]) =>
      (active.data.current?.favorite as IptvFavorite | undefined)?.name ?? "频道";
    const targetName = (over: DragEndEvent["over"]) => {
      const groupId = over?.data.current?.groupId as string | null | undefined;
      if (groupId === undefined || groupId === null) return null;
      if (groupId === IPTV_FOLLOW_UNGROUPED_ID) return IPTV_FOLLOW_UNGROUPED_NAME;
      return groups.find((group) => group.id === groupId)?.name ?? null;
    };
    return {
      onDragStart: ({ active }) => `已选中${channelName(active)}。`,
      onDragOver: ({ active, over }) => {
        const groupName = targetName(over);
        return groupName
          ? `${channelName(active)}已移动到${groupName}上方。`
          : `${channelName(active)}当前不在分组上方。`;
      },
      onDragEnd: ({ active, over }) => {
        const groupName = targetName(over);
        return groupName ? `${channelName(active)}已移至${groupName}。` : "移动已取消。";
      },
      onDragCancel: () => "移动已取消。",
    };
  }, [groups]);

  function openFavorite(favorite: IptvFavorite) {
    const source = playlistSourceForFavorite(favorite.source_id, customM3uUrl);
    navigate(
      iptvPlayerPath({
        source,
        channelUrl: favorite.url,
        favoriteSourceId: favorite.source_id,
        group: favorite.group,
      }),
      { state: { returnTo: `${location.pathname}${location.search}` } },
    );
  }

  function moveFavorite(favorite: IptvFavorite, groupId: string) {
    if (iptvFavoriteGroupId(favorite, groups) === groupId || moveMutation.isPending) return;
    moveMutation.mutate({
      favorite,
      groupId: groupId === IPTV_FOLLOW_UNGROUPED_ID ? null : groupId,
    });
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveFavorite((event.active.data.current?.favorite as IptvFavorite | undefined) ?? null);
  }

  function handleDragEnd(event: DragEndEvent) {
    const favorite = event.active.data.current?.favorite as IptvFavorite | undefined;
    const groupId = event.over?.data.current?.groupId as string | null | undefined;
    setActiveFavorite(null);
    if (favorite && groupId) moveFavorite(favorite, groupId);
  }

  if (error) {
    return <ErrorState error={error} title="IPTV 关注加载失败" onRetry={onRetry} />;
  }

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={groupTargetCollisionDetection}
        accessibility={{
          announcements: dragAnnouncements,
          screenReaderInstructions: IPTV_FOLLOW_DND_INSTRUCTIONS,
        }}
        onDragStart={handleDragStart}
        onDragCancel={() => setActiveFavorite(null)}
        onDragEnd={handleDragEnd}
      >
        <div className="grid min-w-0 items-start gap-4 md:grid-cols-[13rem_minmax(0,1fr)]">
          <nav
            aria-label="IPTV 分组"
            className="sticky top-3 hidden max-h-[calc(100dvh-7rem)] min-w-0 flex-col gap-1 border-r border-border pr-3 md:flex"
          >
            <div className="mb-1 flex items-center justify-between gap-2 px-2">
              <span className="text-xs font-medium text-muted-foreground">IPTV 分组</span>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label="管理 IPTV 分组"
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
              <IptvGroupTarget
                group={null}
                total={favorites.length}
                selected={selectedGroup === null}
                dragActive={activeFavorite != null}
                surface="desktop"
                onSelect={() => onGroupChange(null)}
              />
              {groupOptions.map((group) => (
                <IptvGroupTarget
                  key={group.id}
                  group={group}
                  total={favorites.length}
                  selected={selectedGroup === group.id}
                  dragActive={activeFavorite != null}
                  surface="desktop"
                  onSelect={() => onGroupChange(group.id)}
                />
              ))}
            </div>
          </nav>

          <section className="flex min-w-0 flex-col gap-3" aria-labelledby="iptv-group-title">
            <div className="-mx-1 flex items-center gap-1 overflow-x-auto px-1 pb-1 md:hidden">
              <IptvGroupTarget
                group={null}
                total={favorites.length}
                selected={selectedGroup === null}
                dragActive={activeFavorite != null}
                surface="mobile"
                onSelect={() => onGroupChange(null)}
              />
              {groupOptions.map((group) => (
                <IptvGroupTarget
                  key={group.id}
                  group={group}
                  total={favorites.length}
                  selected={selectedGroup === group.id}
                  dragActive={activeFavorite != null}
                  surface="mobile"
                  onSelect={() => onGroupChange(group.id)}
                />
              ))}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                aria-label="管理 IPTV 分组"
                onClick={() => setGroupManagerOpen(true)}
              >
                <FolderCog aria-hidden />
              </Button>
            </div>

            <div className="flex min-h-9 items-end border-b border-border pb-2">
              <div className="min-w-0">
                <h2 id="iptv-group-title" className="truncate text-sm font-semibold">
                  {selectedGroupName}
                </h2>
                <p className="text-xs tabular-nums text-muted-foreground">{items.length} 个频道</p>
              </div>
            </div>

            <PagePan
              panKey={selectedGroup === null ? "iptv-follow:all" : `iptv-follow:${selectedGroup}`}
              direction={groupDirection}
              className="h-auto min-h-64"
              contentClassName="h-auto min-h-64"
            >
              <div className="flex min-w-0 flex-col gap-3">
                {loading && <IptvFollowSkeleton />}

                {!loading && favorites.length === 0 && (
                  <Empty className="min-h-64 py-12">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <Tv aria-hidden />
                      </EmptyMedia>
                      <EmptyTitle>当前频道源还没有关注</EmptyTitle>
                      <EmptyDescription>可前往{source.label}列表添加频道。</EmptyDescription>
                    </EmptyHeader>
                    <EmptyContent>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => navigate(iptvHomePath({ source }))}
                      >
                        <Tv data-icon="inline-start" aria-hidden />
                        浏览{source.label}
                      </Button>
                    </EmptyContent>
                  </Empty>
                )}

                {!loading && favorites.length > 0 && items.length === 0 && (
                  <Empty className="min-h-56 py-10">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <Folder aria-hidden />
                      </EmptyMedia>
                      <EmptyTitle>当前分组没有频道</EmptyTitle>
                      <EmptyDescription>可从其他分组的频道卡片中调整归属。</EmptyDescription>
                    </EmptyHeader>
                    <EmptyContent>
                      <Button variant="outline" size="sm" onClick={() => onGroupChange(null)}>
                        <Layers3 data-icon="inline-start" aria-hidden />
                        查看全部频道
                      </Button>
                    </EmptyContent>
                  </Empty>
                )}

                {items.length > 0 && (
                  <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,17rem),1fr))] gap-2.5">
                    {items.map((favorite) => (
                      <IptvFavoriteCard
                        key={favoriteIdentity(favorite)}
                        favorite={favorite}
                        groups={groups}
                        showFavoriteGroup={selectedGroup === null}
                        moving={
                          moveMutation.isPending &&
                          favoriteIdentity(moveMutation.variables.favorite) ===
                            favoriteIdentity(favorite)
                        }
                        removing={
                          removeMutation.isPending &&
                          favoriteIdentity(removeMutation.variables) === favoriteIdentity(favorite)
                        }
                        removeDisabled={removeMutation.isPending}
                        onOpen={openFavorite}
                        onMove={moveFavorite}
                        onRemove={setPendingRemove}
                      />
                    ))}
                  </ul>
                )}
              </div>
            </PagePan>
          </section>
        </div>

        <DragOverlay dropAnimation={{ duration: 160, easing: "ease-out" }}>
          {activeFavorite ? <IptvFavoriteDragOverlay favorite={activeFavorite} /> : null}
        </DragOverlay>
      </DndContext>

      <IptvFollowGroupManagerDialog
        open={groupManagerOpen}
        groups={groups}
        counts={groupCounts}
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
              <Heart aria-hidden />
            </AlertDialogMedia>
            <AlertDialogTitle>取消 IPTV 关注</AlertDialogTitle>
            <AlertDialogDescription>
              确定不再关注 {pendingRemove?.name} 吗？取消后将不再显示在关注列表中。
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
              <Heart data-icon="inline-start" aria-hidden />
              取消关注
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
