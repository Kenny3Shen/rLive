import { useEffect, useState } from "react";
import { invokeCmd } from "@/shared/api/tauri";
import type { SiteId } from "@/shared/types/live";

const DANMAKU_ENABLED_SITES = new Set<SiteId>(["bilibili", "douyu", "huya"]);

function errMessage(e: unknown): string {
  if (typeof e === "object" && e && "message" in e) {
    return String((e as { message: string }).message);
  }
  return String(e ?? "未知错误");
}

/**
 * Connects the room danmaku WS while mounted; surfaces status text.
 * Reconnect with simple backoff when the connection drops is handled by
 * listening for system disconnect events (optional enhancement).
 */
export function useDanmakuConnection(opts: {
  siteId: SiteId | undefined;
  roomId: string | undefined;
  /** Room detail room_id — reconnect when it changes. */
  detailRoomId?: string;
  enabled?: boolean;
}): { statusText: string | null; active: boolean } {
  const { siteId, roomId, detailRoomId, enabled = true } = opts;
  const [statusText, setStatusText] = useState<string | null>(null);
  const [active, setActive] = useState(false);

  // A route change should be able to start the next room immediately. The
  // backend's `danmaku_connect` atomically replaces the active task, so only
  // disconnect here when no next connection is requested or on unmount. Doing
  // it in every dependency cleanup races a new connect IPC call and can abort
  // the freshly-created room connection.
  useEffect(() => {
    return () => {
      void invokeCmd("danmaku_disconnect").catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!enabled || !siteId || !roomId || !detailRoomId) {
      setActive(false);
      setStatusText(null);
      // During a direct room switch, detail is briefly unavailable while the
      // next route fetches. Keep the old task until the next `connect` can
      // atomically replace it; a standalone disconnect here could arrive
      // after that new command and kill the fresh connection.
      if (!siteId || !roomId) {
        void invokeCmd("danmaku_disconnect").catch(() => {});
      }
      return;
    }
    if (!DANMAKU_ENABLED_SITES.has(siteId)) {
      setActive(false);
      setStatusText("当前平台暂不支持实时弹幕");
      void invokeCmd("danmaku_disconnect").catch(() => {});
      return;
    }
    let cancelled = false;
    setStatusText("正在连接弹幕服务器…");
    setActive(false);
    void invokeCmd("danmaku_connect", { siteId, roomId })
      .then(() => {
        if (!cancelled) {
          setStatusText(null);
          setActive(true);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setStatusText(`弹幕连接失败：${errMessage(e)}`);
          setActive(false);
        }
      });
    return () => {
      cancelled = true;
      setActive(false);
    };
  }, [enabled, siteId, roomId, detailRoomId]);

  return { statusText, active };
}
