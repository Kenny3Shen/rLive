import type { LiveRoomItem, RoomListPage } from "@/shared/types/live";

function roomKey(room: LiveRoomItem) {
  return `${room.site_id}:${room.room_id}`;
}

/** Keep a changing recommendation feed from rendering a room more than once. */
export function mergeRoomPages(pages: readonly RoomListPage[] | undefined): LiveRoomItem[] {
  if (!pages) return [];

  const seen = new Set<string>();
  const rooms: LiveRoomItem[] = [];
  for (const page of pages) {
    for (const room of page.items) {
      const key = roomKey(room);
      if (seen.has(key)) continue;
      seen.add(key);
      rooms.push(room);
    }
  }
  return rooms;
}

/**
 * Stop pagination if an upstream recommendation page contains no new rooms.
 * Some feeds report `has_more` from a non-empty response rather than a stable
 * cursor, so this prevents automatic scrolling from repeatedly fetching it.
 */
export function nextRecommendPage(
  lastPage: RoomListPage,
  pages: readonly RoomListPage[],
  lastPageParam: number,
): number | undefined {
  if (!lastPage.has_more) return undefined;

  const previousRoomKeys = new Set(
    pages
      .slice(0, -1)
      .flatMap((page) => page.items)
      .map(roomKey),
  );
  const addsNewRoom = lastPage.items.some((room) => !previousRoomKeys.has(roomKey(room)));
  return addsNewRoom ? lastPageParam + 1 : undefined;
}
