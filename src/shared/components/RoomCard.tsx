import { memo, useState, type ComponentProps } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Copy,
  ExternalLink,
  Flame,
  Hash,
  PanelsTopLeft,
  Star,
  StarOff,
  type LucideIcon,
} from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import { isMobileClient } from "@/shared/clientPlatform";
import { copyText } from "@/shared/clipboard";
import type { FollowUser, LiveRoomDetail, LiveRoomItem } from "@/shared/types/live";
import { FOLLOW_LIST_QUERY_KEY } from "@/features/follow/followRefresh";
import { FollowGroupPickerDialog } from "@/features/follow/FollowGroupPickerDialog";
import { tagIdsForFollowGroup } from "@/features/follow/followGroups";
import { useRoomCardPreview } from "@/features/room/player/useRoomCardPreview";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { notify } from "@/components/ui/toast";
import { Spinner } from "@/components/ui/spinner";
import { preloadRouteModule } from "@/app/routeModules";
import { useMultiRoomStore } from "@/features/multi-room/multiRoomStore";
import { useLongPressDrawer } from "@/shared/hooks/useLongPressDrawer";
import { formatOnline, normalizeCoverUrl, cn } from "@/lib/utils";
import { roomCardLabels } from "./roomCardLabels";

type RoomCardProps = {
  room: LiveRoomItem;
};

