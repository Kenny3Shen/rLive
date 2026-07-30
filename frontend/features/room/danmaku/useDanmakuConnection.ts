import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invokeCmd } from "@/shared/api/tauri";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import type { SiteId } from "@/shared/types/live";
import { nextDanmakuConnectionEpoch, nextDanmakuConnectionFence } from "./connectionEpoch";
import { clearExpectedDanmakuConnectionEpoch, setExpectedDanmakuConnectionEpoch } from "./eventBus";

const DANMAKU_ENABLED_SITES = new Set<SiteId>(["bilibili", "douyu", "huya", "douyin", "twitch"]);

function errMessage(e: unknown): string {
  if (typeof e === "object" && e && "message" in e) {
    return String((e as { message: string }).message);
  }
  return String(e ?? "未知错误");
}

/**
 * Connects the room danmaku WS while mounted; surfaces status text.
 * Site loops own their protocol-specific reconnect behavior (Bilibili
 * refreshes its token and rotates gateways); this hook only fences route
 * changes so an old room can never revive after a direct switch.
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
  // The revision carries no Cookie data. Reconnecting is enough for Rust to
  // rebuild the backend-only identity matcher from the newly saved account.
  const danmakuCookieRevision = useSettingsStore((s) => s.danmakuCookieRevision);

  // Fence every route change before waiting for the next room-detail query.
  // The stop and the replacement connection deliberately use *different*
  // epochs: Tauri IPC is asynchronous, so a delayed same-epoch stop could
  // otherwise arrive after the new websocket was installed and abort it.
  useLayoutEffect(() => {
    const { disconnectEpoch, connectionEpoch } = nextDanmakuConnectionFence();
    connectionEpochRef.current = connectionEpoch;
    setExpectedDanmakuConnectionEpoch(connectionEpoch);
    setActive(false);
    setStatusText(null);
    void invokeCmd("danmaku_disconnect", { connectionEpoch: disconnectEpoch }).catch(() => {});
    return () => {
      clearExpectedDanmakuConnectionEpoch(connectionEpoch);
      // A layout cleanup runs before a replacement RoomPage's layout effect.
      // Its newer epoch also fences an in-flight room-detail fetch on final
      // unmount, without ever sharing the replacement connection's epoch.
      const closingEpoch = nextDanmakuConnectionEpoch();
      connectionEpochRef.current = closingEpoch;
      void invokeCmd("danmaku_disconnect", { connectionEpoch: closingEpoch }).catch(() => {});
    };
  }, [siteId, roomId, danmakuCookieRevision]);

  useEffect(() => {
    const connectionEpoch = connectionEpochRef.current;
    if (!enabled || !siteId || !roomId || !detailRoomId) {
      setActive(false);
      setStatusText(null);
      return;
    }
    if (!DANMAKU_ENABLED_SITES.has(siteId)) {
      setActive(false);
      setStatusText("当前平台暂不支持实时弹幕");
      return;
    }
    let cancelled = false;
    setStatusText("正在连接弹幕服务器…");
    setActive(false);
    void invokeCmd("danmaku_connect", { siteId, roomId, connectionEpoch })
      .then(() => {
        if (!cancelled && connectionEpochRef.current === connectionEpoch) {
          setStatusText(null);
          setActive(true);
        }
      })
      .catch((e) => {
        if (!cancelled && connectionEpochRef.current === connectionEpoch) {
          setStatusText(`弹幕连接失败：${errMessage(e)}`);
          setActive(false);
        }
      });
    return () => {
      cancelled = true;
      setActive(false);
    };
  }, [enabled, siteId, roomId, detailRoomId, danmakuCookieRevision]);

  return { statusText, active };
}
