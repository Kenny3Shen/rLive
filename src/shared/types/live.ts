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

export type PlaybackProtocol = "flv" | "hls" | "mpeg_ts" | "native" | "unknown";

export type TwitchAdRecovery = {
  login: string;
  selector: string;
  target_width: number;
  target_height: number;
  target_frame_rate_milli: number;
};

/** Structured playback candidate returned by the native site adapter. */
export type PlayUrl = {
  /** Stable within a quality payload; never contains a signed URL or request headers. */
  source_id?: string;
  /** Safe user-facing name supplied by the site adapter. */
  label?: string;
  /** Explicit protocol. Optional only for compatibility with older backends and tests. */
  protocol?: PlaybackProtocol;
  /** Lower values retain the platform's preferred ordering. */
  priority?: number;
  url: string;
  headers: Record<string, string>;
  /** Native-only context used to replace Twitch ad playlists behind the local proxy. */
  twitch_ad_recovery?: TwitchAdRecovery;
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
  /** Room cover captured when the room was opened; empty for older records. */
  cover?: string;
  watched_at: number;
};

/** A confirmed, reusable outgoing message stored only on this device. */
export type DanmakuSendHistoryItem = {
  site_id: SiteId;
  content: string;
  /** Room the message was sent to; empty for records written before 0.15.2. */
  room_id?: string;
  /** Room title captured at send time; empty when it could not be resolved. */
  room_title?: string;
  /** Streamer name captured at send time; empty for legacy records. */
  room_user_name?: string;
  sent_at: number;
};

/** An outgoing message intentionally saved for reuse on one platform. */
export type DanmakuFavoriteItem = {
  site_id: SiteId;
  content: string;
  added_at: number;
};

export type CaptionTranslationLanguage =
  | "auto"
  | "ar"
  | "de"
  | "en"
  | "es"
  | "fr"
  | "hi"
  | "id"
  | "it"
  | "ja"
  | "ko"
  | "ms"
  | "nl"
  | "pl"
  | "pt"
  | "ru"
  | "th"
  | "tr"
  | "uk"
  | "vi"
  | "zh-CN"
  | "zh-TW";

export type CaptionTranslationSourceLanguage = CaptionTranslationLanguage;

export type AppSettings = {
  theme: "system" | "light" | "dark";
  /** Legacy compatibility field. Runtime and persistence normalize it to `full`. */
  motion_mode?: string;
  default_site: string;
  proxy: string | null;
  danmaku_opacity: number;
  danmaku_font_size: number;
  danmaku_area: number;
  danmaku_line_count: number;
  danmaku_font_weight: number;
  danmaku_filter_gifts: boolean;
  /** Merge window for duplicate chat in seconds, 0..=30; 0 disables merging. */
  danmaku_merge_window_seconds?: number;
  /** Show supported-platform Super Chat cards over the player. */
  super_chat_enabled?: boolean;
  danmaku_shield_words: string[];
  /** Preferred starting clarity: high | mid | low (Simple Live qualityLevel). */
  quality_level?: "high" | "mid" | "low";
  /** Probe multiple live sources locally and use their health for selection/failover. */
  playback_smart_line_selection?: boolean;
  /** Same-protocol xgplayer switchURL path; hard reload remains the fallback. */
  playback_soft_switch_enabled?: boolean;
  /** Legacy compatibility field; sustained stalls no longer trigger automatic switching. */
  playback_stall_auto_switch_enabled?: boolean;
  /** Device-local permission for user-operated single-message senders. */
  danmaku_send_enabled?: boolean;
  /** Device-local consent for downloading and loading the optional ASR model. */
  asr_enabled?: boolean;
  /** Device-local Zipformer provider: auto, cpu, or cuda (Windows CUDA build). */
  asr_provider?: AsrProvider;
  /** Enable silence-based endpoint/VAD rules; defaults to true. */
  asr_vad_enabled?: boolean;
  /** Enable the optional local CT-Transformer punctuation model; defaults to true. */
  asr_punctuation_enabled?: boolean;
  /** Device-local endpoint-level anonymous speaker differentiation. */
  asr_speaker_diarization_enabled?: boolean;
  /** Device-local domain phrases used by Zipformer hotword biasing. */
  asr_hotwords?: string[];
  /** Zipformer PCM chunk interval, persisted under the legacy field name. */
  asr_window_seconds?: number;
  /** Player subtitle font size in CSS pixels. */
  asr_font_size?: number;
  /** Device-local consent for sending committed ASR captions to Google Translate. */
  asr_translation_enabled?: boolean;
  /** Google Translate source language, or auto detection. */
  asr_translation_from?: CaptionTranslationSourceLanguage;
  /** Google Translate target language, or automatic selection. */
  asr_translation_to?: CaptionTranslationLanguage;
  /** Device-local custom IPTV M3U address; excluded from profile import/export. */
  iptv_custom_m3u_url?: string | null;
  /** Legacy settings field kept only for backwards-compatible deserialization. */
  iptv_availability_auto_check?: boolean;
  /** Legacy interval field; the client no longer schedules periodic checks. */
  iptv_availability_auto_check_interval_hours?: number;
  /** Platforms hidden from discovery and room navigation; omitted by legacy settings. */
  disabled_site_ids?: SiteId[];
};

export type AsrProvider = "auto" | "cpu" | "cuda";
