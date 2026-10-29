import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Check,
  Clapperboard,
  Folder,
  FolderCog,
  FolderInput,
  Heart,
  Inbox,
  Layers3,
  Trash2,
  UserRoundX,
} from "lucide-react";
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
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
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
import { cn, normalizeImageUrl } from "@/lib/utils";
import { CARD_SURFACE_CLASS, CARD_SURFACE_HOVER_CLASS } from "@/shared/components/cardSurface";
import { ErrorState } from "@/shared/components/ErrorState";
import { isMobileClient } from "@/shared/clientPlatform";
import { useLongPressDrawer } from "@/shared/hooks/useLongPressDrawer";
import { PagePan } from "@/shared/motion/PagePan";
import { UploaderDrawer } from "@/features/video/UploaderDrawer";
import {
  useRemoveVideoFollowMutation,
  useSetVideoFollowGroupMutation,
  videoFollowIdentity,
  type VideoFollow,
  type VideoFollowGroup,
} from "@/features/video/videoFollows";
import { VideoFollowGroupManagerDialog } from "@/features/video/VideoFollowGroupManagerDialog";
import { FollowCardActionDrawer, type FollowCardDrawerGroup } from "./FollowCardActionDrawer";
import {
  UNGROUPED_VIDEO_FOLLOW_ID,
  videoFollowBelongsToGroup,
  videoFollowGroupId,
  videoFollowGroups,
  type VideoFollowGroupOption,
} from "./videoFollowGroups";

function VideoGroupTarget({
  group,
  total,
  selected,
  surface,
  onSelect,
}: {
  group: VideoFollowGroupOption | null;
  total: number;
  selected: boolean;
  surface: "desktop" | "mobile";
  onSelect: () => void;
}) {
  const groupId = group?.id ?? null;
  const Icon = groupId === null ? Layers3 : groupId === UNGROUPED_VIDEO_FOLLOW_ID ? Inbox : Folder;
  return (
    <Button
      type="button"
      variant={selected ? "secondary" : "ghost"}
      size={surface === "desktop" ? "default" : "sm"}
      aria-current={selected ? "page" : undefined}
      className={cn("justify-start", surface === "desktop" ? "w-full" : "shrink-0")}
      onClick={onSelect}
    >
      <Icon data-icon="inline-start" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-left">{group?.name ?? "全部 UP 主"}</span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {group?.count ?? total}
      </span>
    </Button>
  );
}

