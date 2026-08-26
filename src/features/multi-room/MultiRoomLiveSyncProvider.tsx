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
 * 管理导演网格单次访问的校正循环。
 *
 * 计时器以命令式方式读取 store，滑杆变更在下一个 tick 生效而无需重启循环；
 * 对齐关闭时循环完全停止 —— 播放器的行为与没有此功能时完全一致。
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

/** 注册一条流的播放器句柄，但不订阅其状态。 */
export function useMultiRoomLiveSyncRegistration(input: {
  key: string;
  main: boolean;
  sync: LivePlayerSyncApi;
}): void {
  const { key, main, sync } = input;
  const registry = useContext(MultiRoomLiveSyncContext);
  // 这里刻意不订阅状态：磁贴承载整个播放器，
  // 每次校正 tick 都重渲染它的开销比对齐本身还大。
  // 只有小的状态子组件跟随数值变化。
  useEffect(() => registry?.registerFeed(key, { main, sync }), [key, main, registry, sync]);
}

/** 跟随一条流的状态，但不为它注册播放器。 */
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
