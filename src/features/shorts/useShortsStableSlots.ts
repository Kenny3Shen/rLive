import { useMemo, useState } from "react";
import type { VideoItem } from "@/shared/types/video";
import { shortsItemKey } from "./shortsFeed";
import { shortsStableSlotPadding, shortsUnpadSlots } from "./shortsUploaderFeed";
import { useShortsSlots, type UseShortsSlotsOptions } from "./useShortsSlots";

/** 仅适配下标，不另建播放器；切模式和前插仍复用原来的三槽媒体元素。 */
export function useShortsStableSlots(options: UseShortsSlotsOptions) {
  const { items, index } = options;
  const key = items[index] ? shortsItemKey(items[index]) : "";
  const [anchor, setAnchor] = useState({ key, index, padding: 0 });
  const padding =
    key && key === anchor.key
      ? shortsStableSlotPadding(anchor.index, anchor.padding, index)
      : anchor.padding;
  if (key !== anchor.key || index !== anchor.index) setAnchor({ key, index, padding });

  const paddedItems = useMemo(() => {
    // 空前缀只供现有槽位查询；其越界邻居读到 undefined，与列表首尾一致。
    const padded: VideoItem[] = [];
    padded.length = padding + items.length;
    items.forEach((item, itemIndex) => {
      padded[itemIndex + padding] = item;
    });
    return padded;
  }, [items, padding]);
  const state = useShortsSlots({ ...options, items: paddedItems, index: index + padding });
  return { ...state, slots: shortsUnpadSlots(state.slots, padding) };
}