function VideoFollowCard({
  follow,
  groups,
  showGroup,
  moving,
  moveDisabled,
  removing,
  removeDisabled,
  onOpen,
  onMove,
  onRemove,
}: {
  follow: VideoFollow;
  groups: readonly VideoFollowGroup[];
  showGroup: boolean;
  moving: boolean;
  moveDisabled: boolean;
  removing: boolean;
  removeDisabled: boolean;
  onOpen: (follow: VideoFollow) => void;
  onMove: (follow: VideoFollow, groupId: string) => void;
  onRemove: (follow: VideoFollow) => void;
}) {
  const mobile = isMobileClient();
  const cardDrawer = useLongPressDrawer({ enabled: mobile });
  const currentGroupId = videoFollowGroupId(follow, groups);
  const currentGroupName =
    currentGroupId === UNGROUPED_VIDEO_FOLLOW_ID
      ? "未分组"
      : (groups.find((group) => group.id === currentGroupId)?.name ?? "未分组");

  function openSubmissions() {
    if (cardDrawer.consumeSyntheticClick()) return;
    onOpen(follow);
  }

  const drawerGroups: FollowCardDrawerGroup[] = [
    ...groups.map((group) => ({
      id: group.id,
      name: group.name,
      icon: Folder,
      current: currentGroupId === group.id,
    })),
    {
      id: UNGROUPED_VIDEO_FOLLOW_ID,
      name: "未分组",
      icon: Inbox,
      current: currentGroupId === UNGROUPED_VIDEO_FOLLOW_ID,
    },
  ];
  const cardClassName = cn(
    "relative h-full gap-2 py-3 transition-[background-color,box-shadow,opacity]",
    CARD_SURFACE_CLASS,
    CARD_SURFACE_HOVER_CLASS,
    moving && "opacity-60",
  );

  const cardBody = (
    <>
      <button
        type="button"
        className="absolute inset-0 rounded-xl outline-none"
        aria-label={`查看${follow.name}的投稿视频，可通过菜单移动分组`}
        onClick={openSubmissions}
        onPointerDown={cardDrawer.onPointerDown}
        onPointerMove={cardDrawer.onPointerMove}
        onPointerUp={cardDrawer.onPointerUp}
        onPointerCancel={cardDrawer.onPointerCancel}
        onContextMenu={cardDrawer.onContextMenu}
      />

      <CardHeader className="pointer-events-none items-center gap-x-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <Avatar size="lg">
            <AvatarImage
              src={normalizeImageUrl(follow.face)}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
            />
            <AvatarFallback>{(follow.name || "?").slice(0, 1)}</AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <CardTitle className="truncate" title={follow.name}>
              {follow.name || "未知 UP 主"}
            </CardTitle>
            <CardDescription className="truncate">Bilibili · UID {follow.mid}</CardDescription>
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
                  disabled={removeDisabled}
                  className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  aria-label={`取消关注${follow.name}`}
                  onClick={() => onRemove(follow)}
                />
              }
            >
              {removing ? <Spinner aria-hidden /> : <Trash2 aria-hidden />}
            </TooltipTrigger>
            <TooltipContent>取消关注</TooltipContent>
          </Tooltip>
        </CardAction>
      </CardHeader>

      <CardContent className="pointer-events-none flex min-h-5 min-w-0 items-center gap-1.5 overflow-hidden">
        <Badge variant="secondary" className="bg-primary/10 text-primary">
          <Clapperboard aria-hidden />
          UP 主
        </Badge>
        {showGroup && (
          <Badge variant="outline" className="min-w-0 shrink" title={currentGroupName}>
            <FolderInput aria-hidden />
            <span className="truncate">{currentGroupName}</span>
          </Badge>
        )}
      </CardContent>
    </>
  );

  if (mobile) {
    return (
      <li className="min-w-0">
        <Card size="sm" className={cardClassName} onContextMenu={(event) => event.preventDefault()}>
          {cardBody}
        </Card>
        <FollowCardActionDrawer
          open={cardDrawer.open}
          onOpenChange={cardDrawer.setOpen}
          title={follow.name || "未知 UP 主"}
          actions={[
            {
              id: "open",
              icon: Clapperboard,
              label: "查看投稿视频",
              onSelect: () => onOpen(follow),
            },
          ]}
          groups={drawerGroups}
          moving={moveDisabled}
          onMoveGroup={(groupId) => onMove(follow, groupId)}
          destructive={{
            id: "remove",
            icon: UserRoundX,
            label: "取消关注",
            disabled: removeDisabled,
            busy: removing,
            destructive: true,
            onSelect: () => onRemove(follow),
          }}
        />
      </li>
    );
  }

  return (
    <li className="min-w-0">
      <ContextMenu>
        <ContextMenuTrigger render={<Card size="sm" className={cardClassName} />}>
          {cardBody}
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuGroup>
            <ContextMenuItem onClick={() => onOpen(follow)}>
              <Clapperboard aria-hidden />
              查看投稿视频
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
                      disabled={moveDisabled || currentGroupId === group.id}
                      onClick={() => onMove(follow, group.id)}
                    >
                      <Folder aria-hidden />
                      {group.name}
                      {currentGroupId === group.id && <Check aria-hidden />}
                    </ContextMenuItem>
                  ))}
                  <ContextMenuItem
                    disabled={moveDisabled || currentGroupId === UNGROUPED_VIDEO_FOLLOW_ID}
                    onClick={() => onMove(follow, UNGROUPED_VIDEO_FOLLOW_ID)}
                  >
                    <Inbox aria-hidden />
                    未分组
                    {currentGroupId === UNGROUPED_VIDEO_FOLLOW_ID && <Check aria-hidden />}
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
              onClick={() => onRemove(follow)}
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

