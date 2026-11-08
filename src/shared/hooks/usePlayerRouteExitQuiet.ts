import { useContext, useLayoutEffect, useMemo } from "react";
import { UNSAFE_DataRouterContext, UNSAFE_LocationContext } from "react-router-dom";
import { watchPlayerRouteExit, type PlayerExitQuiet } from "@/shared/player/playerExitQuiet";

/** 所有路由离场入口共用：页内返回、侧栏导航与系统 POP 都在 React 提交前静默。 */
export function usePlayerRouteExitQuiet({
  videoRef,
  clock,
  danmakuRendererRef,
}: PlayerExitQuiet): void {
  const router = useContext(UNSAFE_DataRouterContext)?.router;
  const entryKey = useContext(UNSAFE_LocationContext)?.location.key;
  const quiet = useMemo(
    () => ({ videoRef, clock, danmakuRendererRef }),
    [videoRef, clock, danmakuRendererRef],
  );
  useLayoutEffect(() => {
    if (!router || !entryKey) return;
    return watchPlayerRouteExit(router, entryKey, quiet);
  }, [router, entryKey, quiet]);
}
