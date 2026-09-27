import type { QueryClient, QueryKey } from "@tanstack/react-query";

/** APP 授权只影响两条推荐流；不清 Web 推荐、热门、UP 主列表或播放缓存。 */
export function isBilibiliAppQuery(queryKey: QueryKey): boolean {
  return queryKey[0] === "shorts_story" || (
    queryKey[0] === "video_list" && queryKey[1] === "recommend" && queryKey[3] === "app"
  );
}

export async function invalidateBilibiliAppQueries(queryClient: QueryClient): Promise<void> {
  const filter = { predicate: (query: { queryKey: QueryKey }) => isBilibiliAppQuery(query.queryKey) };
  // 取消旧身份的在途结果，再丢弃列表，避免授权变更后仍展示旧推荐。
  await queryClient.cancelQueries(filter);
  await queryClient.resetQueries(filter);
}
