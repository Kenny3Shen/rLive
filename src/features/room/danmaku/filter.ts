import type { DanmakuEvent } from "@/shared/types/live";

/** Shared shield-word filter for list + canvas. */
export function isShielded(
  event: DanmakuEvent,
  shieldWords: string[],
): boolean {
  if (event.kind === "system") return false;
  const lower = (event.content || "").toLowerCase();
  if (!lower) return true;
  return shieldWords
    .map((w) => w.toLowerCase())
    .filter(Boolean)
    .some((w) => lower.includes(w));
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
  if (!event.content?.trim()) return false;
  if (event.kind === "system") return false;
  return true;
}
