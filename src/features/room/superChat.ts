import type { DanmakuEvent, SiteId, SuperChatInfo } from "@/shared/types/live";

export const MAX_SUPER_CHAT_ITEMS = 80;
export const MAX_BUFFERED_SUPER_CHATS = 160;
export const MAX_SUPER_CHAT_DEDUPE_KEYS = MAX_SUPER_CHAT_ITEMS + MAX_BUFFERED_SUPER_CHATS;

/** 其直播事件流目前提供已校验 SC 元数据的平台。 */
export function siteSupportsSuperChat(siteId: SiteId | null | undefined): boolean {
  return siteId === "bilibili";
}

export const DEFAULT_SUPER_CHAT_DURATION_MS = 3_000;

/** 只返回已校验的 Bilibili 时长（秒）。 */
export function superChatDurationSeconds(info: SuperChatInfo | null | undefined): number | null {
  const duration = info?.duration;
  if (
    typeof duration !== "number" ||
    !Number.isInteger(duration) ||
    duration < 1 ||
    duration > 86_400
  ) {
    return null;
  }
  return duration;
}

/** 把已校验的 SC 时长转换为毫秒，带安全的旧数据兜底。 */
export function superChatDurationMs(info: SuperChatInfo | null | undefined): number {
  return (superChatDurationSeconds(info) ?? DEFAULT_SUPER_CHAT_DURATION_MS / 1_000) * 1_000;
}

/** 优先使用 Bilibili 的稳定 id；为旧负载保留保守兜底。 */
export function superChatDedupeKey(event: DanmakuEvent): string {
  const messageId = event.super_chat?.id;
  if (typeof messageId === "string" && messageId.trim()) return `id:${messageId.trim()}`;

  const price = typeof event.super_chat?.price === "number" ? event.super_chat.price : "";
  const duration = typeof event.super_chat?.duration === "number" ? event.super_chat.duration : "";
  return `fallback:${event.ts}\u0000${event.user}\u0000${event.content}\u0000${price}\u0000${duration}`;
}
