import { useParams } from "react-router-dom";

export function RoomPage() {
  const { siteId, roomId } = useParams<{ siteId: string; roomId: string }>();

  return (
    <div>
      <h1 className="text-2xl font-semibold">Room</h1>
      <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
        {siteId}/{roomId}
      </p>
    </div>
  );
}