export const RoomCard = memo(function RoomCard({ room }: RoomCardProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const roomPath = `/room/${room.site_id}/${encodeURIComponent(room.room_id)}`;
  const normalizedCover = normalizeCoverUrl(room.cover);
  const [pendingFollowUser, setPendingFollowUser] = useState<FollowUser | null>(null);
  // 移动端长按卡片改为弹出底部操作抽屉（与直播页清晰度/更多操作抽屉同构），
  // 桌面端继续使用右键菜单。
  const mobile = isMobileClient();
  const cardDrawer = useLongPressDrawer({ enabled: mobile });
  const { offline, primaryText, secondaryText, showOnline } = roomCardLabels(room);
  const {
    mountRef: previewMountRef,
    phase: previewPhase,
    onPointerEnter: onPreviewPointerEnter,
    stop: stopPreview,
  } = useRoomCardPreview({ siteId: room.site_id, roomId: room.room_id });
  const followsQuery = useQuery({
    queryKey: FOLLOW_LIST_QUERY_KEY,
    queryFn: () => invokeCmd<FollowUser[]>("follow_list"),
    staleTime: 15_000,
  });
  const isFollowed = Boolean(
    followsQuery.data?.some(
      (follow) => follow.site_id === room.site_id && follow.room_id === room.room_id,
    ),
  );

  async function getRoomDetail(): Promise<LiveRoomDetail> {
    return queryClient.fetchQuery({
      queryKey: ["room_detail", room.site_id, room.room_id],
      queryFn: () =>
        invokeCmd<LiveRoomDetail>("site_get_room_detail", {
          siteId: room.site_id,
          roomId: room.room_id,
        }),
      staleTime: 60_000,
    });
  }

  const followMutation = useMutation({
    mutationFn: async (groupId: string | null) => {
      const [detail, follows] = await Promise.all([
        getRoomDetail(),
        followsQuery.data
          ? Promise.resolve(followsQuery.data)
          : queryClient.fetchQuery({
              queryKey: FOLLOW_LIST_QUERY_KEY,
              queryFn: () => invokeCmd<FollowUser[]>("follow_list"),
              staleTime: 15_000,
            }),
      ]);
      const existing = follows.find(
        (follow) => follow.site_id === detail.site_id && follow.room_id === detail.room_id,
      );

      if (existing) {
        if (groupId != null) {
          await invokeCmd("follow_set_tags", {
            siteId: detail.site_id,
            roomId: detail.room_id,
            tagIds: tagIdsForFollowGroup(groupId),
          });
          return { action: "followed" as const };
        }
        await invokeCmd("follow_remove", {
          siteId: detail.site_id,
          roomId: detail.room_id,
        });
        return { action: "unfollowed" as const };
      }

      const user: FollowUser = {
        site_id: detail.site_id,
        room_id: detail.room_id,
        user_name: detail.user_name,
        face: detail.user_avatar,
        tag_ids: groupId == null ? [] : tagIdsForFollowGroup(groupId),
        auto_record: false,
        live_status: detail.status,
        live_started_at: detail.status ? (detail.live_started_at ?? null) : null,
        updated_at: Date.now(),
      };
      if (groupId == null) return { action: "choose-group" as const, user };

      await invokeCmd("follow_add", { user });
      return { action: "followed" as const };
    },
    onSuccess: (result) => {
      if (result.action === "choose-group") {
        setPendingFollowUser(result.user);
        return;
      }
      void queryClient.invalidateQueries({ queryKey: FOLLOW_LIST_QUERY_KEY });
      if (result.action === "followed") setPendingFollowUser(null);
      notify.success(result.action === "followed" ? "已关注主播" : "已取消关注");
    },
    onError: () => {
      notify.error("关注操作失败", "请检查网络后重试。");
    },
  });

  function openRoom() {
    // 长按弹出操作抽屉后，松手合成的点按属于菜单手势的一部分，不进入房间。
    if (cardDrawer.consumeSyntheticClick()) return;
    // 导航会卸载卡片,但先停预览可以避免与房间播放器抢同一条本机代理会话。
    stopPreview();
    navigate(roomPath);
  }

  async function copyRoomId() {
    if (await copyText(room.room_id)) {
      notify.success("已复制房间号");
    } else {
      notify.error("复制房间号失败", "请手动选择并复制。");
    }
  }

  async function copyRoomLink() {
    try {
      const detail = await getRoomDetail();
      if (await copyText(detail.url)) {
        notify.success("已复制房间链接");
      } else {
        notify.error("复制房间链接失败", "请手动选择并复制。");
      }
    } catch {
      notify.error("获取房间链接失败", "请稍后重试。");
    }
  }

  async function openInBrowser() {
    try {
      const detail = await getRoomDetail();
      try {
        await openUrl(detail.url);
      } catch {
        const opened = window.open(detail.url, "_blank", "noopener,noreferrer");
        if (!opened) throw new Error("browser_open_failed");
      }
      notify.success("已在浏览器中打开");
    } catch {
      notify.error("无法在浏览器中打开", "请稍后重试。");
    }
  }

  function addToMultiRoom() {
    const result = useMultiRoomStore.getState().addRoom(room);
    if (result === "added") notify.success("已加入多画面");
    else if (result === "exists") notify.info("该直播间已在多画面中");
    else {
      const { layout } = useMultiRoomStore.getState();
      notify.error("多画面已满", `当前布局最多同时添加 ${layout} 个直播间。`);
    }
  }

  const cardBody = (
    <>
      <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-muted shadow-md shadow-black/30 ring-1 ring-border-subtle">
        {normalizedCover ? (
          <img
            src={normalizedCover}
            alt=""
            loading="lazy"
            decoding="async"
            className="motion-room-cover h-full w-full object-cover transition-transform duration-200 ease-[var(--motion-ease-out)] motion-reduced:transition-none"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
            暂无封面
          </div>
        )}
        {/* 预览盖在封面之上、渐变与热度角标之下。挂载点不接收指针事件,
              悬停与点击始终落在卡片按钮上。 */}
        <div ref={previewMountRef} aria-hidden className="pointer-events-none absolute inset-0" />
        {previewPhase === "loading" && (
          <span className="pointer-events-none absolute left-2 top-2 inline-flex rounded-md bg-black/65 p-1 text-white backdrop-blur-sm">
            <Spinner className="size-3" />
          </span>
        )}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/55 via-transparent to-transparent opacity-80" />
        {/* 未开播时热度没有意义（多数平台干脆不返回），角标改说开播状态。 */}
        {offline ? (
          <span
            data-mobile-static-backdrop
            className="absolute bottom-2 right-2 inline-flex items-center rounded-md bg-black/65 px-1.5 py-0.5 text-[11px] font-medium text-white/85 backdrop-blur-sm"
          >
            未开播
          </span>
        ) : (
          showOnline && (
            <span
              data-mobile-static-backdrop
              className="absolute bottom-2 right-2 inline-flex items-center gap-0.5 rounded-md bg-black/65 px-1.5 py-0.5 text-[11px] font-medium text-white backdrop-blur-sm"
            >
              <Flame className="size-3 text-orange-400" aria-hidden />
              {formatOnline(room.online)}
            </span>
          )
        )}
      </div>
      <div className="flex flex-1 flex-col gap-0.5 px-0.5 pt-2.5 pb-1">
        <p className="line-clamp-1 text-[13px] font-medium leading-snug text-foreground">
          {primaryText}
        </p>
        {/* 副行始终占位，保证网格里在播与未开播卡片的高度一致。 */}
        <p className="min-h-4 truncate text-xs text-muted-foreground">{secondaryText}</p>
      </div>
    </>
  );

  const cardButtonProps: ComponentProps<"button"> = {
    type: "button",
    onClick: openRoom,
    onPointerEnter: (event) => {
      preloadRouteModule(roomPath);
      // 未开播的房间取不到流，预览只会白跑一轮 detail/qualities 请求。
      if (!offline) onPreviewPointerEnter(event);
    },
    onPointerLeave: stopPreview,
    onPointerDown: (event) => {
      cardDrawer.onPointerDown(event);
      preloadRouteModule(roomPath);
    },
    onPointerMove: cardDrawer.onPointerMove,
    onPointerUp: cardDrawer.onPointerUp,
    onPointerCancel: cardDrawer.onPointerCancel,
    onContextMenu: cardDrawer.onContextMenu,
    onFocus: () => preloadRouteModule(roomPath),
    className: cn(
      "room-card group flex w-full flex-col overflow-hidden rounded-xl bg-transparent text-left focus-ring",
    ),
  };

  if (mobile) {
    return (
      <>
        <button
          {...cardButtonProps}
          data-motion-press
          data-page-scroll-anchor={`${room.site_id}:${room.room_id}`}
        >
          {cardBody}
        </button>

        {/* 长按弹出的底部操作抽屉，磁贴画法对齐全屏 HUD 的「更多房间操作」。 */}
        <Drawer open={cardDrawer.open} onOpenChange={cardDrawer.setOpen}>
          <DrawerContent>
            <DrawerTitle className="truncate">
              {room.title || room.user_name || "直播间"}
            </DrawerTitle>
            <div className="mt-2 grid grid-cols-4 gap-1.5 max-md:gap-2">
              <RoomCardActionTile
                icon={Copy}
                label="复制链接"
                onClick={() => {
                  cardDrawer.setOpen(false);
                  void copyRoomLink();
                }}
              />
              <RoomCardActionTile
                icon={Hash}
                label="复制房间号"
                onClick={() => {
                  cardDrawer.setOpen(false);
                  void copyRoomId();
                }}
              />
              <RoomCardActionTile
                icon={isFollowed ? StarOff : Star}
                label={isFollowed ? "取消关注" : "关注主播"}
                disabled={followMutation.isPending || followsQuery.isLoading}
                onClick={() => {
                  // 先收抽屉，为可能弹出的分组选择对话框让路。
                  cardDrawer.setOpen(false);
                  followMutation.mutate(null);
                }}
              />
              <RoomCardActionTile
                icon={ExternalLink}
                label="浏览器打开"
                onClick={() => {
                  cardDrawer.setOpen(false);
                  void openInBrowser();
                }}
              />
            </div>
          </DrawerContent>
        </Drawer>

        <FollowGroupPickerDialog
          open={pendingFollowUser != null}
          subjectName={pendingFollowUser?.user_name ?? room.user_name}
          pending={followMutation.isPending && followMutation.variables != null}
          onOpenChange={(open) => {
            if (!open) setPendingFollowUser(null);
          }}
          onConfirm={(groupId) => followMutation.mutateAsync(groupId).then(() => undefined)}
        />
      </>
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <button
            {...cardButtonProps}
            data-motion-press
            data-page-scroll-anchor={`${room.site_id}:${room.room_id}`}
          />
        }
      >
        {cardBody}
      </ContextMenuTrigger>

      <ContextMenuContent className="min-w-48">
        <ContextMenuGroup>
          <ContextMenuLabel>{room.title || room.user_name || "直播间"}</ContextMenuLabel>
          <ContextMenuItem onClick={() => void copyRoomLink()}>
            <Copy aria-hidden />
            复制房间链接
          </ContextMenuItem>
          <ContextMenuItem onClick={() => void copyRoomId()}>
            <Hash aria-hidden />
            复制房间号
          </ContextMenuItem>
          {/* 多视图仅限桌面（见 MultiRoomPage）；移动端长按走底部操作抽屉，
              抽屉刻意不提供该项，避免把房间加进客户端打不开的表面。 */}
          <ContextMenuItem onClick={addToMultiRoom}>
            <PanelsTopLeft aria-hidden />
            加入多画面
          </ContextMenuItem>
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuGroup>
          <ContextMenuItem
            disabled={followMutation.isPending || followsQuery.isLoading}
            onClick={() => followMutation.mutate(null)}
          >
            {isFollowed ? <StarOff aria-hidden /> : <Star aria-hidden />}
            {isFollowed ? "取消关注" : "关注主播"}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => void openInBrowser()}>
            <ExternalLink aria-hidden />
            在浏览器中打开
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>

      <FollowGroupPickerDialog
        open={pendingFollowUser != null}
        subjectName={pendingFollowUser?.user_name ?? room.user_name}
        pending={followMutation.isPending && followMutation.variables != null}
        onOpenChange={(open) => {
          if (!open) setPendingFollowUser(null);
        }}
        onConfirm={(groupId) => followMutation.mutateAsync(groupId).then(() => undefined)}
      />
    </ContextMenu>
  );
});

/** 移动端长按操作抽屉里的动作磁贴，画法对齐全屏 HUD 的房间操作磁贴。 */
function RoomCardActionTile({
  icon: Icon,
  label,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      disabled={disabled}
      className="h-auto min-w-0 flex-col gap-1.5 py-2.5 text-xs font-normal touch-manipulation max-md:py-3"
      onClick={onClick}
    >
      <Icon className="size-5" aria-hidden />
      <span className="max-w-full truncate">{label}</span>
    </Button>
  );
}
