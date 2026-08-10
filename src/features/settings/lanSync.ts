export const LAN_SYNC_CODE_LENGTH = 6;

export type LanSyncSessionState = "waiting" | "completed" | "expired" | "locked" | "stopped";

export type LanSyncSessionInfo = {
  addresses: string[];
  code: string;
  expires_at: number;
  status: LanSyncSessionState;
};

export type ProfileImportResult = {
  follows: number;
  iptv_favorites?: number;
  iptv_favorite_groups?: number;
  tags: number;
  history: number;
  settings: boolean;
};

export function normalizeLanSyncCode(value: string): string {
  return value.replace(/\D/g, "").slice(0, LAN_SYNC_CODE_LENGTH);
}

export function validateLanSyncReceiver(address: string, code: string): string | null {
  if (!address.trim()) return "请输入发送设备显示的同步地址";
  if (!/^\d{6}$/.test(code.trim())) return "请输入 6 位数字配对码";
  return null;
}

export function lanSyncCountdown(expiresAt: number, now: number): string {
  const remainingSeconds = Math.max(0, Math.ceil((expiresAt - now) / 1_000));
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function profileImportSummary(result: ProfileImportResult): string {
  return `已合并 ${result.follows} 个主播关注、${result.iptv_favorites ?? 0} 个 IPTV 关注、${result.iptv_favorite_groups ?? 0} 个 IPTV 分组、${result.tags} 个标签和 ${result.history} 条历史记录。`;
}
