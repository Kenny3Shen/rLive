import { onBackButtonPress } from "@tauri-apps/api/app";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { getClientPlatform } from "@/shared/clientPlatform";
import { CATEGORY_PARAM } from "@/features/category/categorySelection";

/**
 * 可取消的应用内事件，在 Android 返回键进入路由导航之前触发。
 * 浮层（房间菜单、卡片长按抽屉等）监听它，使一次 Back 先关闭当前
 * 活动表面再离开页面或退回系统桌面。
 */
export const ANDROID_BACK_EVENT = "rlive:android-back";

/** 底部导航根路由，Back 在它们上面的语义是回到系统桌面。 */
// 历史不在其中：移动端底栏没有历史目的地，它只从「设置 → 观看记录」钻入，
// 一次 Back 应该回到那个入口。
const ANDROID_HOME_TAB_PATHS = new Set(["/", "/follow", "/iptv", "/settings"]);

type AndroidBackRegistrationInput = {
  userAgent: string;
  tauriRuntime: boolean;
};

export function hasBrowserHistoryEntry(state: unknown): boolean {
  if (!state || typeof state !== "object") return false;
  const index = Reflect.get(state, "idx");
  return typeof index === "number" && index > 0;
}

/**
 * 底部导航根路由。带查询参数钻进二级状态的表面不算根路由：设置二级页
 * （非空 `section`）与首页的分区态（非空 `cat`）都按历史回退，与房间、
 * 搜索等钻入路由一致。
 *
 * 首页分区态尤其不能算根路由 —— 分类页合并进首页后，「浏览某个分区」不再有
 * 自己的 pathname，只体现为 `/?cat=...`。若只看 pathname，用户在分区里按一次
 * Back 会直接退回系统桌面，而不是回到推荐流。
 */
export function isAndroidHomeTabRoot(pathname: string, search: string): boolean {
  if (pathname === "/settings" && hasMeaningfulParam(search, "section")) return false;
  if (pathname === "/" && hasMeaningfulParam(search, CATEGORY_PARAM)) return false;
  return ANDROID_HOME_TAB_PATHS.has(pathname);
}

/** 参数存在且不只是空白。空值等同于未钻入，仍按根路由处理。 */
function hasMeaningfulParam(search: string, name: string): boolean {
  const value = new URLSearchParams(search).get(name);
  return value != null && value.trim() !== "";
}

export function shouldRegisterAndroidBackHandler({
  userAgent,
  tauriRuntime,
}: AndroidBackRegistrationInput): boolean {
  return tauriRuntime && getClientPlatform({ userAgent, maxTouchPoints: 0 }) === "android";
}

/** 当某个浮层消费了系统 Back 操作时返回 true。 */
export function dispatchAndroidBackEvent(target: EventTarget): boolean {
  const event = new Event(ANDROID_BACK_EVENT, { cancelable: true });
  return !target.dispatchEvent(event);
}

/**
 * 把 Android 原生 Back 桥接到页面。返回链自上而下：视频全屏退出（原生）→
 * 本监听器 → `ANDROID_BACK_EVENT`（浮层先关闭）→ 底部导航根路由上经
 * `android_move_task_to_back` 退回系统桌面，其余路由按浏览器历史回退或
 * 回到首页。
 *
 * 根路由退回桌面的语义原先硬编码在 MainActivity 的 homeBackCallback
 * （原生 `moveTaskToBack`），但它先于页面事件运行，根路由上的抽屉等浮层
 * 永远收不到返回事件；收敛到页面侧后所有路由上的浮层都能先消费 Back。
 */
export function AndroidBackNavigator() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  // 返回事件可能在任意路由上到达；用最新位置应答，避免每次路由变化都
  // 注销重注册监听器（异步间隙会让 Back 落到 WebView 原生历史回退）。
  const locationRef = useRef({ pathname, search });
  locationRef.current = { pathname, search };

  useEffect(() => {
    if (
      !shouldRegisterAndroidBackHandler({
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

      const location = locationRef.current;
      if (isAndroidHomeTabRoot(location.pathname, location.search)) {
        // 根路由上没有浮层可关：回到系统桌面而不是回退到上一个页签。
        // 失败时保持安静 —— 此时这次 Back 只是没有效果。
        void invoke("android_move_task_to_back").catch(() => undefined);
        return;
      }

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
    // navigate 引用稳定（react-router），监听器只在挂载时注册一次。
  }, [navigate]);

  return null;
}
