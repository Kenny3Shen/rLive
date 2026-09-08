import { useLayoutEffect, type RefObject } from "react";

export function useVideoDanmakuTopInset(
  stageRef: RefObject<HTMLElement | null>,
  hudRef: RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  // 由父级播放页调用，确保弹幕和 HUD 的同级节点都已挂载。
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const hud = hudRef.current;
    if (!enabled || !stage || !hud) return;

    // 只避让画面内的 HUD；系统安全区由画面外层负责，透明隐藏时仍保留边界。
    const updateTopInset = () => {
      stage.style.setProperty(
        "--video-danmaku-top",
        `${Math.ceil(hud.getBoundingClientRect().height)}px`,
      );
    };
    updateTopInset();
    const observer = new ResizeObserver(updateTopInset);
    observer.observe(hud, { box: "border-box" });
    return () => {
      observer.disconnect();
      stage.style.removeProperty("--video-danmaku-top");
    };
  }, [enabled, hudRef, stageRef]);
}
