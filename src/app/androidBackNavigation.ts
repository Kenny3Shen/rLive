import { onBackButtonPress } from "@tauri-apps/api/app";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { getClientPlatform } from "@/shared/clientPlatform";
import { CATEGORY_PARAM } from "@/features/category/categorySelection";

/**
 * 可取消的应用内事件，在 Android 返回键进入路由导航之前触发。
 * 非 base-ui 的自绘表面（房间页侧边抽抽屉、页内全屏）监听它，使一次 Back
 * 先关闭当前活动表面再离开页面或退回系统桌面。base-ui 的弹窗类组件不需要
 * 各自监听，统一由 `dismissTopmostPopup` 处理。
 */
export const ANDROID_BACK_EVENT = "rlive:android-back";

/**
 * Back 应当先收起的弹窗类表面。值是 `src/components/ui/` 各包装给 base-ui Popup
 * 的 `data-slot`；打开时 base-ui 在同一个元素上置 `data-open`，退场动画期间换成
 * `data-closed`，因此选择器只命中真正展开的表面。
 *
 * tooltip 不在列表里：它不是用户显式打开的表面，消费一次 Back 只会让返回键看起来失灵。
 */
const DISMISSIBLE_POPUP_SLOTS = [
  "dialog-content",
  "alert-dialog-content",
  "drawer-content",
  "popover-content",
  "select-content",
  "context-menu-content",
] as const;

export const DISMISSIBLE_POPUP_SELECTOR = DISMISSIBLE_POPUP_SLOTS.map(
  (slot) => `[data-slot="${slot}"][data-open]`,
).join(",");

/**
 * 展开的弹窗先吃掉这一次 Back：命中时向 document 发一个合成 Escape，并返回 true。
 *
 * 不逐个组件接线而是借用 Escape：base-ui 的 `useDismiss` 已经在 document 上监听
 * keydown，且只有最内层活动的弹窗开着 `escapeKey`（嵌套时父层置 `escapeKey: isTopmost`）。
 * 因此一次分发只关最上层的一层，层级以及焦点归还都沿用组件库自己的语义，
 * 新增弹窗也不需要再拄一遍监听器。
 *
 * 事件必须 `bubbles: false`：房间页在 window 上报了三个冒泡阶段的 Escape 监听器
 * （原生全屏退出、网页全屏退出、侧边抽屉）。冒泡的合成事件会一并触发它们，
 * 使一次 Back 既关弹窗又退出全屏；不冒泡时 document 上的监听器照旧命中
 * （目标自身的监听器不依赖冒泡），window 却只能在捕获阶段看到它。
 */
export function dismissTopmostPopup(doc: Document): boolean {
  if (!doc.querySelector(DISMISSIBLE_POPUP_SELECTOR)) return false;
  doc.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: false }));
  return true;
}

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
 * 本监听器 → 展开的 base-ui 弹窗（`dismissTopmostPopup`）→ `ANDROID_BACK_EVENT`
 * （自绘浮层先关闭）→ 底部导航根路由上经 `android_move_task_to_back` 退回系统桌面，
 * 其余路由按浏览器历史回退或回到首页。
 *
 * 弹窗排在自绘浮层之前：弹窗是最上层的模态表面，一次 Back 只应该关掉它。若先跑
 * `ANDROID_BACK_EVENT`，全屏页上的监听器会无条件消费这一次 Back，弹窗却还开着。
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
      if (dismissTopmostPopup(document)) return;
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
