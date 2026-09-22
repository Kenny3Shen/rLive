import type { DouyinVideoFeedPage, DouyinVideoItem } from "./douyinVideoApi";

/** 实验阶段限制单轮常驻元数据；达到上限后用户显式刷新，不在后台无限拉取。 */
export const DOUYIN_FEED_MAX_BATCHES = 20;

export function mergeDouyinFeed(pages: readonly DouyinVideoFeedPage[]): DouyinVideoItem[] {
  const seen = new Set<string>();
  return pages
    .flatMap((page) => page.items)
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
}

export function nextDouyinFeedBatch(
  lastPage: DouyinVideoFeedPage,
  pages: readonly DouyinVideoFeedPage[],
): number | undefined {
  if (!lastPage.has_more || pages.length >= DOUYIN_FEED_MAX_BATCHES) return undefined;
  const previousIds = new Set(
    pages.slice(0, -1).flatMap((page) => page.items.map((item) => item.id)),
  );
  return lastPage.items.some((item) => !previousIds.has(item.id)) ? pages.length + 1 : undefined;
}
