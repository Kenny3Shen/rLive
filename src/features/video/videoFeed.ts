import type { VideoListPage } from "@/shared/types/video";

/** APP 推荐无游标；整批均已加载时停止自动补货，刷新仍可重新请求。 */
export function nextRecommendPage(pages: readonly VideoListPage[]): number | undefined {
  const last = pages.at(-1);
  if (!last?.has_more || last.items.length === 0) return undefined;
  const key = (item: VideoListPage["items"][number]) => `${item.bvid}:${item.cid ?? ""}`;
  const seen = new Set(pages.slice(0, -1).flatMap((page) => page.items.map(key)));
  return last.items.some((item) => !seen.has(key(item))) ? pages.length + 1 : undefined;
}
