import { useEffect, useState } from "react";

/**
 * 主指针是否为粗指针（触摸）。
 *
 * 与 `src/styles.css` 的 `touch-wide` variant 同一判据的 JS 侧取值。放在这里而不是
 * 让调用方各自 `matchMedia`：短视频的「控件对齐画面列」（见 `ShortsPage`）只在平板上
 * 生效，桌面（细指针鼠标）保持既有的贴屏幕边布局 —— 两者用同一句话判断，才不会一个
 * 地方按断点、另一个地方按指针类型。
 *
 * 用 `useState` + `change` 监听而不是每次渲染现读：可拆卸的二合一设备能在运行中切换
 * 鼠标/触摸，届时布局也要跟着切。
 */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(() => matches());

  useEffect(() => {
    const mediaQuery = window.matchMedia("(pointer: coarse)");
    const update = () => setCoarse(mediaQuery.matches);
    update();
    mediaQuery.addEventListener("change", update);
    return () => mediaQuery.removeEventListener("change", update);
  }, []);

  return coarse;
}

function matches(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
}
