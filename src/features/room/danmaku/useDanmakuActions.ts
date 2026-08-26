import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { invokeCmd } from "@/shared/api/tauri";
import { copyText } from "@/shared/clipboard";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import type { DanmakuEvent, DanmakuFavoriteItem, SiteId } from "@/shared/types/live";
import { getDanmakuSendConfig } from "./sending";

/**
 * 单条评论共享的复制/收藏/+1 行为。侧栏列表与悬浮 DOM 层呈现同样三个操作，
 * 必须在可用性规则、乐观缓存更新和状态文案上保持一致。
 */

export type DanmakuActionStatus =
  | "copied"
  | "copy-failed"
  | "favorited"
  | "favorite-failed"
  | "sent"
  | "send-failed"
  | null;

/**
 * 在文本进入剪贴板或用户触发的 +1 请求之前先归一化。+1 操作发送的就是这份
 * 确切内容；它不会附加字面的"+1"。
 */
export function formatDanmakuClipboardText(content: string): string {
  return content.trim();
}

/**
 * 异步 Clipboard API 在较旧 WebView、非安全源或权限被拒时可能不可用。
 * 回退到传统命令，同时尽可能保留用户的选区与焦点。
 */
export async function copyDanmakuText(text: string): Promise<boolean> {
  return copyText(text);
}

export function danmakuActionStatusMessage(status: DanmakuActionStatus): string | null {
  switch (status) {
    case "copied":
      return "已复制弹幕内容";
    case "copy-failed":
      return "复制失败，请手动选择内容";
    case "favorited":
      return "已收藏";
    case "favorite-failed":
      return "收藏失败，请稍后重试";
    case "sent":
      return "已发送相同的弹幕";
    case "send-failed":
      return "发送失败，请检查账号登录状态或直播间限制";
    default:
      return null;
  }
}

export function isDanmakuActionFailure(status: DanmakuActionStatus): boolean {
  return status === "copy-failed" || status === "favorite-failed" || status === "send-failed";
}

export type DanmakuActionsParams = {
  /** 已去除首尾空白的评论正文。为空时禁用全部操作。 */
  message: string;
  /** 收藏与 +1 只对普通聊天提供。 */
  eventKind: DanmakuEvent["kind"];
  siteId?: SiteId;
  roomId?: string;
  roomTitle?: string;
  roomUserName?: string;
};

export type DanmakuActions = {
  status: DanmakuActionStatus;
  statusMessage: string | null;
  failed: boolean;
  resetStatus: () => void;
  copy: () => Promise<void>;
  favorite: () => Promise<void>;
  repeat: () => Promise<void>;
  canFavorite: boolean;
  favoriting: boolean;
  favoriteLabel: string;
  canRepeat: boolean;
  sending: boolean;
  repeatLabel: string;
};

export function useDanmakuActions({
  message,
  eventKind,
  siteId,
  roomId,
  roomTitle,
  roomUserName,
}: DanmakuActionsParams): DanmakuActions {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<DanmakuActionStatus>(null);
  const [favoriting, setFavoriting] = useState(false);
  const [sending, setSending] = useState(false);
  const danmakuSendEnabled = useSettingsStore((s) => s.danmakuSendEnabled);
  const danmakuSendPending = useSettingsStore((s) => s.danmakuSendPending);
  const sendConfig = getDanmakuSendConfig(siteId);
  const isChat = eventKind === "chat" && message.length > 0;
  const canRepeat =
    isChat && Boolean(sendConfig && roomId && danmakuSendEnabled && !danmakuSendPending);
  const canFavorite = isChat && Boolean(siteId);
  const repeatLabel = canRepeat
    ? "发送相同的弹幕（+1）"
    : !sendConfig
      ? "当前平台暂不支持发送弹幕"
      : danmakuSendPending
        ? "正在同步发送权限…"
        : !danmakuSendEnabled
          ? "请先在账号设置启用发送功能"
          : "发送相同的弹幕（+1）";
  const favoriteLabel = canFavorite ? "收藏弹幕" : "当前房间暂不支持收藏";

  const resetStatus = useCallback(() => setStatus(null), []);

  const copy = useCallback(async () => {
    if (!message) return;
    const copied = await copyDanmakuText(message);
    setStatus(copied ? "copied" : "copy-failed");
  }, [message]);

  const favorite = useCallback(async () => {
    if (!siteId || !message || favoriting) return;
    setFavoriting(true);
    setStatus(null);
    const favoriteQueryKey = ["danmaku-favorites", siteId] as const;
    try {
      await invokeCmd<void>("danmaku_favorite_add", { siteId, content: message });
      queryClient.setQueryData<DanmakuFavoriteItem[]>(favoriteQueryKey, (current) => [
        { site_id: siteId, content: message, added_at: Date.now() },
        ...(current ?? []).filter((item) => item.content !== message),
      ]);
      void queryClient.invalidateQueries({ queryKey: favoriteQueryKey });
      setStatus("favorited");
    } catch {
      setStatus("favorite-failed");
    } finally {
      setFavoriting(false);
    }
  }, [favoriting, message, queryClient, siteId]);

  const repeat = useCallback(async () => {
    if (!sendConfig || !roomId || !message || sending) return;
    setSending(true);
    setStatus(null);
    try {
      await invokeCmd<void>(sendConfig.sendCommand, {
        roomId,
        message,
        roomTitle,
        roomUserName,
      });
      setStatus("sent");
    } catch {
      setStatus("send-failed");
    } finally {
      setSending(false);
    }
  }, [message, roomId, roomTitle, roomUserName, sendConfig, sending]);

  return {
    status,
    statusMessage: danmakuActionStatusMessage(status),
    failed: isDanmakuActionFailure(status),
    resetStatus,
    copy,
    favorite,
    repeat,
    canFavorite,
    favoriting,
    favoriteLabel,
    canRepeat,
    sending,
    repeatLabel,
  };
}
