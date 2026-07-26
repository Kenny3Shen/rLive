import type { DanmakuEvent, SuperChatInfo } from "@/shared/types/live";

export const MAX_SUPER_CHAT_ITEMS = 80;
export const MAX_BUFFERED_SUPER_CHATS = 160;
export const MAX_SUPER_CHATS_PER_FRAME = 24;
export const MAX_SUPER_CHAT_DEDUPE_KEYS = MAX_SUPER_CHAT_ITEMS + MAX_BUFFERED_SUPER_CHATS;

export type SuperChatLine = {
  id: number;
  event: DanmakuEvent;
};

export type SuperChatPalette = {
  /** Safe opaque endpoints for the compact paid-message header. */
  headerStart: string;
  headerEnd: string;
  /** Chosen for the strongest available contrast across both header endpoints. */
  headerForeground: string;
};

const HEX_COLOR = /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i;
const SAFE_CURRENCY = /^[a-z]{3}$/i;
const SUPER_CHAT_AMOUNT_FORMATTER = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 2,
});

/** Bilibili's standard blue tier when a platform omits colour metadata. */
export const DEFAULT_SUPER_CHAT_PALETTE: SuperChatPalette = {
  headerStart: "#2A60B2",
  headerEnd: "#1D4A92",
  headerForeground: "#ffffff",
};

export function safeSuperChatColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const color = value.trim();
  return HEX_COLOR.test(color) ? color : null;
}

function opaqueColor(color: string): string {
  const hex = color.slice(1);
  const full = hex.length <= 4 ? [...hex].map((part) => `${part}${part}`).join("") : hex;
  return `#${full.slice(0, 6)}`;
}

function colorLuminance(color: string): number {
  const full = opaqueColor(color).slice(1);
  const channel = (offset: number) => {
    const value = Number.parseInt(full.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return channel(0) * 0.2126 + channel(2) * 0.7152 + channel(4) * 0.0722;
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(colorLuminance(foreground), colorLuminance(background));
  const darker = Math.min(colorLuminance(foreground), colorLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function paletteForeground(...colors: string[]): string {
  const candidates = ["#ffffff", "#172033"] as const;
  return candidates.reduce((best, candidate) => {
    const candidateContrast = Math.min(...colors.map((color) => contrastRatio(candidate, color)));
    const bestContrast = Math.min(...colors.map((color) => contrastRatio(best, color)));
    return candidateContrast > bestContrast ? candidate : best;
  });
}

/**
 * Returns only style values derived from validated hexadecimal colours. The
 * websocket is external input, so do not pass its raw values to style props.
 */
export function superChatPalette(info: SuperChatInfo | null | undefined): SuperChatPalette | null {
  const start = safeSuperChatColor(info?.background_color);
  if (!start) return null;
  const end = safeSuperChatColor(info?.background_bottom_color) ?? start;
  const headerStart = opaqueColor(start);
  const headerEnd = opaqueColor(end);
  return {
    headerStart,
    headerEnd,
    headerForeground: paletteForeground(headerStart, headerEnd),
  };
}

export function formatSuperChatAmount(info: SuperChatInfo | null | undefined): string | null {
  const price = info?.price;
  if (typeof price !== "number" || !Number.isFinite(price) || price < 0 || price > 1_000_000) {
    return null;
  }

  const formatted = SUPER_CHAT_AMOUNT_FORMATTER.format(price);
  const currency = typeof info?.currency === "string" ? info.currency.trim().toUpperCase() : "";
  switch (currency) {
    case "CNY":
      return `¥${formatted}`;
    case "USD":
      return `$${formatted}`;
    case "EUR":
      return `€${formatted}`;
    case "GBP":
      return `£${formatted}`;
    case "JPY":
      return `¥${formatted}`;
    default:
      // The legacy Bilibili websocket payload does not include a currency;
      // Super Chat prices there are denominated in CNY.
      return SAFE_CURRENCY.test(currency) ? `${currency} ${formatted}` : `¥${formatted}`;
  }
}

export function formatSuperChatDuration(info: SuperChatInfo | null | undefined): string | null {
  const duration = info?.duration;
  if (
    typeof duration !== "number" ||
    !Number.isInteger(duration) ||
    duration < 1 ||
    duration > 86_400
  ) {
    return null;
  }
  if (duration < 60) return `${duration} 秒`;
  const minutes = Math.floor(duration / 60);
  const seconds = duration % 60;
  return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
}

/** Prefer Bilibili's stable id; retain a conservative fallback for older payloads. */
export function superChatDedupeKey(event: DanmakuEvent): string {
  const messageId = event.super_chat?.id;
  if (typeof messageId === "string" && messageId.trim()) return `id:${messageId.trim()}`;

  const price = typeof event.super_chat?.price === "number" ? event.super_chat.price : "";
  const duration = typeof event.super_chat?.duration === "number" ? event.super_chat.duration : "";
  return `fallback:${event.ts}\u0000${event.user}\u0000${event.content}\u0000${price}\u0000${duration}`;
}

export function retainSuperChatItems(
  previous: readonly SuperChatLine[],
  incoming: readonly SuperChatLine[],
  maxItems = MAX_SUPER_CHAT_ITEMS,
): SuperChatLine[] {
  if (incoming.length === 0) return [...previous];
  const next = previous.concat(incoming);
  const limit = Math.max(1, Math.floor(maxItems));
  return next.length > limit ? next.slice(next.length - limit) : next;
}
