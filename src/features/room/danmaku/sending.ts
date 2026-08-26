import type { SiteId } from "@/shared/types/live";

export type DanmakuSendSiteId = "bilibili" | "douyu" | "huya";

export type DanmakuSendStatus = {
  send_enabled: boolean;
  cookie_ready: boolean;
  available: boolean;
  message: string;
};

export type DanmakuSendConfig = {
  /** 报告本地账号/授权状态的 Tauri 命令。 */
  statusCommand: string;
  /** 提交一条用户发起的普通文本消息的 Tauri 命令。 */
  sendCommand: string;
  siteLabel: string;
  /** 浏览器兼容的上限；Rust 接口会再次校验。 */
  maxLength: number;
  supportsNativeBilibiliEmoji?: boolean;
};

const SEND_CONFIGS: Record<DanmakuSendSiteId, DanmakuSendConfig> = {
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
  return isDanmakuSendSite(siteId) ? SEND_CONFIGS[siteId] : null;
}

export function isDanmakuSendSite(siteId?: SiteId): siteId is DanmakuSendSiteId {
  return siteId === "bilibili" || siteId === "douyu" || siteId === "huya";
}
