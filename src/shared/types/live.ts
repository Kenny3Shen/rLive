/** 镜像 Rust `SiteId` 的 serde snake_case 取值。 */
export type SiteId = "bilibili" | "huya" | "douyu" | "douyin" | "twitch";

/** 镜像 Rust `commands::site::SiteInfo`。 */
export type SiteInfo = {
  id: SiteId;
  name: string;
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
  /**
   * 该房间此刻是否在播。只有搜索这类同时返回在播与未开播主播的接口才带这个字段；
   * 分类和推荐列表天然只含在播房间，缺省表示「平台未告知」，
   * 不能当成未开播。
   */
  live_status?: boolean | null;
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
  /** 平台提供时，当前直播场次开始的 Unix 毫秒时间戳。 */
  live_started_at?: number | null;
  notice: string;
  url: string;
  /** 播放地址请求所需的、站点特有的不透明负载。 */
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

/** 原生站点适配器返回的结构化播放候选。 */
export type PlayUrl = {
  /** 在同一份画质数据内稳定；绝不包含签名 URL 或请求头。 */
  source_id: string;
  /** 站点适配器提供的、面向用户的安全名称。 */
  label: string;
  /** 原生站点适配器显式选择的传输方式。 */
  protocol: PlaybackProtocol;
  /** 数值越小越保留平台偏好的排序。 */
  priority: number;
  url: string;
  headers: Record<string, string>;
  /** 仅原生使用的上下文，用于在本机代理后面替换 Twitch 广告清单。 */
  twitch_ad_recovery?: TwitchAdRecovery;
};

export type LivePlayQuality = {
  quality: string;
  /** 后续 get_play_urls 所需的数据（因站点而异）；已知时就绪 URL 列表也放这里。 */
  data: unknown;
};

export type RoomListPage = {
  has_more: boolean;
  items: LiveRoomItem[];
};

export type DanmakuKind = "chat" | "gift" | "enter" | "social" | "super_chat" | "system";

/** 随 `super_chat` 事件一起发出的可选 Bilibili Super Chat 元数据。 */
export type SuperChatInfo = {
  id?: string | null;
  price?: number | null;
  background_color?: string | null;
  background_bottom_color?: string | null;
  duration?: number | null;
};

/**
 * 直播聊天协议提供的、安全且有序的富文本片段。Bilibili 用它在文本消息中嵌入
 * 图片表情。
 */
export type DanmakuContentSpan =
  | { type: "text"; text: string }
  | { type: "image"; image_url: string };

export type DanmakuEvent = {
  kind: DanmakuKind;
  user: string;
  /** 后端匹配本地保存的账号 Cookie 之后设置。 */
  is_self?: boolean;
  content: string;
  color: string | null;
  /** 平台托管图片表情的可选有序文本/图片片段。 */
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
  /** 该关注房间开播时自动开始后台录制。 */
  auto_record: boolean;
  live_status: boolean | null;
  /** 已知时，当前直播场次的 Unix 毫秒时间戳。 */
  live_started_at: number | null;
  updated_at: number;
};

export type HistoryItem = {
  site_id: SiteId;
  room_id: string;
  title: string;
  user_name: string;
  /** 打开房间时捕获的封面；不可得时为空。 */
  cover: string;
  watched_at: number;
};

/** 经确认、可复用、仅存于本设备的发送消息。 */
export type DanmakuSendHistoryItem = {
  site_id: SiteId;
  content: string;
  /** 消息发往的房间；不可得时为空。 */
  room_id: string;
  /** 发送时捕获的房间标题；未能解析时为空。 */
  room_title: string;
  /** 发送时捕获的主播名；不可得时为空。 */
  room_user_name: string;
  sent_at: number;
};

/** 刻意保存、供某平台复用的发出消息。 */
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

/**
 * ASS 导出器使用的车道耗尽策略：保留全部弹幕允许重叠、丢弃，
 * 或在延迟预算内平移开始时间。
 */
export type RecordingAssOverflowPolicy = "overlap" | "drop" | "delay";

export type RecordingAssSettings = {
  resolution_width: number;
  resolution_height: number;
  font_name: string;
  font_size: number;
  opacity_percent: number;
  outline: number;
  shadow: number;
  bold: boolean;
  scroll_duration_seconds: number;
  display_area_percent: number;
  overflow_policy: RecordingAssOverflowPolicy;
  /** `delay` 策略应用的平移上限，单位秒。 */
  max_delay_seconds: number;
  merge_window_seconds: number;
  filter_gifts: boolean;
  show_super_chat: boolean;
  shield_rules: string[];
  shield_regex: boolean;
};

export type AppSettings = {
  theme: "system" | "light" | "dark";
  default_site: string;
  proxy: string | null;
  danmaku_opacity: number;
  /** 播放器弹幕描边宽度，CSS 像素，0.5..=2.5。 */
  danmaku_font_stroke: number;
  danmaku_font_size: number;
  /** 滚动弹幕速度，CSS 像素每秒，50..=200。 */
  danmaku_speed: number;
  danmaku_area: number;
  danmaku_filter_gifts: boolean;
  /** 重复聊天的合并窗口秒数，0..=30；0 关闭合并。 */
  danmaku_merge_window_seconds: number;
  /** 在播放器上方显示受支持平台的 Super Chat 卡片。 */
  super_chat_enabled: boolean;
  danmaku_shield_words: string[];
  /** 按展示昵称屏蔽的用户，聊天列表与飘屏共用。 */
  danmaku_blocked_users: string[];
  /** 偏好的起始清晰度：high | mid | low。 */
  quality_level: "high" | "mid" | "low";
  /** 同协议 xgplayer switchURL 路径；硬刷新仍是兜底。 */
  playback_soft_switch_enabled: boolean;
  /** 悬停浏览页直播间卡片时播放静音直播预览。 */
  room_card_preview_enabled: boolean;
  /** 用户手动发送单条消息功能的设备本地权限开关。 */
  danmaku_send_enabled: boolean;
  /** 下载并加载可选 ASR 模型的设备本地同意开关。 */
  asr_enabled: boolean;
  /** 设备本地 Zipformer provider：auto、cpu 或 cuda（Windows CUDA 构建）。 */
  asr_provider: AsrProvider;
  /** 启用基于静音的端点/VAD 规则；默认 true。 */
  asr_vad_enabled: boolean;
  /** 启用可选的本地 CT-Transformer 标点模型；默认 true。 */
  asr_punctuation_enabled: boolean;
  /** 设备本地的端点级匿名说话人区分。 */
  asr_speaker_diarization_enabled: boolean;
  /** Zipformer 热词偏置使用的设备本地领域短语。 */
  asr_hotwords: string[];
  /** Zipformer PCM 分片间隔（秒）。 */
  asr_window_seconds: number;
  /** 播放器字幕字号（CSS 像素）。 */
  asr_font_size: number;
  /** 把定稿 ASR 字幕发送至 Google 翻译的设备本地同意开关。 */
  asr_translation_enabled: boolean;
  /** Google 翻译源语言，auto 表示自动检测。 */
  asr_translation_from: CaptionTranslationSourceLanguage;
  /** Google 翻译目标语言，或自动选择。 */
  asr_translation_to: CaptionTranslationLanguage;
  /** 设备本地自定义 IPTV M3U 地址；排除在配置导入/导出之外。 */
  iptv_custom_m3u_url: string | null;
  /** 打开录制选项时默认包含直播间弹幕伴生文件。 */
  recording_include_danmaku: boolean;
  /** FFmpeg 录制按分钟大小分卷自动收尾并继续；0 关闭。 */
  recording_auto_split_minutes: number;
  /** FFmpeg 网络读写超时秒数，3..=60。 */
  ffmpeg_rw_timeout_seconds: number;
  /** FFmpeg 重连最大延迟秒数，1..=60。 */
  ffmpeg_reconnect_delay_max_seconds: number;
  /** 失败 HLS 分片的重试次数，0..=20。 */
  ffmpeg_hls_segment_retry_count: number;
  /** 录制 ASS 导出的独立排版、外观与过滤设置。 */
  recording_ass: RecordingAssSettings;
  /** 从发现页与房间导航隐藏的平台。 */
  disabled_site_ids: SiteId[];
};

export type AsrProvider = "auto" | "cpu" | "cuda";
