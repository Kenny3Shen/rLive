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
 * 挂载期间连接房间弹幕 WS；对外暴露状态文本。站点循环拥有各自的协议相关重连
 * 行为（Bilibili 刷新 token 并轮换网关）；本 hook 只做路由变更围栏，
 * 保证直接切换后旧房间绝不可能复活。
 */
export function useDanmakuConnection(opts: {
  siteId: SiteId | undefined;
  roomId: string | undefined;
  /** 房间详情 room_id —— 变化时重连。 */
  detailRoomId?: string;
  enabled?: boolean;
}): { statusText: string | null; active: boolean } {
  const { siteId, roomId, detailRoomId, enabled = true } = opts;
  const [statusText, setStatusText] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const connectionEpochRef = useRef(0);
  // revision 不携带 Cookie 数据。重连足以让 Rust 根据新保存的账号重建
  // 仅存于后端的身份匹配器。
  const danmakuCookieRevision = useSettingsStore((s) => s.danmakuCookieRevision);

  // 在等待下一个房间详情查询之前先为每次路由变更设围栏。停止与替代连接刻意使用
  // *不同* 的 epoch：Tauri IPC 是异步的，同 epoch 的延迟 stop 可能
  // 在新 websocket 安装后才到达并将其中止。
  useLayoutEffect(() => {
    const { disconnectEpoch, connectionEpoch } = nextDanmakuConnectionFence();
    connectionEpochRef.current = connectionEpoch;
    setExpectedDanmakuConnectionEpoch(connectionEpoch);
    setActive(false);
    setStatusText(null);
    void invokeCmd("danmaku_disconnect", { connectionEpoch: disconnectEpoch }).catch(() => {});
    return () => {
      clearExpectedDanmakuConnectionEpoch(connectionEpoch);
      // 布局清理先于替代 RoomPage 的布局副作用运行。其更新的 epoch 同时在最终卸载时
      // 围住在途的房间详情抓取，且绝不与替代连接共用 epoch。
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
