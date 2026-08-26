import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { LivePlayerSyncApi } from "@/features/room/player/useWebPlayer";
import {
  createMultiRoomLiveSyncRegistry,
  LIVE_SYNC_TICK_MS,
  type LiveSyncFeedStatus,
  type LiveSyncSummary,
  type MultiRoomLiveSyncRegistry,
} from "./liveSyncRegistry";
import { useMultiRoomStore } from "./multiRoomStore";

const MultiRoomLiveSyncContext = createContext<MultiRoomLiveSyncRegistry | null>(null);

const IDLE_SUMMARY: LiveSyncSummary = { mode: "off", targetLatencySeconds: null, activeCount: 0 };
const noopSubscribe = () => () => {};

/**
 * Owns the correction loop for one visit to the director grid.
 *
 * The timer reads the store imperatively so a slider change takes effect on the
 * next tick without restarting the loop, and stops entirely while the alignment
 * is off — the players then behave exactly as they did before the feature.
 */
export function MultiRoomLiveSyncProvider({ children }: { children: ReactNode }) {
  const registryRef = useRef<MultiRoomLiveSyncRegistry | null>(null);
  registryRef.current ??= createMultiRoomLiveSyncRegistry();
  const registry = registryRef.current;
  const syncMode = useMultiRoomStore((state) => state.syncMode);

  useEffect(() => {
    if (syncMode === "off") {
      registry.reset();
      return;
    }
    const run = () => {
      const { syncMode: mode, syncOffsets: offsets } = useMultiRoomStore.getState();
      registry.tick({ mode, offsets, nowMs: Date.now() });
    };
    run();
    const interval = window.setInterval(run, LIVE_SYNC_TICK_MS);
    return () => {
      window.clearInterval(interval);
      registry.reset();
    };
  }, [registry, syncMode]);

  return (
    <MultiRoomLiveSyncContext.Provider value={registry}>
      {children}
    </MultiRoomLiveSyncContext.Provider>
  );
}

export function useMultiRoomLiveSyncRegistry(): MultiRoomLiveSyncRegistry | null {
  return useContext(MultiRoomLiveSyncContext);
}

/** Register one feed's player handle without subscribing to its status. */
export function useMultiRoomLiveSyncRegistration(input: {
  key: string;
  main: boolean;
  sync: LivePlayerSyncApi;
}): void {
  const { key, main, sync } = input;
  const registry = useContext(MultiRoomLiveSyncContext);
  // Deliberately no status subscription here: the tile hosts the whole player,
  // and re-rendering it on every correction tick would cost more than the
  // alignment itself. Only the small status children follow the numbers.
  useEffect(() => registry?.registerFeed(key, { main, sync }), [key, main, registry, sync]);
}

/** Follow a feed's status without registering a player for it. */
export function useMultiRoomLiveSyncStatus(key: string): LiveSyncFeedStatus | null {
  const registry = useContext(MultiRoomLiveSyncContext);
  const subscribe = useCallback(
    (listener: () => void) => (registry ? registry.subscribeFeed(key, listener) : noopSubscribe()),
    [key, registry],
  );
  const getSnapshot = useCallback(() => registry?.getFeedStatus(key) ?? null, [key, registry]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function useMultiRoomLiveSyncSummary(): LiveSyncSummary {
  const registry = useContext(MultiRoomLiveSyncContext);
  const subscribe = useCallback(
    (listener: () => void) => (registry ? registry.subscribeSummary(listener) : noopSubscribe()),
    [registry],
  );
  const getSnapshot = useCallback(() => registry?.getSummary() ?? IDLE_SUMMARY, [registry]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
