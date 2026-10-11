import { useCallback, useMemo, useSyncExternalStore } from "react";

/**
 * VOD 播放进度的外部 store（秒）。
 *
 * `timeupdate` 约 4Hz；把它放进播放页 state 会让整页连同侧栏（相关推荐、评论、
 * 弹幕列表）每 250ms 重渲染一次，主线程被占满时同屏飘动弹幕随之丢帧。页面只写
 * 不订阅，需要进度的叶子组件用 `usePlaybackClock` 按选择器订阅，选择结果不变就不重渲染。
 */
export type PlaybackClock = {
  get: () => number;
  set: (seconds: number) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createPlaybackClock(initial = 0): PlaybackClock {
  let seconds = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => seconds,
    set: (next) => {
      if (Object.is(next, seconds)) return;
      seconds = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const noopSubscribe = () => () => {};

/**
 * 订阅播放进度的派生值。`selector` 应返回原始值（下标、布尔、取整后的毫秒），
 * 以便进度变化而结果不变时跳过渲染。`enabled=false` 时不订阅，读数停在上次渲染。
 */
export function usePlaybackClock<T>(
  clock: PlaybackClock,
  selector: (seconds: number) => T,
  enabled = true,
): T {
  const subscribe = useMemo(() => (enabled ? clock.subscribe : noopSubscribe), [clock, enabled]);
  const getSnapshot = useCallback(() => selector(clock.get()), [clock, selector]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
