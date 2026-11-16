import type { RoomListPage } from "@/shared/types/live";

export type RoomCoverSnapshot = RoomListPage & { coverRevision: string };

let snapshotSequence = 0;

/** 版本随查询结果保留在 Query 缓存中，只在真正获取新一页时生成。 */
export function roomCoverSnapshot(page: RoomListPage): RoomCoverSnapshot {
  return { ...page, coverRevision: `${Date.now()}-${++snapshotSequence}` };
}

export function roomCoverVersions(pages: readonly RoomListPage[] | undefined): Map<string, string> {
  const versions = new Map<string, string>();
  for (const page of pages ?? []) {
    const revision = (page as Partial<RoomCoverSnapshot>).coverRevision;
    if (!revision) continue;
    for (const room of page.items) {
      const key = `${room.site_id}:${room.room_id}`;
      if (!versions.has(key)) versions.set(key, revision);
    }
  }
  return versions;
}
