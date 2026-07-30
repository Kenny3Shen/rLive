import type { DanmakuEvent } from "@/shared/types/live";
import { isDanmakuEvent } from "./filter";

/** Payload emitted by the native danmaku transport at a bounded cadence. */
export type DanmakuBatch = {
  connection_epoch: number;
  events: DanmakuEvent[];
};

export type ValidatedDanmakuBatch = {
  connectionEpoch: number;
  events: DanmakuEvent[];
};

/**
 * Tauri events cross a native boundary, so reject malformed envelopes before
 * any room sink iterates their raw event candidates.
 */
export function batchEvents(payload: unknown): readonly unknown[] {
  if (!payload || typeof payload !== "object") return [];
  const events = (payload as { events?: unknown }).events;
  return Array.isArray(events) ? events : [];
}

/**
 * Validate a native batch once at the room boundary. Canvas, chat and SC can
 * then consume the same immutable event objects without each repeating the
 * span and field checks for every message.
 */
export function validatedBatchEvents(payload: unknown): DanmakuEvent[] {
  const valid: DanmakuEvent[] = [];
  for (const event of batchEvents(payload)) {
    if (isDanmakuEvent(event)) valid.push(event);
  }
  return valid;
}

/**
 * Preserve the native connection fence alongside the prevalidated events.
 * A final batch from a room that is being disconnected must never be rendered
 * by a freshly mounted room that happens to share the Tauri event channel.
 */
export function validatedDanmakuBatch(payload: unknown): ValidatedDanmakuBatch | null {
  if (!payload || typeof payload !== "object") return null;
  const connectionEpoch = (payload as { connection_epoch?: unknown }).connection_epoch;
  if (
    typeof connectionEpoch !== "number" ||
    !Number.isSafeInteger(connectionEpoch) ||
    connectionEpoch < 0
  ) {
    return null;
  }

  return { connectionEpoch, events: validatedBatchEvents(payload) };
}
