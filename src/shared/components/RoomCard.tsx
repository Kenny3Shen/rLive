import { memo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Copy, ExternalLink, Flame, Hash, PanelsTopLeft, Star, StarOff } from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import { isMobileClient } from "@/shared/clientPlatform";
import { copyText } from "@/shared/clipboard";
import type { FollowUser, LiveRoomDetail, LiveRoomItem } from "@/shared/types/live";
import { FOLLOW_LIST_QUERY_KEY } from "@/features/follow/followRefresh";
import { FollowGroupPickerDialog } from "@/features/follow/FollowGroupPickerDialog";
import { tagIdsForFollowGroup } from "@/features/follow/followGroups";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { notify } from "@/components/ui/toast";
import { preloadRouteModule } from "@/app/routeModules";
import { useMultiRoomStore } from "@/features/multi-room/multiRoomStore";
import { formatOnline, normalizeCoverUrl, cn } from "@/lib/utils";

type RoomCardProps = {
  room: LiveRoomItem;
};

export const RoomCard = memo(function RoomCard({ room }: RoomCardProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const roomPath = `/room/${room.site_id}/${encodeURIComponent(room.room_id)}`;
  const normalizedCover = normalizeCoverUrl(room.cover);
  const [pendingFollowUser, setPendingFollowUser] = useState<FollowUser | null>(null);
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

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <button
            type="button"
            data-motion-press
            data-page-scroll-anchor={`${room.site_id}:${room.room_id}`}
            onClick={openRoom}
            onPointerEnter={() => preloadRouteModule(roomPath)}
            onPointerDown={() => preloadRouteModule(roomPath)}
            onFocus={() => preloadRouteModule(roomPath)}
            className={cn(
              "room-card group flex w-full flex-col overflow-hidden rounded-xl bg-transparent text-left focus-ring",
            )}
          />
        }
      >
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
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/55 via-transparent to-transparent opacity-80" />
          <span
            data-mobile-static-backdrop
            className="absolute bottom-2 right-2 inline-flex items-center gap-0.5 rounded-md bg-black/65 px-1.5 py-0.5 text-[11px] font-medium text-white backdrop-blur-sm"
          >
            <Flame className="size-3 text-orange-400" aria-hidden />
            {formatOnline(room.online)}
          </span>
        </div>
        <div className="flex flex-1 flex-col gap-0.5 px-0.5 pt-2.5 pb-1">
          <p className="line-clamp-1 text-[13px] font-medium leading-snug text-foreground">
            {room.title || "未命名直播间"}
          </p>
          <p className="truncate text-xs text-muted-foreground">{room.user_name || "未知主播"}</p>
        </div>
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
          {/* 多视图仅限桌面（见 MultiRoomPage），触摸设备上长按是进入此菜单的唯一方式。
              在那里提供该项会把房间加进客户端打不开的表面。 */}
          {!isMobileClient() && (
            <ContextMenuItem onClick={addToMultiRoom}>
              <PanelsTopLeft aria-hidden />
              加入多画面
            </ContextMenuItem>
          )}
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
