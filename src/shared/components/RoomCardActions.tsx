import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Copy,
  ExternalLink,
  Hash,
  PanelsTopLeft,
  Star,
  StarOff,
  type LucideIcon,
} from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import { copyText } from "@/shared/clipboard";
import type { FollowUser, LiveRoomDetail, LiveRoomItem, SiteId } from "@/shared/types/live";
import {
  fetchCachedFollows,
  prefetchRoomDetail,
  reconcileFollowList,
  userFromRoomDetail,
  useCachedFollows,
} from "@/features/follow/followRefresh";
import { FollowGroupPickerDialog } from "@/features/follow/FollowGroupPickerDialog";
import { tagIdsForFollowGroup } from "@/features/follow/followGroups";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { notify } from "@/components/ui/toast";
import { Spinner } from "@/components/ui/spinner";
import { useMultiRoomStore } from "@/features/multi-room/multiRoomStore";

export type RoomCardMenuPoint = { x: number; y: number };

type RoomCardActionsProps = {
  room: LiveRoomItem;
  mobile: boolean;
  open: boolean;
  point: RoomCardMenuPoint | null;
  cardRef: RefObject<HTMLButtonElement | null>;
  onOpenChange: (open: boolean) => void;
  onFinished: () => void;
};

function isSameFollow(
  user: Pick<FollowUser, "site_id" | "room_id">,
  siteId: SiteId,
  roomId: string,
): boolean {
  return user.site_id === siteId && user.room_id === roomId;
}

