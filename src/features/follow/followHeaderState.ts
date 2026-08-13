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

/** Publish page-owned actions for controls rendered by the parent Shell. */
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

/** Subscribe from Shell without coupling it to the lazy follow page module. */
export function useFollowHeaderSnapshot(): FollowHeaderState {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => EMPTY_STATE,
  );
}
