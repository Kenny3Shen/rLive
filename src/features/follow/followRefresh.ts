import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { invokeCmd } from "@/shared/api/tauri";
import type { FollowUser } from "@/shared/types/live";

export const FOLLOW_LIST_QUERY_KEY = ["follows"] as const;
const FOLLOW_REFRESH_QUERY_KEY = ["follows", "refresh"] as const;
export const FOLLOW_STATUS_REFRESH_INTERVAL_MS = 60_000;

let lastFollowRefreshAt = 0;

/**
 * 下一次自动状态刷新之前的延迟。
 *
 * 进入关注页会重新挂载其 hook，刚离开房间就再次进入曾会立刻触发又一次远程
 * 刷新。改为续用既有的节奏，让回访保持免费，
 * 同时直播状态的陈旧度仍不会超过一个周期。
 */
export function followStatusRefreshDelay(
  lastRefreshAt: number,
  now: number,
  intervalMs: number = FOLLOW_STATUS_REFRESH_INTERVAL_MS,
): number {
  const elapsed = now - lastRefreshAt;
  if (!Number.isFinite(elapsed) || elapsed < 0) return 0;
  return Math.max(0, Math.min(intervalMs, intervalMs - elapsed));
}

/**
 * 刷新一次直播状态数据，并让所有关注列表消费方共享同一个缓存条目。
 * `fetchQuery` 通过专用的在途 query key 合并并发触发的自动与手动刷新。
 */
export async function refreshFollows(queryClient: QueryClient): Promise<FollowUser[]> {
  const follows = await queryClient.fetchQuery({
    queryKey: FOLLOW_REFRESH_QUERY_KEY,
    queryFn: () => invokeCmd<FollowUser[]>("follow_refresh"),
    // 刷新必须总是联系后端；query key 只用于去重重叠请求，
    // 而不是缓存上次结果。
    staleTime: 0,
  });
  lastFollowRefreshAt = Date.now();
  queryClient.setQueryData(FOLLOW_LIST_QUERY_KEY, follows);
  return follows;
}

/**
 * 关注列表视图打开期间保持关注的主播数据最新。把它限定在自己的消费方内，
 * 可避免在应用初始渲染期间做远程状态工作；
 * 续用既有节奏则让回访 —— 从房间返回或切换平台过滤之后 ——
 * 不必重复缓存中已有的工作。
 */
export function useFollowStatusRefresh(enabled = true) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return;
    let interval: number | undefined;
    const refresh = () => {
      // 自动刷新失败不应把可用的缓存关注列表替换成错误页。
      // 下一次计划刷新会重试。
      void refreshFollows(queryClient).catch(() => {});
    };

    const timeout = window.setTimeout(
      () => {
        refresh();
        interval = window.setInterval(refresh, FOLLOW_STATUS_REFRESH_INTERVAL_MS);
      },
      followStatusRefreshDelay(lastFollowRefreshAt, Date.now()),
    );

    return () => {
      window.clearTimeout(timeout);
      if (interval != null) window.clearInterval(interval);
    };
  }, [enabled, queryClient]);
}
