import type { VideoDanmakuItem } from "@/shared/types/video";
import { mergeVideoDanmakuEntries, videoDanmakuEntries } from "./videoDanmaku";

/** 本机快照也可能被外部修改，先校验结构再交给共用时间轴映射。 */
export function parseDownloadedDanmaku(value: unknown) {
  if (!Array.isArray(value)) throw new Error("弹幕缓存格式无效");
  const indices = new Set<number>();
  return mergeVideoDanmakuEntries(
    value.map((segment: unknown) => {
      if (!segment || typeof segment !== "object") throw new Error("弹幕分段格式无效");
      const { segment_index: index, items } = segment as Record<string, unknown>;
      if (
        typeof index !== "number" ||
        !Number.isSafeInteger(index) ||
        index < 1 ||
        indices.has(index) ||
        !Array.isArray(items) ||
        items.some((item: unknown) => !item || typeof item !== "object")
      ) {
        throw new Error("弹幕分段格式无效");
      }
      indices.add(index);
      return videoDanmakuEntries(items as VideoDanmakuItem[], index);
    }),
  );
}
