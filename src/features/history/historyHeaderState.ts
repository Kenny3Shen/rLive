import { useLayoutEffect, useState, useSyncExternalStore } from "react";
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
  // 惰性初始化的 Symbol 作为会话所有者：useState 保证跨渲染身份稳定，
  // 也避免渲染期读写 ref。
  const [owner] = useState(() => Symbol("history-header"));

  useLayoutEffect(() => {
    publish(owner, state);
  }, [owner, state]);

  useLayoutEffect(() => {
    const currentOwner = owner;
    return () => clear(currentOwner);
  }, [owner]);
}

/** 由 Shell 订阅，同时不与懒加载的历史页模块耦合。 */
export function useHistoryHeaderSnapshot(): HistoryHeaderState {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => EMPTY_STATE,
  );
}
