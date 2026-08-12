import { isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { webBridgeStatus, withBridgeToken } from "@/shared/api/webBridge";
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

/**
 * Attaches the transport-appropriate batch listener.
 *
 * The WebView receives batches as Tauri events. A browser tab served by rLive's
 * local bridge receives the identical envelopes as Server-Sent Events, so the
 * validation, epoch fencing, and fan-out below are shared by both transports.
 */
function attachBatchListener(handler: (payload: unknown) => void): Promise<UnlistenFn> {
  if (isTauri()) {
    return listen<DanmakuBatch>("danmaku-batch", (event) => handler(event.payload));
  }
  return attachBridgeListener(handler);
}

async function attachBridgeListener(handler: (payload: unknown) => void): Promise<UnlistenFn> {
  if (!(await webBridgeStatus())) {
    throw new Error("danmaku batches require the rLive client or its local bridge");
  }

  const source = new EventSource(withBridgeToken("/api/events"));
  source.addEventListener("danmaku-batch", (event) => {
    try {
      handler(JSON.parse((event as MessageEvent<string>).data));
    } catch {
      // A truncated or malformed frame is dropped like any other invalid batch.
    }
  });
  // EventSource reconnects on its own, so a transient network error must not
  // tear the subscription down; only an explicit unsubscribe closes it.
  return () => {
    source.close();
  };
}

function ensureNativeListener(): void {
  if (nativeUnlisten || listenerPromise || listenerRetryTimer !== null || subscribers.size === 0) {
    return;
  }

  const generation = ++listenerGeneration;
  listenerPromise = attachBatchListener((payload) => {
    if (generation !== listenerGeneration) return;
    dispatch(payload);
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
      // A transient bridge failure should not leave every mounted danmaku
      // sink permanently disconnected. Retry at a bounded cadence instead of
      // spinning while Tauri is starting or recovering.
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
