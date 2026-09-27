import type { QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * B 站 TV 授权影响的三条流：VOD 主推荐、story，以及**直播首页推荐**。
 *
 * 直播首页这条容易漏掉：它的凭据不是 Web Cookie，而是同一份 TV 凭据
 * （见 `src-tauri/src/commands/site.rs` 的 `resolve_recommend_site`），
 * 因此 Web Cookie 的失效逻辑（`cookieQueryInvalidation`）覆盖不到它，
 * 但授权变更必须让它重取，否则换账号后首页仍是旧账号的内容。
 *
 * 其他站点、其他页签与播放缓存不受影响。
 */
export function isBilibiliAppQuery(queryKey: QueryKey): boolean {
  if (queryKey[0] === "shorts_story") return true;
  // 直播首页：["recommend", siteId, 授权版本]。
  if (queryKey[0] === "recommend") return queryKey[1] === "bilibili";
  return (
    queryKey[0] === "video_list" && queryKey[1] === "recommend" && queryKey[3] === "app"
  );
}

export async function invalidateBilibiliAppQueries(queryClient: QueryClient): Promise<void> {
  const filter = { predicate: (query: { queryKey: QueryKey }) => isBilibiliAppQuery(query.queryKey) };
  // 取消旧身份的在途结果，再丢弃列表，避免授权变更后仍展示旧推荐。
  await queryClient.cancelQueries(filter);
  await queryClient.resetQueries(filter);
}
