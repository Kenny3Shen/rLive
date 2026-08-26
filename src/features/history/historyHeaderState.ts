import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { HistoryView } from "./historyRoute";

export type HistoryHeaderState = {
  view: HistoryView;
  canClear: boolean;
  clearPending: boolean;
  onViewChange: (view: HistoryView) => void;
  onRequestClear: () => void;
};

const EMPTY_STATE: HistoryHeaderState = {
  view: "watch",
  canClear: false,
  clearPending: false,
  onViewChange: () => undefined,
  onRequestClear: () => undefined,
};

const listeners = new Set<() => void>();
let owner: symbol | null = null;
let snapshot = EMPTY_STATE;

function publish(nextOwner: symbol, nextSnapshot: HistoryHeaderState) {
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
export function useHistoryHeaderState(state: HistoryHeaderState) {
  const ownerRef = useRef<symbol | undefined>(undefined);
  if (!ownerRef.current) ownerRef.current = Symbol("history-header");

  useLayoutEffect(() => {
    publish(ownerRef.current!, state);
  }, [state]);

  useLayoutEffect(() => {
    const currentOwner = ownerRef.current!;
    return () => clear(currentOwner);
  }, []);
}

/** 由 Shell 订阅，同时不与懒加载的历史页模块耦合。 */
export function useHistoryHeaderSnapshot(): HistoryHeaderState {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => EMPTY_STATE,
  );
}
