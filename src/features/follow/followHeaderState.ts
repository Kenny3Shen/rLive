import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { FollowView } from "./followRoute";

export type FollowHeaderState = {
  view: FollowView;
  onViewChange: (view: FollowView) => void;
};

const EMPTY_STATE: FollowHeaderState = {
  view: "live",
  onViewChange: () => undefined,
};

const listeners = new Set<() => void>();
let owner: symbol | null = null;
let snapshot = EMPTY_STATE;

function publish(nextOwner: symbol, nextSnapshot: FollowHeaderState) {
  owner = nextOwner;
  snapshot = nextSnapshot;
  listeners.forEach((listener) => listener());
}

function clear(nextOwner: symbol) {
  if (owner !== nextOwner) return;
  owner = null;
  snapshot = EMPTY_STATE;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 发布页面自有操作，供父级 Shell 渲染的控件使用。 */
export function useFollowHeaderState(state: FollowHeaderState) {
  const ownerRef = useRef<symbol | undefined>(undefined);
  if (!ownerRef.current) ownerRef.current = Symbol("follow-header");

  useLayoutEffect(() => {
    publish(ownerRef.current!, state);
  }, [state]);

  useLayoutEffect(() => {
    const currentOwner = ownerRef.current!;
    return () => clear(currentOwner);
  }, []);
}

/** 由 Shell 订阅，同时不与懒加载的关注页模块耦合。 */
export function useFollowHeaderSnapshot(): FollowHeaderState {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => EMPTY_STATE,
  );
}
