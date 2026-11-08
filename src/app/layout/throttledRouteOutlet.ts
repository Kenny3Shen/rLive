/** 普通页面首帧只提交活动面板，其余面板等它就绪后再挂载的导航记忆。 */
export type ThrottledRouteOutletMemory = {
  pathname: string;
  entryKey: string;
  immersive: boolean;
  throttled: boolean;
};

export type ThrottledRouteOutletRoute = {
  pathname: string;
  entryKey: string;
  immersive: boolean;
  /** 浏览器历史遍历；跨路径返回普通页也先提交轻量外壳。 */
  historyTraversal?: boolean;
};

export type ThrottledRouteOutletState = {
  memory: ThrottledRouteOutletMemory;
  /** 活动面板已经提交，且就绪回调属于当前历史条目。 */
  activeReady: boolean;
};

export function createThrottledRouteOutletState(
  route: ThrottledRouteOutletRoute,
): ThrottledRouteOutletState {
  return {
    memory: { ...route, throttled: false },
    activeReady: false,
  };
}

export function sameThrottledRouteOutletRoute(
  memory: ThrottledRouteOutletMemory,
  route: ThrottledRouteOutletRoute,
): boolean {
  return (
    memory.pathname === route.pathname &&
    memory.entryKey === route.entryKey &&
    memory.immersive === route.immersive
  );
}

/**
 * 从沉浸式播放器退出时，新的普通页面会与旧播放器一起提交。这个提交包含侧栏、
 * 头部、活动页面以及横滑保活轨道上的所有邻居；负载越高，React 的低优先级导航
 * 越容易被打断，点击之后长时间仍只看到旧播放器。把邻居推迟到活动页的就绪
 * 回调，首帧只需提交一个轻量外壳和一个内容面板，退出动画也能立即启动。
 *
 * 只消费一次「刚离开沉浸页」：同历史下重渲染和页签切换仍保留原有保活轨道；
 * 再次从沉浸页退出时，历史条目或路径一定与上次提交不同。返回主页的 PUSH、
 * 返回上一层的 POP 和 REPLACE 都适用，因为它们同样要替换整棵沉浸页面。
 * 普通页面跨路径 POP 同样会重挂目标列表，因此也按这条路径启动页面平移；
 * 同路径的平台/页签历史遍历保持既有保活轨道。
 */
export function nextThrottledRouteOutletState(
  previous: ThrottledRouteOutletState,
  route: ThrottledRouteOutletRoute,
): ThrottledRouteOutletState {
  const changedSurface =
    previous.memory.pathname !== route.pathname || previous.memory.entryKey !== route.entryKey;
  const sameEntry = previous.memory.entryKey === route.entryKey;
  // 活动页尚未提交时又切到另一个普通页面（例如快速点页签），仍按分阶段渲染；
  // 已就绪之后换页则立即恢复完整保活轨道，邻居不会因换页反复重建。
  const unfinishedExit =
    previous.memory.throttled && !previous.activeReady && !previous.memory.immersive;
  const crossPageHistory = route.historyTraversal && previous.memory.pathname !== route.pathname;
  const throttle =
    !route.immersive &&
    ((previous.memory.immersive && changedSurface) ||
      crossPageHistory ||
      unfinishedExit ||
      (sameEntry && previous.memory.throttled));
  return {
    memory: { ...route, throttled: throttle },
    // 同一条目的重渲染保留就绪态；新表面必须重新等活动页提交。
    activeReady: !changedSurface && previous.activeReady,
  };
}
