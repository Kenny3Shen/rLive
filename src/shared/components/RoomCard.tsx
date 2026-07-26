import { memo } from "react";
import { useNavigate } from "react-router-dom";
import { Flame } from "lucide-react";
import type { LiveRoomItem } from "@/shared/types/live";
import { formatOnline, cn } from "@/lib/utils";

type RoomCardProps = {
  room: LiveRoomItem;
};

export const RoomCard = memo(function RoomCard({ room }: RoomCardProps) {
  const navigate = useNavigate();

  function openRoom() {
    navigate(`/room/${room.site_id}/${encodeURIComponent(room.room_id)}`);
  }

  return (
    <button
      type="button"
      onClick={openRoom}
      className={cn(
        "room-card group flex w-full flex-col overflow-hidden rounded-xl bg-transparent text-left transition-transform focus-ring",
        "hover:-translate-y-0.5",
      )}
    >
      <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-muted shadow-md shadow-black/30 ring-1 ring-border-subtle">
        {room.cover ? (
          <img
            src={room.cover}
            alt=""
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.04]"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
            暂无封面
          </div>
        )}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/55 via-transparent to-transparent opacity-80" />
        <span className="absolute bottom-2 right-2 inline-flex items-center gap-0.5 rounded-md bg-black/65 px-1.5 py-0.5 text-[11px] font-medium text-white backdrop-blur-sm">
          <Flame className="h-3 w-3 text-orange-400" aria-hidden />
          {formatOnline(room.online)}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-0.5 px-0.5 pt-2.5 pb-1">
        <p className="line-clamp-1 text-[13px] font-medium leading-snug text-foreground">
          {room.title || "未命名直播间"}
        </p>
        <p className="truncate text-xs text-muted-foreground">{room.user_name || "未知主播"}</p>
      </div>
    </button>
  );
});
