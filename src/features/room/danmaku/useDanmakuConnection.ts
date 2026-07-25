import { useEffect, useRef, useState } from "react";
import { invokeCmd } from "@/shared/api/tauri";
import type { SiteId } from "@/shared/types/live";
import { nextDanmakuConnectionEpoch } from "./connectionEpoch";

const DANMAKU_ENABLED_SITES = new Set<SiteId>(["bilibili", "douyu", "huya", "douyin"]);

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
  const connectionEpochRef = useRef(0);

  // Fence every route change before waiting for the next room-detail query.
  // The backend compares this epoch before installing a websocket task, so a
  // slow command for the previous room cannot reconnect after a newer route.
  useEffect(() => {
    const connectionEpoch = nextDanmakuConnectionEpoch();
    connectionEpochRef.current = connectionEpoch;
    setActive(false);
    setStatusText(null);
    void invokeCmd("danmaku_disconnect", { connectionEpoch }).catch(() => {});
  }, [siteId, roomId]);

  // Leaving RoomPage also gets a newer epoch. This invalidates any in-flight
  // metadata fetch that reaches the backend after the component has gone.
  useEffect(() => {
    return () => {
      const connectionEpoch = nextDanmakuConnectionEpoch();
      connectionEpochRef.current = connectionEpoch;
      void invokeCmd("danmaku_disconnect", { connectionEpoch }).catch(() => {});
    };
  }, []);

  useEffect(() => {
    const connectionEpoch = connectionEpochRef.current;
    if (!enabled || !siteId || !roomId || !detailRoomId) {
      setActive(false);
      setStatusText(null);
      if (!enabled || !siteId || !roomId) {
        void invokeCmd("danmaku_disconnect", { connectionEpoch }).catch(() => {});
      }
      return;
    }
    if (!DANMAKU_ENABLED_SITES.has(siteId)) {
      setActive(false);
      setStatusText("当前平台暂不支持实时弹幕");
      void invokeCmd("danmaku_disconnect", { connectionEpoch }).catch(() => {});
      return;
    }
    let cancelled = false;
    setStatusText("正在连接弹幕服务器…");
    setActive(false);
    void invokeCmd("danmaku_connect", { siteId, roomId, connectionEpoch })
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