/** 菜单操作时才挂载，关闭动画与进行中的关注/分组流程结束后释放。 */
export function RoomCardActions({
  room,
  mobile,
  open,
  point,
  cardRef,
  onOpenChange,
  onFinished,
}: RoomCardActionsProps) {
  const queryClient = useQueryClient();
  const [pendingFollowUser, setPendingFollowUser] = useState<FollowUser | null>(null);
  const [followBusy, setFollowBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [closed, setClosed] = useState(false);
  const followBusyRef = useRef(false);
  const pendingUserRef = useRef<FollowUser | null>(null);
  const follows = useCachedFollows(queryClient);
  const isFollowed = follows.some((follow) => isSameFollow(follow, room.site_id, room.room_id));
  const anchor = useMemo(
    () =>
      point
        ? {
            getBoundingClientRect: () => new DOMRect(point.x, point.y, 0, 0),
          }
        : undefined,
    [point],
  );

  if (open && closed) setClosed(false);

  useEffect(() => {
    if (!open) return;
    void prefetchRoomDetail(queryClient, room.site_id, room.room_id).catch(() => undefined);
    void fetchCachedFollows(queryClient).catch(() => undefined);
  }, [open, queryClient, room.room_id, room.site_id]);

  useEffect(() => {
    if (closed && !open && !followBusy && pendingFollowUser === null) onFinished();
  }, [closed, open, followBusy, pendingFollowUser, onFinished]);

  function getRoomDetail(): Promise<LiveRoomDetail> {
    return prefetchRoomDetail(queryClient, room.site_id, room.room_id);
  }

  async function startFollow() {
    if (followBusyRef.current) return;
    followBusyRef.current = true;
    setFollowBusy(true);
    try {
      const [detail, follows] = await Promise.all([
        getRoomDetail(),
        fetchCachedFollows(queryClient),
      ]);
      const existing = follows.find((follow) =>
        isSameFollow(follow, detail.site_id, detail.room_id),
      );
      if (existing) {
        await invokeCmd("follow_remove", {
          siteId: detail.site_id,
          roomId: detail.room_id,
        });
        reconcileFollowList(queryClient, "unfollowed", existing);
        notify.success("已取消关注");
      } else {
        const user = userFromRoomDetail(detail, []);
        pendingUserRef.current = user;
        setPendingFollowUser(user);
        setPickerOpen(true);
      }
      onOpenChange(false);
    } catch {
      notify.error("关注操作失败", "请检查网络后重试。");
      onOpenChange(false);
    } finally {
      followBusyRef.current = false;
      setFollowBusy(false);
    }
  }

  /** 分组弹层确认时复用首次点击已经取得的房间详情，只提交一次写入。 */
  async function confirmFollowGroup(groupId: string) {
    const user = pendingUserRef.current;
    if (!user || followBusyRef.current) return;
    const selectedUser: FollowUser = {
      ...user,
      tag_ids: tagIdsForFollowGroup(groupId),
    };
    followBusyRef.current = true;
    setFollowBusy(true);
    try {
      await invokeCmd("follow_add", { user: selectedUser });
      reconcileFollowList(queryClient, "followed", selectedUser, selectedUser);
      pendingUserRef.current = null;
      setPickerOpen(false);
      notify.success("已关注主播");
    } catch {
      notify.error("关注操作失败", "请检查网络后重试。");
    } finally {
      followBusyRef.current = false;
      setFollowBusy(false);
    }
  }

  const picker =
    pendingFollowUser != null ? (
      <FollowGroupPickerDialog
        open={pickerOpen}
        subjectName={pendingFollowUser.user_name}
        pending={followBusy}
        onOpenChange={setPickerOpen}
        onOpenChangeComplete={(open) => {
          if (!open) {
            pendingUserRef.current = null;
            setPendingFollowUser(null);
          }
        }}
        onConfirm={(groupId) => confirmFollowGroup(groupId)}
      />
    ) : null;

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
    <>
      {mobile ? (
        <Drawer
          open={open}
          onOpenChange={onOpenChange}
          onOpenChangeComplete={(nextOpen) => setClosed(!nextOpen)}
        >
          <DrawerContent>
            <DrawerTitle className="truncate">
              {room.title || room.user_name || "直播间"}
            </DrawerTitle>
            <div className="mt-2 grid grid-cols-4 gap-1.5 max-md:gap-2">
              <RoomCardActionTile
                icon={Copy}
                label="复制链接"
                onClick={() => {
                  onOpenChange(false);
                  void copyRoomLink();
                }}
              />
              <RoomCardActionTile
                icon={Hash}
                label="复制房间号"
                onClick={() => {
                  onOpenChange(false);
                  void copyRoomId();
                }}
              />
              <RoomCardActionTile
                icon={followBusy ? undefined : isFollowed ? StarOff : Star}
                label={isFollowed ? "取消关注" : "关注主播"}
                busy={followBusy}
                disabled={followBusy}
                onClick={() => {
                  // 保持抽屉可见直到提交结束或让位给分组选择对话框。
                  void startFollow();
                }}
              />
              <RoomCardActionTile
                icon={ExternalLink}
                label="浏览器打开"
                onClick={() => {
                  onOpenChange(false);
                  void openInBrowser();
                }}
              />
            </div>
          </DrawerContent>
        </Drawer>
      ) : (
        <ContextMenu
          open={open}
          onOpenChange={onOpenChange}
          onOpenChangeComplete={(nextOpen) => setClosed(!nextOpen)}
        >
          <ContextMenuContent className="min-w-48" anchor={anchor} finalFocus={cardRef}>
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
                disabled={followBusy}
                closeOnClick={false}
                onClick={() => void startFollow()}
              >
                {followBusy ? (
                  <Spinner aria-hidden />
                ) : isFollowed ? (
                  <StarOff aria-hidden />
                ) : (
                  <Star aria-hidden />
                )}
                {followBusy ? "正在处理…" : isFollowed ? "取消关注" : "关注主播"}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => void openInBrowser()}>
                <ExternalLink aria-hidden />
                在浏览器中打开
              </ContextMenuItem>
            </ContextMenuGroup>
          </ContextMenuContent>
        </ContextMenu>
      )}
      {picker}
    </>
  );
}

/** 移动端长按操作抽屉里的动作磁贴，画法对齐全屏 HUD 的房间操作磁贴。 */
function RoomCardActionTile({
  icon: Icon,
  label,
  busy,
  disabled,
  onClick,
}: {
  icon?: LucideIcon;
  label: string;
  busy?: boolean;
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
      {busy ? (
        <Spinner className="size-5" aria-hidden />
      ) : (
        Icon && <Icon className="size-5" aria-hidden />
      )}
      <span className="max-w-full truncate">{busy ? "正在处理…" : label}</span>
    </Button>
  );
}
