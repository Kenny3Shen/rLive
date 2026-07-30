import type { DanmakuEvent, DanmakuKind } from "@/shared/types/live";
import { hasValidDanmakuContentSpans } from "./content";

function normalizedShieldWords(shieldWords: readonly string[]): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const rawWord of shieldWords) {
    if (typeof rawWord !== "string") continue;
    const word = rawWord.trim().toLowerCase();
    if (!word || seen.has(word)) continue;
    seen.add(word);
    words.push(word);
  }
  return words;
}

function matchesShieldWords(event: DanmakuEvent, shieldWords: readonly string[]): boolean {
  if (shieldWords.length === 0 || event.kind === "system") return false;
  const lower = (event.content || "").toLowerCase();
  if (!lower) return true;
  return shieldWords.some((word) => lower.includes(word));
}

const DANMAKU_KINDS: readonly DanmakuKind[] = ["chat", "gift", "enter", "super_chat", "system"];

/**
 * Tauri events originate outside the TypeScript type system. Treat a malformed
 * payload as a dropped message instead of letting a busy listener throw.
 */
export function isDanmakuEvent(value: unknown): value is DanmakuEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<DanmakuEvent>;
  return (
    typeof event.kind === "string" &&
    DANMAKU_KINDS.includes(event.kind as DanmakuKind) &&
    typeof event.user === "string" &&
    typeof event.content === "string" &&
    typeof event.ts === "number" &&
    Number.isFinite(event.ts) &&
    (event.is_self === undefined || typeof event.is_self === "boolean") &&
    (event.color === null || typeof event.color === "string") &&
    (event.spans === undefined || event.spans === null || hasValidDanmakuContentSpans(event.spans))
  );
}

const ROOM_ENTER_SUFFIXES = ["进入直播间", "进入了直播间", "进入直播间了"];

function hasRoomEnterSuffix(content: string): boolean {
  // Keep the common chat path allocation-free. The three supported notices
  // only end in one of these two characters; importantly, `进入直播间了`
  // ends in `了`, not `间`.
  const finalCharacter = content.at(-1);
  if (finalCharacter !== "间" && finalCharacter !== "了") return false;
  return ROOM_ENTER_SUFFIXES.some((suffix) => content.endsWith(suffix));
}

/**
 * A few relays encode an entry notice as ordinary chat text instead of the
 * shared `enter` event. Normalize whitespace so both “小明进入直播间” and
 * “小明 进入了直播间” are suppressed consistently after an upstream fallback.
 */
function isRoomEnterNotice(kind: DanmakuKind, content: string): boolean {
  if (kind === "enter") return true;
  // This runs for every chat line. Avoid allocating a whitespace-normalized
  // copy for ordinary messages. `进入直播间了` is intentionally included in
  // the fast path as it ends in `了` rather than `间`.
  if (hasRoomEnterSuffix(content)) return true;
  const finalCharacter = content.at(-1);
  if (finalCharacter !== "间" && finalCharacter !== "了") return false;
  // Preserve support for relays which insert spaces inside the notice without
  // paying the replace-all cost in the normal high-frequency path.
  if (!/\s/.test(content)) return false;
  const compact = content.replaceAll(/\s+/g, "");
  return hasRoomEnterSuffix(compact);
}

/**
 * Prepares a shield matcher for high-frequency danmaku listeners. The setting
 * list is normalized only when it changes, rather than once per message.
 */
export function createShieldMatcher(
  shieldWords: readonly string[],
): (event: DanmakuEvent) => boolean {
  const words = normalizedShieldWords(shieldWords);
  return (event) => matchesShieldWords(event, words);
}

/** Shared shield-word filter for list + canvas. */
export function isShielded(event: DanmakuEvent, shieldWords: readonly string[]): boolean {
  return matchesShieldWords(event, normalizedShieldWords(shieldWords));
}

/**
 * Hide service join notices everywhere. They are noisy on busy Douyu rooms;
 * Douyu additionally drops them before IPC, while this keeps other sites
 * consistent if they emit the shared `enter` event.
 */
