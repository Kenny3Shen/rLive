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

/** Publish page-owned actions for controls rendered by the parent Shell. */
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

/** Subscribe from Shell without coupling it to the lazy history page module. */
export function useHistoryHeaderSnapshot(): HistoryHeaderState {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => EMPTY_STATE,
  );
}
