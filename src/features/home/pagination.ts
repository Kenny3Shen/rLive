import type { LiveRoomItem, RoomListPage } from "@/shared/types/live";

function roomKey(room: LiveRoomItem) {
  return `${room.site_id}:${room.room_id}`;
}

/** 防止不断变化的推荐信息流把同一个房间渲染多次。 */
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
 * 当上游推荐页没有包含任何新房间时停止翻页。部分信息流以非空响应而非稳定游标
 * 来报告 `has_more`，这样可以防止自动滚动反复抓取同一页。
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
