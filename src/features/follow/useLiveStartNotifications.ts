import { useEffect, useMemo, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { notify } from "@/components/ui/toast";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import {
  FOLLOW_LIVE_STARTED_EVENT,
  getLiveStartNotificationPermission,
  parseFollowLiveStartedPayload,
  sendLiveStartSystemNotification,
} from "./liveStartNotifications";
import { refreshFollows, useFollowStatusRefresh } from "./followRefresh";

function liveStartNotificationsEnabled(): boolean {
  return useSettingsStore.getState().liveStartNotificationsEnabled;
}

/**
 * 全局开播通知运行时。后台状态机由 Rust 负责，前端只驱动共享关注刷新、
 * 校验事件并展示通知，不根据列表差异推导开播状态。
 */
export function useLiveStartNotifications(): void {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const hydrated = useSettingsStore((state) => state.hydratedFromBackend);
  const enabled = useSettingsStore((state) => state.liveStartNotificationsEnabled);
  const tauriRuntime = isTauri();
  const active = hydrated && tauriRuntime && enabled;
  const session = useMemo(() => ({ active }), [active]);
  const [readySession, setReadySession] = useState<object | null>(null);

  useFollowStatusRefresh(active && readySession === session);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;

    void getLiveStartNotificationPermission().then((permission) => {
      if (cancelled || permission === "granted") return;
      if (permission === "denied") {
        notify.error(
          "系统通知权限未授权",
          "开播提醒仍会显示在 rLive 内。请在系统设置中允许 rLive 发送通知。",
        );
      } else if (permission === "default") {
        notify.info(
          "系统通知权限尚未设置",
          "请在「设置 → 直播平台 → 开播通知」中授权，当前只会显示应用内提醒。",
        );
      } else {
        notify.error("无法读取系统通知权限", "应用内开播提醒仍可使用，请稍后重试或检查系统设置。");
      }
    });

    void listen<unknown>(FOLLOW_LIVE_STARTED_EVENT, ({ payload }) => {
      if (cancelled) return;
      const started = parseFollowLiveStartedPayload(payload);
      if (!started || !liveStartNotificationsEnabled()) return;

      void (async () => {
        const permission = await getLiveStartNotificationPermission();
        if (cancelled || !liveStartNotificationsEnabled()) return;

        if (permission === "granted") {
          try {
            sendLiveStartSystemNotification(started);
          } catch {
            // 系统通知失败不应吞掉应用内提醒。
          }
        }
        if (cancelled || !liveStartNotificationsEnabled()) return;

        notify.info(`${started.user_name} 开播了`, "你关注的主播正在直播。", {
          label: "观看",
          onClick: () => {
            if (!cancelled && liveStartNotificationsEnabled()) {
              navigate(`/room/${started.site_id}/${encodeURIComponent(started.room_id)}`);
            }
          },
        });
      })();
    }).then(
      (stop) => {
        if (cancelled) stop();
        else {
          unlisten = stop;
          if (cancelled) {
            stop();
            return;
          }
          // 先完成事件订阅，再立即建立后端权威状态基线；共享刷新仍会去重。
          void refreshFollows(queryClient).catch(() => {});
          setReadySession(session);
        }
      },
      () => {
        if (!cancelled) {
          notify.error("无法监听开播通知", "本次运行中的开播提醒不可用，请重启应用后重试。");
        }
      },
    );

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [active, navigate, queryClient, session]);
}
