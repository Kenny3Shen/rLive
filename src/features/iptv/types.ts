import type { PlaybackProtocol } from "@/shared/types/live";

/** 镜像 Rust 从 M3U 播放列表解析出的 IPTV 频道记录。 */
export type IptvChannel = {
  id: string;
  name: string;
  group: string;
  logo: string | null;
  url: string;
  /** 显式的原生解析结果；`unknown` 表示来源元数据不可识别。 */
  protocol: PlaybackProtocol;
  headers: Record<string, string>;
};
