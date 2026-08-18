import {
  aggregatedDanmakuText,
  createShieldMatcher,
  danmakuContentAggregationKey,
  floatingDanmakuText,
  isDanmakuEvent,
  shouldShowValidatedOnFloatingDanmaku,
} from "@/features/room/danmaku/filter";
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

export type RecordedDanmakuFilterOptions = {
  filterGifts: boolean;
  showSuperChat: boolean;
  shieldWords: readonly string[];
};

export type RecordedDanmakuFrameEntry = RecordedDanmakuEntry & {
  baseText: string;
  aggregationCount: number;
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

/** Apply the same message visibility policy as the live floating layer. */
export function filterRecordedDanmakuEntries(
  entries: readonly RecordedDanmakuEntry[],
  options: RecordedDanmakuFilterOptions,
): RecordedDanmakuEntry[] {
  const isShielded = createShieldMatcher(options.shieldWords);
  return entries.filter(
    (entry) =>
      shouldShowValidatedOnFloatingDanmaku(entry.event, options.filterGifts) &&
      (options.showSuperChat || entry.event.kind !== "super_chat") &&
      !isShielded(entry.event),
  );
}

/**
 * Build only the media-time window that can currently be visible. Duplicate
 * chat content is grouped without looking ahead, so seeking never reveals a
 * count from a future point in the recording.
 */
export function recordedDanmakuFrame(
  entries: readonly RecordedDanmakuEntry[],
  currentMs: number,
  lookbackMs: number,
  mergeWindowSeconds: number,
): RecordedDanmakuFrameEntry[] {
  const current = Number.isFinite(currentMs) ? Math.max(0, currentMs) : 0;
  const lookback = Number.isFinite(lookbackMs) ? Math.max(0, lookbackMs) : 0;
  const first = firstRecordedDanmakuAtOrAfter(entries, current - lookback);
  // Sidecar offsets are integer milliseconds. This upper bound includes the
  // exact current millisecond while excluding every future entry.
  const last = firstRecordedDanmakuAtOrAfter(entries, Math.floor(current) + 1);
  const mergeWindowMs = Number.isFinite(mergeWindowSeconds)
    ? Math.max(0, Math.round(mergeWindowSeconds * 1_000))
    : 0;
  const frame: RecordedDanmakuFrameEntry[] = [];
  const groups = new Map<string, { index: number; lastOffsetMs: number }>();

  for (let index = first; index < last; index += 1) {
    const entry = entries[index]!;
    const aggregationKey = mergeWindowMs > 0 ? danmakuContentAggregationKey(entry.event) : null;
    const existingGroup = aggregationKey ? groups.get(aggregationKey) : undefined;

    if (
      existingGroup &&
      entry.offsetMs >= existingGroup.lastOffsetMs &&
      entry.offsetMs - existingGroup.lastOffsetMs <= mergeWindowMs
    ) {
      const existing = frame[existingGroup.index]!;
      const aggregationCount = existing.aggregationCount + 1;
      frame[existingGroup.index] = {
        ...existing,
        text: aggregatedDanmakuText(existing.baseText, aggregationCount),
        aggregationCount,
      };
      existingGroup.lastOffsetMs = entry.offsetMs;
      continue;
    }

    const frameIndex = frame.length;
    frame.push({ ...entry, baseText: entry.text, aggregationCount: 1 });
    if (aggregationKey) {
      groups.set(aggregationKey, { index: frameIndex, lastOffsetMs: entry.offsetMs });
    }
  }

  return frame;
}
