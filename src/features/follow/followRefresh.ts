import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { invokeCmd } from "@/shared/api/tauri";
import type { FollowRefreshResult, FollowRefreshTarget, FollowUser } from "@/shared/types/live";

export const FOLLOW_LIST_QUERY_KEY = ["follows"] as const;
const FOLLOW_REFRESH_QUERY_KEY = ["follows", "refresh"] as const;
export const FOLLOW_STATUS_REFRESH_INTERVAL_MS = 60_000;

let lastFollowRefreshAt = 0;

/** 关注键：与后端 `follow_key` 一致，用于按条标记“本轮已确认”。 */
export function followKey(siteId: string, roomId: string): string {
  return `${siteId}:${roomId}`;
}

/**
 * 把本轮摘要整理成 UI 需要的形状。
 *
 * 关键是区分三类条目：
 *
 * - 本轮已确认（在 `refreshed_keys` 里）：状态可信；
 * - 本轮失败（在 `failures` 里）：状态未知，可定向重试；
 * - 本轮未参与（定向重试时的其余条目）：保持上一轮结论，不冒充本轮结果。
 */
export type FollowRefreshOutcome = {
  follows: FollowUser[];
  /** 本轮成功确认的房间键。 */
  confirmed: Set<string>;
  /** 本轮失败项，可原样交给定向重试。 */
  failures: FollowRefreshTarget[];
  checkedAt: number;
  total: number;
};

export function summarizeRefresh(result: FollowRefreshResult): FollowRefreshOutcome {
  return {
    follows: result.follows,
    confirmed: new Set(result.summary.refreshed_keys),
    failures: result.summary.failures.map((failure) => ({
      siteId: failure.site_id,
      roomId: failure.room_id,
      userName: failure.user_name,
    })),
    checkedAt: result.summary.checked_at,
    total: result.summary.total,
  };
}

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

/** 把一轮结果写入共享列表缓存。 */
export function applyRefreshResult(queryClient: QueryClient, outcome: FollowRefreshOutcome): void {
  queryClient.setQueryData(FOLLOW_LIST_QUERY_KEY, outcome.follows);
}

/**
 * 刷新一次直播状态数据，并让所有关注列表消费方共享同一个缓存条目。
 * `fetchQuery` 通过专用的在途 query key 合并并发触发的自动与手动刷新。
 */
export async function refreshFollows(queryClient: QueryClient): Promise<FollowRefreshOutcome> {
  const result = await queryClient.fetchQuery({
    queryKey: FOLLOW_REFRESH_QUERY_KEY,
    queryFn: () => invokeCmd<FollowRefreshResult>("follow_refresh"),
    // 刷新必须总是联系后端；query key 只用于去重重叠请求，
    // 而不是缓存上次结果。
    staleTime: 0,
  });
  const outcome = summarizeRefresh(result);
  lastFollowRefreshAt = Date.now();
  applyRefreshResult(queryClient, outcome);
  return outcome;
}

/**
 * 只重试指定的失败项。
 *
 * 用独立的 query key，避免与整表刷新互相顶掉；返回的列表仍是完整列表，
 * 因此可以整体写回缓存，未参与的房间保持原状态。
 */
export async function retryFailedFollows(
  queryClient: QueryClient,
  targets: FollowRefreshTarget[],
): Promise<FollowRefreshOutcome> {
  if (targets.length === 0) {
    return { follows: [], confirmed: new Set(), failures: [], checkedAt: Date.now(), total: 0 };
  }
  const result = await invokeCmd<FollowRefreshResult>("follow_refresh_selected", {
    targets: targets.map((target) => ({ site_id: target.siteId, room_id: target.roomId })),
  });
  const outcome = summarizeRefresh(result);
  lastFollowRefreshAt = Date.now();
  // 定向重试后仍写回整表：成功项应立刻反映，未参与项与之前一致。
  if (outcome.follows.length > 0) applyRefreshResult(queryClient, outcome);
  return outcome;
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
