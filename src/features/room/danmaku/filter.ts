import type { DanmakuEvent, DanmakuKind } from "@/shared/types/live";

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
    (event.color === null || typeof event.color === "string")
  );
}

const ROOM_ENTER_SUFFIXES = ["进入直播间", "进入了直播间", "进入直播间了"];

/**
 * A few relays encode an entry notice as ordinary chat text instead of the
 * shared `enter` event. Normalize whitespace so both “小明进入直播间” and
 * “小明 进入了直播间” are suppressed consistently after an upstream fallback.
 */
function isRoomEnterNotice(kind: DanmakuKind, content: string): boolean {
  if (kind === "enter") return true;
  // This runs for every chat line. Avoid allocating a whitespace-normalized
  // copy for ordinary messages; all known notices end in this final character.
  if (!content.endsWith("间")) return false;
  if (ROOM_ENTER_SUFFIXES.some((suffix) => content.endsWith(suffix))) return true;
  // Preserve support for relays which insert spaces inside the notice without
  // paying the replace-all cost in the normal high-frequency path.
  if (!/\s/.test(content)) return false;
  const compact = content.replaceAll(/\s+/g, "");
  return ROOM_ENTER_SUFFIXES.some((suffix) => compact.endsWith(suffix));
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
export function shouldShowInDanmakuPanel(
  event: unknown,
  filterGifts = false,
): event is DanmakuEvent {
  if (!isDanmakuEvent(event)) return false;
  const content = event.content.trim();
  return (
    Boolean(content) &&
    !isRoomEnterNotice(event.kind, content) &&
    !(filterGifts && event.kind === "gift")
  );
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

export function shouldShowOnCanvas(event: unknown, filterGifts = false): event is DanmakuEvent {
  if (!shouldShowInDanmakuPanel(event, filterGifts)) return false;
  if (event.kind === "system") return false;
  return true;
}
