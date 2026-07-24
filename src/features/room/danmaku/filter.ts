import type { DanmakuEvent } from "@/shared/types/live";

function normalizedShieldWords(shieldWords: readonly string[]): string[] {
  return shieldWords.map((word) => word.trim().toLowerCase()).filter(Boolean);
}

function matchesShieldWords(event: DanmakuEvent, shieldWords: readonly string[]): boolean {
  if (event.kind === "system") return false;
  const lower = (event.content || "").toLowerCase();
  if (!lower) return true;
  return shieldWords.some((word) => lower.includes(word));
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
export function shouldShowInDanmakuPanel(event: DanmakuEvent): boolean {
  return Boolean(event.content?.trim()) && event.kind !== "enter";
}

/**
 * Returns a lightweight stateful matcher for immediately repeated chat lines.
 * It deliberately ignores gifts and SC, which carry their own semantic data
 * and have independent de-duplication rules.
 */
export function createRepeatMatcher(
  enabled: boolean,
  windowMs = 5_000,
): (event: DanmakuEvent) => boolean {
  let previousKey = "";
  let previousAt = 0;

  return (event) => {
    if (!enabled || event.kind !== "chat") return false;
    const timestamp = Number.isFinite(event.ts) ? event.ts : Date.now();
    const key = `${event.user}\u0000${event.content.trim()}`;
    const isRepeat =
      key === previousKey && timestamp - previousAt >= 0 && timestamp - previousAt <= windowMs;
    previousKey = key;
    previousAt = timestamp;
    return isRepeat;
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

export function shouldShowOnCanvas(event: DanmakuEvent): boolean {
  if (!shouldShowInDanmakuPanel(event)) return false;
  if (event.kind === "system") return false;
  return true;
}
