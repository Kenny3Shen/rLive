import { useMemo } from "react";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { videoBlockedUploaderSet } from "./videoUploaderBlock";

/**
 * 订阅 UP 主屏蔽名单，并把它收敛成一个**引用稳定**的集合。
 *
 * 集合必须按名单数组记忆化：每次渲染新建一个 `Set` 会让下游所有以它为依赖的
 * `useMemo`（列表去重、播放列表快照、竖屏流合并）全部失效，列表一长就是白算。
 * 名单为空时返回 `null`，调用方据此整条跳过过滤。
 */
export function useVideoBlockedUploaders(): ReadonlySet<string> | null {
  const uploaders = useSettingsStore((state) => state.videoBlockedUploaders);
  return useMemo(() => videoBlockedUploaderSet(uploaders), [uploaders]);
}
