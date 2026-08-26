import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DanmakuEvent } from "@/shared/types/live";
import { type DanmakuBatch, validatedDanmakuBatch } from "./batch";

type DanmakuBatchSubscriber = (events: readonly DanmakuEvent[], connectionEpoch: number) => void;

// 一个房间在悬浮 DOM 层、聊天和 SC 叠加层中渲染同一场原生批次。保持单一的
// Tauri 监听器，先把每个事件校验一次再扇出到那些有界、各归其主的队列。
const subscribers = new Set<DanmakuBatchSubscriber>();
let nativeUnlisten: UnlistenFn | null = null;
let listenerPromise: Promise<void> | null = null;
let listenerRetryTimer: number | null = null;
let listenerGeneration = 0;
let expectedConnectionEpoch: number | null = null;
const LISTENER_RETRY_DELAY_MS = 1_000;

/**
 * Rust 允许全应用同时只有一个活动弹幕连接。启动异步 connect 命令之前记录其
 * epoch，使旧房间的最后批次在共享的原生监听器边界处被拒绝。
 */
export function setExpectedDanmakuConnectionEpoch(connectionEpoch: number): void {
  expectedConnectionEpoch = connectionEpoch;
}

/** 只清除调用方拥有的 epoch；更新的房间可能已经存在。 */
export function clearExpectedDanmakuConnectionEpoch(connectionEpoch: number): void {
  if (expectedConnectionEpoch === connectionEpoch) expectedConnectionEpoch = null;
}

function dispatch(payload: unknown): void {
  const batch = validatedDanmakuBatch(payload);
  if (!batch || batch.events.length === 0 || batch.connectionEpoch !== expectedConnectionEpoch) {
    return;
  }

  // 某个订阅者可能在另一个订阅者处理此批次时退订。基于快照工作并隔离失败，
  // 使一个面板无法让其他面板静音。
  const currentSubscribers = Array.from(subscribers);
  for (const subscriber of currentSubscribers) {
    try {
      subscriber(batch.events, batch.connectionEpoch);
    } catch {
      // UI sink 刻意尽力而为；它们各自的有界队列保证畸形或过期的回调
      // 不影响原生事件投递。
    }
  }
}

function ensureNativeListener(): void {
  if (nativeUnlisten || listenerPromise || listenerRetryTimer !== null || subscribers.size === 0) {
    return;
  }

  const generation = ++listenerGeneration;
  listenerPromise = listen<DanmakuBatch>("danmaku-batch", (event) => {
    if (generation !== listenerGeneration) return;
    dispatch(event.payload);
  }).then(
    (unlisten) => {
      listenerPromise = null;
      // React StrictMode 和快速房间切换可能在 Tauri 还在解析 listen() 时就移除所有
      // 订阅者。不要保留那个过期的原生处理器；
      // 若有新订阅者到来则重新挂一个。
      if (subscribers.size === 0 || generation !== listenerGeneration) {
        void unlisten();
        ensureNativeListener();
        return;
      }
      nativeUnlisten = unlisten;
    },
    () => {
      listenerPromise = null;
      // 一次瞬态的原生监听器失败不应让所有已挂载的弹幕 sink 永久断连。
      // 以有界节奏重试。
      if (subscribers.size > 0 && listenerRetryTimer === null) {
        listenerRetryTimer = window.setTimeout(() => {
          listenerRetryTimer = null;
          ensureNativeListener();
        }, LISTENER_RETRY_DELAY_MS);
      }
    },
  );
}

function stopNativeListenerIfUnused(): void {
  if (subscribers.size > 0) return;
  listenerGeneration += 1;
  const unlisten = nativeUnlisten;
  nativeUnlisten = null;
  if (unlisten) void unlisten();
  if (listenerRetryTimer !== null) {
    window.clearTimeout(listenerRetryTimer);
    listenerRetryTimer = null;
  }
}

/** 订阅当前房间共享的、预校验过的弹幕批次。 */
export function subscribeDanmakuBatches(subscriber: DanmakuBatchSubscriber): () => void {
  subscribers.add(subscriber);
  ensureNativeListener();

  return () => {
    subscribers.delete(subscriber);
    stopNativeListenerIfUnused();
  };
}
