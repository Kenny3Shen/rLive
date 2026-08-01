/** Mirrors Rust `SiteId` serde snake_case values. */
export type SiteId = "bilibili" | "huya" | "douyu" | "douyin" | "twitch";

/** Mirrors Rust `commands::site::SiteInfo`. */
export type SiteInfo = {
  id: SiteId;
  name: string;
  ready: boolean;
};

export type LiveSubCategory = {
  id: string;
  name: string;
  parent_id: string;
  pic: string | null;
};

export type LiveCategory = {
  id: string;
  name: string;
  children: LiveSubCategory[];
};

export type LiveRoomItem = {
  site_id: SiteId;
  room_id: string;
  title: string;
  cover: string;
  user_name: string;
  online: number;
};

export type LiveRoomDetail = {
  site_id: SiteId;
  room_id: string;
  title: string;
  cover: string;
  user_name: string;
  user_avatar: string;
  online: number;
  status: boolean;
  /** Unix timestamp in milliseconds for the current session, when supplied by the platform. */
  live_started_at?: number | null;
  notice: string;
  url: string;
  /** Opaque site-specific payload needed for play-url requests. */
  raw: unknown;
};

export type PlayUrl = {
  url: string;
  headers: Record<string, string>;
};

export type LivePlayQuality = {
  quality: string;
  /** Data needed later for get_play_urls (site-specific); also list of ready urls if known. */
  data: unknown;
};

export type RoomListPage = {
  has_more: boolean;
  items: LiveRoomItem[];
};

export type DanmakuKind = "chat" | "gift" | "enter" | "social" | "super_chat" | "system";

/** Optional Bilibili Super Chat metadata emitted with `super_chat` events. */
export type SuperChatInfo = {
  id?: string | null;
  price?: number | null;
  currency?: string | null;
  background_color?: string | null;
  background_bottom_color?: string | null;
  avatar_url?: string | null;
  duration?: number | null;
};

/**
 * A safe, ordered rich-content fragment supplied by a live-chat protocol.
 * Bilibili uses this for image emotes embedded in an otherwise text message.
 */
export type DanmakuContentSpan =
  | { type: "text"; text: string }
  | { type: "image"; image_url: string };

export type DanmakuEvent = {
  kind: DanmakuKind;
  user: string;
  /** Set by the backend after matching the locally saved account Cookie. */
  is_self?: boolean;
  content: string;
  color: string | null;
  /** Optional ordered text/image fragments for platform-hosted image emotes. */
  spans?: DanmakuContentSpan[] | null;
  super_chat?: SuperChatInfo | null;
  ts: number;
};

export type FollowUser = {
  site_id: SiteId;
  room_id: string;
  user_name: string;
  face: string;
  tag_ids: string[];
  live_status: boolean | null;
  /** Unix timestamp in milliseconds for the current live session, if known. */
  live_started_at?: number | null;
  updated_at: number;
};

export type HistoryItem = {
  site_id: SiteId;
  room_id: string;
  title: string;
  user_name: string;
  cover?: string;
  watched_at: number;
};

/** A confirmed, reusable outgoing message stored only on this device. */
export type DanmakuSendHistoryItem = {
  site_id: SiteId;
  content: string;
  sent_at: number;
};

/** An outgoing message intentionally saved for reuse on one platform. */
export type DanmakuFavoriteItem = {
  site_id: SiteId;
  content: string;
  added_at: number;
};

export type AppSettings = {
  theme: "system" | "light" | "dark";
  default_site: string;
  proxy: string | null;
  danmaku_opacity: number;
  danmaku_font_size: number;
  danmaku_speed: number;
  danmaku_area: number;
  danmaku_line_count: number;
  danmaku_font_weight: number;
  danmaku_filter_repeats: boolean;
  danmaku_filter_gifts: boolean;
  /** Show supported-platform Super Chat cards over the player. */
  super_chat_enabled?: boolean;
  /** SC card transparency 0.0 ..= 1.0 */
  super_chat_opacity?: number;
  danmaku_shield_words: string[];
  /** Preferred starting clarity: high | mid | low (Simple Live qualityLevel). */
  quality_level?: "high" | "mid" | "low";
  /** Device-local permission for user-operated single-message senders. */
  danmaku_send_enabled?: boolean;
  /** Device-local custom IPTV M3U address; excluded from profile import/export. */
  iptv_custom_m3u_url?: string | null;
  /** Platforms hidden from discovery and room navigation; omitted by legacy settings. */
  disabled_site_ids?: SiteId[];
};
