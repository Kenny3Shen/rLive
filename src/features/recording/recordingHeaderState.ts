import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { RecordingView } from "./recordingRoute";

export type RecordingHeaderState = {
  view: RecordingView;
  counts: Record<RecordingView, number>;
  onViewChange: (view: RecordingView) => void;
  onRequestStorage: () => void;
};

const EMPTY_STATE: RecordingHeaderState = {
  view: "all",
  counts: { all: 0, recording: 0, recorded: 0 },
  onViewChange: () => undefined,
  onRequestStorage: () => undefined,
};

const listeners = new Set<() => void>();
let owner: symbol | null = null;
let snapshot = EMPTY_STATE;

function publish(nextOwner: symbol, nextSnapshot: RecordingHeaderState) {
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
export function useRecordingHeaderState(state: RecordingHeaderState) {
  const ownerRef = useRef<symbol | undefined>(undefined);
  if (!ownerRef.current) ownerRef.current = Symbol("recording-header");

  useLayoutEffect(() => {
    publish(ownerRef.current!, state);
  }, [state]);

  useLayoutEffect(() => {
    const currentOwner = ownerRef.current!;
    return () => clear(currentOwner);
  }, []);
}

/** 由 Shell 订阅，同时不与懒加载的录制页模块耦合。 */
export function useRecordingHeaderSnapshot(): RecordingHeaderState {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => EMPTY_STATE,
  );
}
