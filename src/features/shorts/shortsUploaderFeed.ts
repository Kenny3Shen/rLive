import type {
  VideoItem,
  VideoUploaderStoryItem,
  VideoUploaderStoryPage,
} from "@/shared/types/video";
import { SHORTS_SLOT_COUNT, shortsItemKey, type ShortsSlots } from "./shortsFeed";

export type ShortsUploaderDirection = "next" | "prev";
export type ShortsUploaderPageParam = {
  direction: "initial" | ShortsUploaderDirection;
  cursor: string;
};

/** 只合并分页重叠项；UP 流不应用推荐去重、cid 或画幅过滤。 */
export function shortsUploaderItems(
  pages: readonly VideoUploaderStoryPage[],
): VideoUploaderStoryItem[] {
  const seen = new Set<string>();
  const items: VideoUploaderStoryItem[] = [];
  for (const page of pages) {
    for (const item of page.items) {
      if (seen.has(item.aid)) continue;
      seen.add(item.aid);
      items.push(item);
    }
  }
  return items;
}

/** initial 必须包含入口稿件，绝不以列表第一条作为静默回退。 */
export function shortsUploaderInitialIndex(items: readonly VideoItem[], aid: string): number {
  const index = items.findIndex((item) => item.aid === aid);
  if (index < 0) throw new Error("该稿件不在此 UP 主的 story 列表中，请返回推荐流。");
  return index;
}

/** 本地下标仅用于舞台定位，计数始终来自上游。 */
export function shortsUploaderCounter(
  item: VideoUploaderStoryItem | undefined,
  total: number,
): string | null {
  if (
    !item ||
    !Number.isInteger(item.index) ||
    item.index < 1 ||
    !Number.isInteger(total) ||
    total < item.index
  )
    return null;
  return `${item.index}/${total}`;
}

export function shortsUploaderCursor(
  page: VideoUploaderStoryPage | undefined,
  direction: ShortsUploaderDirection,
): string | undefined {
  return (direction === "next" ? page?.next_cursor : page?.prev_cursor) || undefined;
}

/** 接入前检查分页是否前进；失败交给显式重试，不让预取 effect 无限请求。 */
export function shortsValidateUploaderPage(
  page: VideoUploaderStoryPage,
  param: ShortsUploaderPageParam,
  previousPages: readonly VideoUploaderStoryPage[] = [],
  previousParams: readonly ShortsUploaderPageParam[] = [],
): VideoUploaderStoryPage {
  if (param.direction === "initial") {
    shortsUploaderInitialIndex(page.items, param.cursor);
    return page;
  }
  const cursor = shortsUploaderCursor(page, param.direction);
  const seen = new Set(previousPages.flatMap((previous) => previous.items.map((item) => item.aid)));
  const hasNewItem = page.items.some((item) => !seen.has(item.aid));
  if (
    cursor &&
    (cursor === param.cursor ||
      previousParams.some(
        (previous) => previous.direction === param.direction && previous.cursor === cursor,
      ) ||
      !hasNewItem)
  ) {
    throw new Error("UP 主列表分页未前进，请重试或返回推荐流。");
  }
  return page;
}

/** 列表重排时跟随视频身份；前插不会把当前视频挤走。 */
export function shortsAnchoredIndex(
  items: readonly VideoItem[],
  current: VideoItem | undefined,
  fallback: number,
): number {
  const found = current
    ? items.findIndex((item) => shortsItemKey(item) === shortsItemKey(current))
    : -1;
  return found >= 0 ? found : Math.max(0, Math.min(fallback, items.length - 1));
}

/**
 * 三槽位按下标取模分配。为内部数组保留 0~2 个空前缀，使同一视频重排后仍归原槽位。
 * 前缀只存在于槽位适配层，不进入可浏览列表、计数或手势坐标。
 */
export function shortsStableSlotPadding(
  previousIndex: number,
  previousPadding: number,
  index: number,
): number {
  return (
    (((previousIndex + previousPadding - index) % SHORTS_SLOT_COUNT) + SHORTS_SLOT_COUNT) %
    SHORTS_SLOT_COUNT
  );
}

export function shortsUnpadSlots(slots: ShortsSlots, padding: number): ShortsSlots {
  const unpad = (value: number | null) =>
    value == null || value < padding ? null : value - padding;
  return {
    active: slots.active,
    held: { a: unpad(slots.held.a), b: unpad(slots.held.b), c: unpad(slots.held.c) },
  };
}
