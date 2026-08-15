import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DanmakuEvent } from "@/shared/types/live";
import { type DanmakuBatch, validatedDanmakuBatch } from "./batch";

type DanmakuBatchSubscriber = (events: readonly DanmakuEvent[], connectionEpoch: number) => void;

// A room renders the same native batch in the Canvas, chat, and SC overlay.
// Keep one Tauri listener and validate each event once before fanning out to
// those bounded, sink-specific queues.
const subscribers = new Set<DanmakuBatchSubscriber>();
let nativeUnlisten: UnlistenFn | null = null;
let listenerPromise: Promise<void> | null = null;
let listenerRetryTimer: number | null = null;
let listenerGeneration = 0;
let expectedConnectionEpoch: number | null = null;
const LISTENER_RETRY_DELAY_MS = 1_000;

/**
 * Rust permits one active danmaku connection app-wide. Record its epoch before
 * starting the asynchronous connect command so final batches from the old
 * room are rejected at the shared native-listener boundary.
 */
export function setExpectedDanmakuConnectionEpoch(connectionEpoch: number): void {
  expectedConnectionEpoch = connectionEpoch;
}

/** Clear only the epoch owned by the caller; a newer room may already exist. */
export function clearExpectedDanmakuConnectionEpoch(connectionEpoch: number): void {
  if (expectedConnectionEpoch === connectionEpoch) expectedConnectionEpoch = null;
}

function dispatch(payload: unknown): void {
  const batch = validatedDanmakuBatch(payload);
  if (!batch || batch.events.length === 0 || batch.connectionEpoch !== expectedConnectionEpoch) {
    return;
  }

  // A subscriber can unsubscribe while another one handles this batch. Work
  // from a snapshot and isolate failures so one panel cannot silence the rest.
  const currentSubscribers = Array.from(subscribers);
  for (const subscriber of currentSubscribers) {
    try {
      subscriber(batch.events, batch.connectionEpoch);
    } catch {
      // UI sinks are intentionally best-effort; their own bounded queues keep
      // a malformed or stale callback from affecting native event delivery.
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
      // React StrictMode and fast room switches can remove every subscriber
      // while Tauri is still resolving listen(). Do not retain that stale
      // native handler; attach a fresh one if a new subscriber arrived.
      if (subscribers.size === 0 || generation !== listenerGeneration) {
        void unlisten();
        ensureNativeListener();
        return;
      }
      nativeUnlisten = unlisten;
    },
    () => {
      listenerPromise = null;
      // A transient native listener failure should not leave every mounted
      // danmaku sink permanently disconnected. Retry at a bounded cadence.
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

/** Subscribe to the shared, prevalidated danmaku batch for the current room. */
export function subscribeDanmakuBatches(subscriber: DanmakuBatchSubscriber): () => void {
  subscribers.add(subscriber);
  ensureNativeListener();

  return () => {
    subscribers.delete(subscriber);
    stopNativeListenerIfUnused();
  };
}