export function shouldShowValidatedInDanmakuPanel(
  event: DanmakuEvent,
  filterGifts = false,
): boolean {
  const content = event.content.trim();
  return (
    Boolean(content) &&
    !isRoomEnterNotice(event.kind, content) &&
    !(filterGifts && event.kind === "gift")
  );
}

export function shouldShowInDanmakuPanel(
  event: unknown,
  filterGifts = false,
): event is DanmakuEvent {
  return isDanmakuEvent(event) && shouldShowValidatedInDanmakuPanel(event, filterGifts);
}

export const DANMAKU_CONTENT_AGGREGATION_WINDOW_MS = 5_000;
const MAX_CONTENT_AGGREGATION_KEYS = 512;

export type DanmakuContentAggregation = {
  /** Shared by every platform and sender; null means this event is not grouped. */
  key: string | null;
  count: number;
};

export type DanmakuContentAggregator = {
  aggregate: (event: DanmakuEvent) => DanmakuContentAggregation;
  /** Stop a count when its displayed item has fallen out of the bounded feed. */
  forget: (key: string) => void;
  clear: () => void;
};

/**
 * Content-only key for normal chat, scoped by whether it came from the local
 * account. A room-wide "加油" burst remains compact, while a local comment
 * never gets folded into another viewer's visual treatment (or vice versa).
 */
export function danmakuContentAggregationKey(event: DanmakuEvent): string | null {
  if (event.kind !== "chat") return null;
  const content = event.content.trim();
  return content ? `${event.is_self === true ? "self" : "other"}\u0000${content}` : null;
}

export function aggregatedDanmakuText(content: string, count: number): string {
  const normalized = content.trim();
  return count > 1 ? `${normalized} ×${count}` : normalized;
}

/**
 * Maintains a bounded, sliding five-second content window. It deliberately
 * ignores gifts and SC because those messages carry independent semantics.
 */
export function createDanmakuContentAggregator(
  enabled: boolean,
  windowMs = DANMAKU_CONTENT_AGGREGATION_WINDOW_MS,
): DanmakuContentAggregator {
  const entries = new Map<string, { at: number; count: number }>();
  const safeWindowMs = Math.max(0, Number.isFinite(windowMs) ? windowMs : 0);

  const trimToCapacity = () => {
    while (entries.size > MAX_CONTENT_AGGREGATION_KEYS) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) return;
      entries.delete(oldestKey);
    }
  };

  return {
    aggregate: (event) => {
      const key = enabled ? danmakuContentAggregationKey(event) : null;
      if (!key) return { key: null, count: 1 };

      const at = Number.isFinite(event.ts) ? event.ts : Date.now();
      const previous = entries.get(key);
      const count =
        previous && at >= previous.at && at - previous.at <= safeWindowMs ? previous.count + 1 : 1;

      // Map insertion order doubles as a small LRU queue. A burst containing
      // many unique comments therefore cannot retain unbounded key history.
      entries.delete(key);
      entries.set(key, { at, count });
      trimToCapacity();
      return { key, count };
    },
    forget: (key) => {
      entries.delete(key);
    },
    clear: () => {
      entries.clear();
    },
  };
}

/**
 * Floating track text (Simple Live / canvas_danmaku style): content only.
 * Super chat keeps a short SC marker for emphasis.
 */
export function floatingDanmakuText(event: DanmakuEvent): string {
  const content = event.content.trim();
  if (!content) return "";
  if (event.kind === "super_chat") {
    return content.startsWith("【SC】") ? content : `【SC】${content}`;
  }
  if (event.kind === "gift" || event.kind === "enter") {
    return content;
  }
  return content;
}

export function shouldShowValidatedOnCanvas(event: DanmakuEvent, filterGifts = false): boolean {
  if (!shouldShowValidatedInDanmakuPanel(event, filterGifts)) return false;
  if (event.kind === "system") return false;
  return true;
}

export function shouldShowOnCanvas(event: unknown, filterGifts = false): event is DanmakuEvent {
  return isDanmakuEvent(event) && shouldShowValidatedOnCanvas(event, filterGifts);
}
