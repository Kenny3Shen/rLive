import { useEffect, useState } from "react";
import { invokeCmd } from "@/shared/api/tauri";
import type { SiteId } from "@/shared/types/live";

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

  useEffect(() => {
    if (!enabled || !siteId || !roomId || !detailRoomId) {
      setActive(false);
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
      void invokeCmd("danmaku_disconnect").catch(() => {});
    };
  }, [enabled, siteId, roomId, detailRoomId]);

  return { statusText, active };
}
