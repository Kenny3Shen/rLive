/**
 * 发现页列表（推荐、分类树、分类房间页）的共享缓存策略。
 *
 * 它们是应用中最昂贵的浏览请求且变化缓慢。路由组件可能在用户切换视图时卸载，
 * 而每个平台有各自的 query key，因此有界的过期窗口会让很多访问 —— 从房间返回、
 * 在平台间切换 —— 都付出一轮新的 IPC。
 *
 * 把数据标记为永久新鲜让后续每次访问零成本。新鲜度完全由显式控制：
 * - 桌面刷新按钮和移动端下拉刷新手势直接调用 `refetch()`，它忽略 `staleTime`；
 * - `invalidateQueries`（Cookie 变更、配置导入）同样忽略 `staleTime`，
 * 使失效后的挂载仍然重新抓取。
 *
 * `gcTime` 被拉长到超过一次典型观看时长，
 * 使观看一段时间后不会悄悄丢掉用户来自的那个列表。
 */
export const BROWSING_LIST_QUERY_OPTIONS = {
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: 60 * 60_000,
} as const;
