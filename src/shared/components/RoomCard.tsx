import { useNavigate } from "react-router-dom";
import type { LiveRoomItem } from "../types/live";

function formatOnline(n: number): string {
  if (n >= 10_000) {
    const w = n / 10_000;
    return `${w >= 10 ? Math.round(w) : w.toFixed(1).replace(/\.0$/, "")}万`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(n);
}

type RoomCardProps = {
  room: LiveRoomItem;
};

export function RoomCard({ room }: RoomCardProps) {
  const navigate = useNavigate();

  function openRoom() {
    navigate(`/room/${room.site_id}/${encodeURIComponent(room.room_id)}`);
  }

  return (
    <button
      type="button"
      onClick={openRoom}
      className="group flex w-full flex-col overflow-hidden rounded-lg border border-zinc-200 bg-white text-left shadow-sm transition hover:border-zinc-300 hover:shadow focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700 dark:focus-visible:outline-zinc-100"
    >
      <div className="relative aspect-video w-full overflow-hidden bg-zinc-100 dark:bg-zinc-800">
        {room.cover ? (
          <img
            src={room.cover}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition group-hover:scale-[1.02]"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-zinc-400">
            No cover
          </div>
        )}
        <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white">
          {formatOnline(room.online)}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-0.5 p-2.5">
        <p className="line-clamp-2 text-sm font-medium leading-snug text-zinc-900 dark:text-zinc-100">
          {room.title || "Untitled"}
        </p>
        <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
          {room.user_name || "Unknown"}
        </p>
      </div>
    </button>
  );
}
