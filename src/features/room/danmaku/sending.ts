import type { SiteId } from "@/shared/types/live";

export type DanmakuSendStatus = {
  send_enabled: boolean;
  cookie_ready: boolean;
  available: boolean;
  message: string;
};

export type DanmakuSendConfig = {
  /** Tauri command that reports the local account / consent state. */
  statusCommand: string;
  /** Tauri command that submits one user-initiated ordinary text message. */
  sendCommand: string;
  siteLabel: string;
  /** Browser-compatible upper bound; the Rust endpoint validates again. */
  maxLength: number;
  supportsNativeBilibiliEmoji?: boolean;
};

const SEND_CONFIGS: Partial<Record<SiteId, DanmakuSendConfig>> = {
  bilibili: {
    statusCommand: "bilibili_danmaku_send_status",
    sendCommand: "bilibili_danmaku_send",
    siteLabel: "B站",
    maxLength: 20,
    supportsNativeBilibiliEmoji: true,
  },
  douyu: {
    statusCommand: "douyu_danmaku_send_status",
    sendCommand: "douyu_danmaku_send",
    siteLabel: "斗鱼",
    maxLength: 100,
  },
  huya: {
    statusCommand: "huya_danmaku_send_status",
    sendCommand: "huya_danmaku_send",
    siteLabel: "虎牙",
    maxLength: 30,
  },
};

export function getDanmakuSendConfig(siteId?: SiteId): DanmakuSendConfig | null {
  return siteId ? (SEND_CONFIGS[siteId] ?? null) : null;
}

export function isDanmakuSendSite(siteId?: SiteId): boolean {
  return getDanmakuSendConfig(siteId) !== null;
}
