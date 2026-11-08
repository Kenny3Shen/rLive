import { memo, useRef, useState, type ComponentProps } from "react";
import { useNavigate } from "react-router-dom";
import { Flame } from "lucide-react";
import { isMobileClient } from "@/shared/clientPlatform";
import type { LiveRoomItem } from "@/shared/types/live";
import { useRoomCardPreview } from "@/features/room/player/useRoomCardPreview";
import { Spinner } from "@/components/ui/spinner";
import { preloadRouteModule } from "@/app/routeModules";
import { useLongPressDrawer } from "@/shared/hooks/useLongPressDrawer";
import { CARD_SURFACE_CLASS, CARD_SURFACE_HOVER_CLASS } from "@/shared/components/cardSurface";
import { formatOnline, normalizeCoverUrl, cn } from "@/lib/utils";
import { roomCardLabels } from "./roomCardLabels";
import { RoomCardActions, type RoomCardMenuPoint } from "./RoomCardActions";

type RoomCardProps = { room: LiveRoomItem };

export const RoomCard = memo(function RoomCard({ room }: RoomCardProps) {
  const navigate = useNavigate();
  const roomPath = `/room/${room.site_id}/${encodeURIComponent(room.room_id)}`;
  const normalizedCover = normalizeCoverUrl(room.cover);
  const mobile = isMobileClient();
  const cardRef = useRef<HTMLButtonElement | null>(null);
  const cardDrawer = useLongPressDrawer({ enabled: mobile });
  const [menuSession, setMenuSession] = useState<{
    open: boolean;
    point: RoomCardMenuPoint | null;
  } | null>(null);
  // 长按 hook 提交打开状态时记住会话，抽屉关闭后仍保留到退出动画和关注流程结束。
  if (mobile && cardDrawer.open && menuSession === null)
    setMenuSession({ open: true, point: null });
  const actionsOpen = mobile ? cardDrawer.open : (menuSession?.open ?? false);
  const { offline, primaryText, secondaryText, showOnline } = roomCardLabels(room);
  const {
    mountRef: previewMountRef,
    phase: previewPhase,
    onPointerEnter: onPreviewPointerEnter,
    stop: stopPreview,
  } = useRoomCardPreview({ siteId: room.site_id, roomId: room.room_id });

  function openMenu(point: RoomCardMenuPoint | null) {
    stopPreview();
    const rect = cardRef.current?.getBoundingClientRect();
    setMenuSession({
      open: true,
      point: point ?? (rect ? { x: rect.left, y: rect.bottom } : { x: 0, y: 0 }),
    });
  }

  function openRoom() {
    if (cardDrawer.consumeSyntheticClick()) return;
    stopPreview();
    navigate(roomPath);
  }

  const cardBody = (
    <>
      {/* 封面满幅顶到卡片的上边与两侧：圆角与描边由卡片外壳给（见 cardButtonProps），
          封面自己不再带圆角/描边/投影，否则会在卡片边界内侧再画一圈，读成两层边框。 */}
      <div className="relative aspect-video w-full overflow-hidden bg-muted">
        {normalizedCover ? (
          <img
            src={normalizedCover}
            alt=""
            loading="lazy"
            decoding="sync"
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
      <div className="flex flex-1 flex-col gap-0.5 px-2 pt-2 pb-2.5">
        <p className="line-clamp-1 text-[13px] font-medium leading-snug text-foreground">
          {primaryText}
        </p>
        {/* 副行始终占位，保证网格里在播与未开播卡片的高度一致。 */}
        <p className="min-h-4 truncate text-xs text-muted-foreground">{secondaryText}</p>
      </div>
    </>
  );

  const cardButtonProps: ComponentProps<"button"> = {
    ref: cardRef,
    type: "button",
    "aria-haspopup": mobile ? "dialog" : "menu",
    "aria-expanded": actionsOpen,
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
    onContextMenu: (event) => {
      if (mobile) {
        cardDrawer.onContextMenu(event);
        return;
      }
      event.preventDefault();
      openMenu(
        event.clientX === 0 && event.clientY === 0 ? null : { x: event.clientX, y: event.clientY },
      );
    },
    onKeyDown: (event) => {
      if (mobile || (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")))
        return;
      event.preventDefault();
      openMenu(null);
    },
    onFocus: () => preloadRouteModule(roomPath),
    className: cn(
      // 卡片自带底色与细描边：网格里相邻卡片之间只有 12px 间隙，纯透明卡片的
      // 边界完全由封面撑出，标题与下一张封面之间读不出归属。
      //
      // 底色从封面自然向下延伸，而不是给封面套一层内边距：封面满幅占住卡片顶部，
      // 卡片的圆角与描边正好落在封面边缘上，读作封面自己的边界继续包住下面的文字。
      // 封面不参与内边距，因此这里不能加 padding —— 文字区自己带内边距。
      "room-card group select-none flex w-full flex-col overflow-hidden rounded-xl text-left",
      CARD_SURFACE_CLASS,
      CARD_SURFACE_HOVER_CLASS,
    ),
  };

  return (
    <>
      <button
        {...cardButtonProps}
        data-motion-press
        data-page-scroll-anchor={`${room.site_id}:${room.room_id}`}
        data-player-origin={`${room.site_id}:${room.room_id}`}
      >
        {cardBody}
      </button>
      {(menuSession !== null || cardDrawer.open) && (
        <RoomCardActions
          room={room}
          mobile={mobile}
          open={actionsOpen}
          point={menuSession?.point ?? null}
          cardRef={cardRef}
          onOpenChange={(open) => {
            if (mobile) cardDrawer.setOpen(open);
            else setMenuSession((current) => (current ? { ...current, open } : null));
          }}
          onFinished={() => {
            if (!actionsOpen) setMenuSession(null);
          }}
        />
      )}
    </>
  );
});
