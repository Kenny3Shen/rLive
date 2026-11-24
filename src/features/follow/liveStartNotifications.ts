import { isTauri } from "@tauri-apps/api/core";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { isSiteId } from "@/shared/siteId";

export const FOLLOW_LIVE_STARTED_EVENT = "follow-live-started";

export type LiveStartNotificationPermission =
  | "granted"
  | "denied"
  | "default"
  | "unavailable"
  | "error";

export type FollowLiveStartedPayload = {
  site_id: string;
  room_id: string;
  user_name: string;
};

/** 只接受后端公开事件本身，拒绝缺字段或未知平台。 */
export function parseFollowLiveStartedPayload(payload: unknown): FollowLiveStartedPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = payload as Record<string, unknown>;
  if (
    !isSiteId(value.site_id) ||
    typeof value.room_id !== "string" ||
    !value.room_id.trim() ||
    typeof value.user_name !== "string" ||
    !value.user_name.trim()
  ) {
    return null;
  }
  return {
    site_id: value.site_id,
    room_id: value.room_id.trim(),
    user_name: value.user_name.trim(),
  };
}

/**
 * 只读取当前授权，不触发权限申请。权限申请仅由设置页中的用户动作调用。
 */
export async function getLiveStartNotificationPermission(): Promise<LiveStartNotificationPermission> {
  if (!isTauri()) return "unavailable";
  if (typeof window === "undefined" || !("Notification" in window)) return "error";

  try {
    if (await isPermissionGranted()) return "granted";
    return window.Notification.permission === "denied" ? "denied" : "default";
  } catch {
    return "error";
  }
}

/**
 * 仅在用户刚刚请求开启通知时调用。已拒绝或不可用的环境不会再次弹窗。
 */
export async function requestLiveStartNotificationPermission(): Promise<LiveStartNotificationPermission> {
  const current = await getLiveStartNotificationPermission();
  if (current !== "default") return current;

  try {
    return (await requestPermission()) === "granted" ? "granted" : "denied";
  } catch {
    return "error";
  }
}

export function sendLiveStartSystemNotification(payload: FollowLiveStartedPayload): void {
  sendNotification({
    title: `${payload.user_name} 开播了`,
    body: "你关注的主播正在直播，返回 rLive 即可观看。",
    extra: {
      site_id: payload.site_id,
      room_id: payload.room_id,
    },
  });
}