function VideoFollowSkeleton() {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,17rem),1fr))] gap-2.5">
      {Array.from({ length: 8 }).map((_, index) => (
        <Card key={index} size="sm" className={cn("gap-2", CARD_SURFACE_CLASS)}>
          <CardHeader className="items-center gap-x-2.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <Skeleton className="size-10 shrink-0 rounded-full" />
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

export function VideoFollowView({
  follows,
  groups,
  selectedGroup,
  loading,
  error,
  onRetry,
  onGroupChange,
}: {
  follows: readonly VideoFollow[];
  groups: readonly VideoFollowGroup[];
  selectedGroup: string | null;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  onGroupChange: (groupId: string | null) => void;
}) {
  const navigate = useNavigate();
  const [pendingRemove, setPendingRemove] = useState<VideoFollow | null>(null);
  const [selectedUploader, setSelectedUploader] = useState<VideoFollow | null>(null);
  const [groupManagerOpen, setGroupManagerOpen] = useState(false);
  const removeMutation = useRemoveVideoFollowMutation();
  const moveMutation = useSetVideoFollowGroupMutation(groups);
  const busy = moveMutation.isPending || removeMutation.isPending;
  const cardActionsDisabled = busy || groupManagerOpen;

  const groupOptions = useMemo(() => videoFollowGroups(follows, groups), [follows, groups]);
  const groupCounts = useMemo(
    () => new Map(groupOptions.map((group) => [group.id, group.count])),
    [groupOptions],
  );
  const items = useMemo(
    () => follows.filter((follow) => videoFollowBelongsToGroup(follow, selectedGroup, groups)),
    [follows, groups, selectedGroup],
  );
  const selectedGroupName =
    selectedGroup === null
      ? "全部视频关注"
      : (groupOptions.find((group) => group.id === selectedGroup)?.name ?? "全部视频关注");

  const previousGroupRef = useRef(selectedGroup);
  const groupIds = useMemo(() => groupOptions.map((group) => group.id), [groupOptions]);
  const selectedGroupIndex = selectedGroup === null ? 0 : groupIds.indexOf(selectedGroup) + 1;
  const previousGroupIndex =
    // oxlint-disable-next-line react/refs
    previousGroupRef.current === null ? 0 : groupIds.indexOf(previousGroupRef.current) + 1;
  // 两个下标都至少为 0（全部 = 0、未知分组 = 0），只需比较先后。
  const groupDirection = selectedGroupIndex < previousGroupIndex ? -1 : 1;

  useEffect(() => {
    previousGroupRef.current = selectedGroup;
  }, [selectedGroup]);

  function moveFollow(follow: VideoFollow, groupId: string) {
    if (videoFollowGroupId(follow, groups) === groupId || cardActionsDisabled) return;
    moveMutation.mutate({
      follow,
      groupId: groupId === UNGROUPED_VIDEO_FOLLOW_ID ? null : groupId,
    });
  }

  if (error) {
    return <ErrorState error={error} title="视频关注加载失败" onRetry={onRetry} />;
  }

  return (
    <>
      <div className="grid min-w-0 items-start gap-4 md:grid-cols-[13rem_minmax(0,1fr)]">
        <nav
          aria-label="视频关注分组"
          className="sticky top-3 hidden max-h-[calc(100dvh-7rem)] min-w-0 flex-col gap-1 border-r border-border pr-3 md:flex"
        >
          <div className="mb-1 flex items-center justify-between gap-2 px-2">
            <span className="text-xs font-medium text-muted-foreground">视频关注分组</span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    disabled={busy}
                    aria-label="管理视频关注分组"
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
            <VideoGroupTarget
              group={null}
              total={follows.length}
              selected={selectedGroup === null}
              surface="desktop"
              onSelect={() => onGroupChange(null)}
            />
            {groupOptions.map((group) => (
              <VideoGroupTarget
                key={group.id}
                group={group}
                total={follows.length}
                selected={selectedGroup === group.id}
                surface="desktop"
                onSelect={() => onGroupChange(group.id)}
              />
            ))}
          </div>
        </nav>

        <section className="flex min-w-0 flex-col gap-3" aria-label={selectedGroupName}>
          <div
            data-horizontal-swipe-surface
            className="-mx-1 flex items-center gap-1 overflow-x-auto px-1 pb-1 md:hidden"
          >
            <VideoGroupTarget
              group={null}
              total={follows.length}
              selected={selectedGroup === null}
              surface="mobile"
              onSelect={() => onGroupChange(null)}
            />
            {groupOptions.map((group) => (
              <VideoGroupTarget
                key={group.id}
                group={group}
                total={follows.length}
                selected={selectedGroup === group.id}
                surface="mobile"
                onSelect={() => onGroupChange(group.id)}
              />
            ))}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              disabled={busy}
              aria-label="管理视频关注分组"
              onClick={() => setGroupManagerOpen(true)}
            >
              <FolderCog aria-hidden />
            </Button>
          </div>

          <PagePan
            panKey={selectedGroup === null ? "video-follow:all" : `video-follow:${selectedGroup}`}
            direction={groupDirection}
            className="h-auto min-h-64"
            contentClassName="h-auto min-h-64"
          >
            <div className="flex min-w-0 flex-col gap-3">
              {loading && <VideoFollowSkeleton />}

              {!loading && follows.length === 0 && (
                <Empty className="min-h-64 py-12">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Clapperboard aria-hidden />
                    </EmptyMedia>
                    <EmptyTitle>还没有关注 UP 主</EmptyTitle>
                    <EmptyDescription>在视频信息卡右侧点击关注后，会显示在这里。</EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    <Button variant="outline" size="sm" onClick={() => navigate("/video")}>
                      <Clapperboard data-icon="inline-start" aria-hidden />
                      浏览视频
                    </Button>
                  </EmptyContent>
                </Empty>
              )}

              {!loading && follows.length > 0 && items.length === 0 && (
                <Empty className="min-h-56 py-10">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Folder aria-hidden />
                    </EmptyMedia>
                    <EmptyTitle>当前分组没有 UP 主</EmptyTitle>
                    <EmptyDescription>可从其他分组的 UP 主卡片中调整归属。</EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    <Button variant="outline" size="sm" onClick={() => onGroupChange(null)}>
                      <Layers3 data-icon="inline-start" aria-hidden />
                      查看全部 UP 主
                    </Button>
                  </EmptyContent>
                </Empty>
              )}

              {items.length > 0 && (
                <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,17rem),1fr))] gap-2.5">
                  {items.map((follow) => {
                    const identity = videoFollowIdentity(follow);
                    return (
                      <VideoFollowCard
                        key={identity}
                        follow={follow}
                        groups={groups}
                        showGroup={selectedGroup === null}
                        moving={
                          moveMutation.isPending &&
                          videoFollowIdentity(moveMutation.variables.follow) === identity
                        }
                        moveDisabled={cardActionsDisabled}
                        removing={
                          removeMutation.isPending &&
                          videoFollowIdentity(removeMutation.variables) === identity
                        }
                        removeDisabled={cardActionsDisabled}
                        onOpen={setSelectedUploader}
                        onMove={moveFollow}
                        onRemove={setPendingRemove}
                      />
                    );
                  })}
                </ul>
              )}
            </div>
          </PagePan>
        </section>
      </div>

      {selectedUploader && (
        <UploaderDrawer
          open
          onOpenChange={(open) => {
            if (!open) setSelectedUploader(null);
          }}
          mid={selectedUploader.mid}
          uploaderName={selectedUploader.name}
        />
      )}

      <VideoFollowGroupManagerDialog
        open={groupManagerOpen}
        groups={groups}
        counts={groupCounts}
        onOpenChange={setGroupManagerOpen}
      />

      <ConfirmDialog
        open={pendingRemove != null}
        onOpenChange={(open) => {
          if (removeMutation.isPending) return;
          if (!open) setPendingRemove(null);
        }}
        icon={<Heart aria-hidden />}
        title="取消关注 UP 主"
        description={<>确定不再关注 {pendingRemove?.name} 吗？取消后将不再显示在视频关注列表中。</>}
        disabled={removeMutation.isPending}
        busy={removeMutation.isPending}
        actionIcon={<UserRoundX data-icon="inline-start" aria-hidden />}
        confirmText="取消关注"
        onConfirm={() => {
          if (!pendingRemove) return;
          removeMutation.mutate(pendingRemove, {
            onSuccess: () => setPendingRemove(null),
          });
        }}
      />
    </>
  );
}
