import { useContext, type ReactNode } from "react";
import { UNSAFE_LocationContext, UNSAFE_RouteContext } from "react-router-dom";

type LocationContextValue = React.ContextType<typeof UNSAFE_LocationContext>;
type RouteContextValue = React.ContextType<typeof UNSAFE_RouteContext>;

/**
 * 一次提交时刻的完整路由上下文快照。
 *
 * `location` 决定 `useLocation` / `useSearchParams` / `useNavigationType`，
 * `route` 决定 `useParams` / `useMatches` / `useOutlet` —— 冻结这两者，
 * 离场页面就仍然读到自己那一页的 URL 与路由参数。
 */
export type FrozenRouter = {
  location: LocationContextValue;
  route: RouteContextValue;
};

/**
 * 读取当前渲染所属的路由上下文。
 *
 * 只在 `PagePan` / `PageZoom` 里用：快照必须在**同一个 render** 里同时拿到
 * 页面子树与它对应的 location，因此这里用 `useContext` 而不是 `useLocation`
 * 之类的派生 hook（后者在离场期间会读到新页面）。
 */
export function useFrozenRouter(): FrozenRouter {
  return {
    location: useContext(UNSAFE_LocationContext),
    route: useContext(UNSAFE_RouteContext),
  };
}

/**
 * 把子树重新挂回一份路由上下文。
 *
 * 为什么必须有这一层：React 卸载旧页面时，离场快照复用的是同一个 React 元素，
 * 但**上下文不是元素的一部分**。路由变化会通过 `LocationContext` 的订阅者
 * 传播下去，旧页面里的 `useSearchParams` / `useParams` 会带着新 URL 重渲染 ——
 * 播放页于是把自己渲染成「缺少有效参数」的错误态，退出动画里看到的是一块错误卡，
 * 而不是正在播放的画面。
 *
 * 冻结后 `value` 与原渲染时是同一个对象，因此不会触发任何订阅者重渲染，
 * 整棵离场子树真正保持挂载（媒体元素也一并存活）。
 *
 * 两层的子节点必须是**同一种元素类型**：`PagePan` / `PageZoom` 靠 key 让
 * React 把上一帧的层原样搬进离场位，子节点类型一变就退化成卸载重建 ——
 * 媒体元素、播放器实例与页面状态全部从头再来。
 */
export function RouterScope({
  value,
  children,
}: {
  value: FrozenRouter;
  children: ReactNode;
}) {
  return (
    <UNSAFE_LocationContext.Provider value={value.location}>
      <UNSAFE_RouteContext.Provider value={value.route}>{children}</UNSAFE_RouteContext.Provider>
    </UNSAFE_LocationContext.Provider>
  );
}
