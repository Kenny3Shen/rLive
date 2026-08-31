import { useEffect, useRef } from "react";
import { ANDROID_BACK_EVENT } from "@/app/androidBackNavigation";

/**
 * 让 Android 返回键先收起一个应用内浮层，而不是离开当前页面。
 *
 * `AndroidBackNavigator` 把系统 Back 转成可取消的 `ANDROID_BACK_EVENT` 后才做路由
 * 回退，浮层在这里 `preventDefault` 即可消费掉这一次 Back。播放器菜单与卡片长按
 * 抽屉各自内联了同一段监听（见 `useLongPressDrawer`），本 hook 把它收成一处，
 * 新增浮层不必再抄一遍。
 *
 * 回调走 ref：调用方通常直接传 `() => setOpen(false)` 这类内联闭包，
 * 若把它放进依赖数组，每次渲染都会注销重注册监听器 —— 那个异步间隙里到达的 Back
 * 会漏给路由回退。ref 在提交后更新而不是渲染中赋值，因为 Back 只可能由用户交互
 * 触发，那时最近一次渲染早已提交完成。
 */
export function useAndroidBackClose(open: boolean, onClose: () => void): void {
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const closeOnAndroidBack = (event: Event) => {
      event.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener(ANDROID_BACK_EVENT, closeOnAndroidBack);
    return () => window.removeEventListener(ANDROID_BACK_EVENT, closeOnAndroidBack);
  }, [open]);
}
