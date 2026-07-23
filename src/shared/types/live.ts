/** Mirrors Rust `SiteId` serde snake_case values. */
export type SiteId = "bilibili" | "huya" | "douyu" | "douyin" | "kuaishou";

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

export type DanmakuKind = "chat" | "gift" | "enter" | "super_chat" | "system";

export type DanmakuEvent = {
  kind: DanmakuKind;
  user: string;
  content: string;
  color: string | null;
  ts: number;
};

export type FollowUser = {
  site_id: SiteId;
  room_id: string;
  user_name: string;
  face: string;
  tag_ids: string[];
  live_status: boolean | null;
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

export type AppSettings = {
  theme: "system" | "light" | "dark";
  default_site: string;
  proxy: string | null;
  danmaku_opacity: number;
  danmaku_font_size: number;
  danmaku_speed: number;
  danmaku_shield_words: string[];
  mpv_path: string | null;
};
