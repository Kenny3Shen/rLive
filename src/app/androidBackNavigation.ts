import { onBackButtonPress } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { getClientPlatform } from "@/shared/clientPlatform";

/**
 * 可取消的应用内事件，在 Android 回退到路由导航之前触发。房间内的浮层
 * 监听它，使一次 Back 先关闭当前活动表面再离开房间。
 */
export const ANDROID_BACK_EVENT = "rlive:android-back";

type AndroidBackRegistrationInput = {
  pathname: string;
  userAgent: string;
  tauriRuntime: boolean;
};

export function hasBrowserHistoryEntry(state: unknown): boolean {
  if (!state || typeof state !== "object") return false;
  const index = Reflect.get(state, "idx");
  return typeof index === "number" && index > 0;
}

export function shouldRegisterAndroidBackHandler({
  pathname,
  userAgent,
  tauriRuntime,
}: AndroidBackRegistrationInput): boolean {
  // 不要在根路由上安装监听器。这样 Tauri 的 Android app 插件保留其常规兜底行为，
  // 由系统完成 Activity 的收尾。
  return (
    tauriRuntime &&
    getClientPlatform({ userAgent, maxTouchPoints: 0 }) === "android" &&
    pathname !== "/"
  );
}

/** 当某个房间浮层消费了系统 Back 操作时返回 true。 */
export function dispatchAndroidBackEvent(target: EventTarget): boolean {
  const event = new Event(ANDROID_BACK_EVENT, { cancelable: true });
  return !target.dispatchEvent(event);
}

/**
 * 仅当当前路由确实有去处时，才把 Android 原生 Back 分发桥接到路由器。
 * 浮层组件可以取消上面的自定义事件来取得优先
 * （抽屉、popover 等）。
 */
export function AndroidBackNavigator() {
  const { pathname } = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (
      !shouldRegisterAndroidBackHandler({
        pathname,
        userAgent: navigator.userAgent,
        tauriRuntime: isTauri(),
      })
    ) {
      return;
    }

    let disposed = false;
    let listener: { unregister: () => Promise<void> } | null = null;

    void onBackButtonPress(() => {
      if (dispatchAndroidBackEvent(window)) return;

      if (hasBrowserHistoryEntry(window.history.state)) {
        navigate(-1);
      } else {
        // 直接打开的深链接没有应用内历史记录。让 Back 保持有用，
        // 同时不暴露空的浏览器历史栈。
        navigate("/", { replace: true });
      }
    })
      .then((registered) => {
        if (disposed) {
          void registered.unregister();
          return;
        }
        listener = registered;
      })
      .catch(() => {
        // 浏览器预览和桌面构建不提供这个 Android 插件事件。
        // 它们继续使用各自平台的常规行为。
      });

    return () => {
      disposed = true;
      if (listener) void listener.unregister();
    };
  }, [navigate, pathname]);

  return null;
}
