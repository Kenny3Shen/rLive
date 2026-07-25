import type { DanmakuEvent } from "@/shared/types/live";

/** Payload emitted by the native danmaku transport at a bounded cadence. */
export type DanmakuBatch = {
  connection_epoch: number;
  events: DanmakuEvent[];
};

/**
 * Tauri events cross a native boundary, so keep the envelope validation at
 * the listener edge. Individual messages are still validated by the filters.
 */
export function batchEvents(payload: unknown): readonly unknown[] {
  if (!payload || typeof payload !== "object") return [];
  const events = (payload as { events?: unknown }).events;
  return Array.isArray(events) ? events : [];
}
