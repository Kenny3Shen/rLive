import { floatingDanmakuText, isDanmakuEvent } from "@/features/room/danmaku/filter";
import type { DanmakuEvent } from "@/shared/types/live";

const MAX_RECORDED_DANMAKU_EVENTS = 250_000;

type StoredDanmakuBatch = {
  offset_ms: number;
  events: unknown[];
};

export type RecordedDanmakuEntry = {
  offsetMs: number;
  event: DanmakuEvent;
  text: string;
  sequence: number;
};

function isStoredBatch(value: unknown): value is StoredDanmakuBatch {
  if (!value || typeof value !== "object") return false;
  const batch = value as Partial<StoredDanmakuBatch>;
  return (
    typeof batch.offset_ms === "number" &&
    Number.isFinite(batch.offset_ms) &&
    batch.offset_ms >= 0 &&
    Array.isArray(batch.events)
  );
}

/**
 * Parse the append-only JSONL sidecar defensively. A partially written final
 * line is ignored so recordings recovered after a forced shutdown still keep
 * every complete batch before it.
 */
export function parseRecordedDanmakuSidecar(text: string): RecordedDanmakuEntry[] {
  const entries: RecordedDanmakuEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isStoredBatch(value)) continue;
    const offsetMs = Math.floor(value.offset_ms);
    for (const event of value.events) {
      if (!isDanmakuEvent(event) || event.kind === "system") continue;
      const danmakuText = floatingDanmakuText(event);
      if (!danmakuText) continue;
      entries.push({
        offsetMs,
        event,
        text: danmakuText,
        sequence: entries.length,
      });
      if (entries.length >= MAX_RECORDED_DANMAKU_EVENTS) return entries;
    }
  }
  return entries.sort(
    (left, right) => left.offsetMs - right.offsetMs || left.sequence - right.sequence,
  );
}

export function firstRecordedDanmakuAtOrAfter(
  entries: readonly RecordedDanmakuEntry[],
  offsetMs: number,
): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (entries[middle]!.offsetMs < offsetMs) low = middle + 1;
    else high = middle;
  }
  return low;
}
