import { useLayoutEffect, type RefObject } from "react";

export function applyPlayerChromeVisibility(
  elements: readonly (HTMLElement | null | undefined)[],
  visible: boolean,
): void {
  for (const element of elements) {
    if (!element) continue;
    element.dataset.visible = String(visible);
    element.setAttribute("aria-hidden", String(!visible));
    element.toggleAttribute("inert", !visible);
  }
}

/** 仅在提交后同步 DOM，避免渲染读取可变 ref，也不为显隐增加 React 渲染。 */
export function usePlayerChromeVisibility({
  controlsRef,
  hudRef,
  visibleRef,
  lockRef,
  locked = false,
  enabled = true,
}: {
  controlsRef: RefObject<HTMLElement | null>;
  hudRef: RefObject<HTMLElement | null>;
  visibleRef: RefObject<boolean>;
  lockRef?: RefObject<HTMLElement | null>;
  locked?: boolean;
  enabled?: boolean;
}): void {
  useLayoutEffect(() => {
    if (!enabled) return;
    applyPlayerChromeVisibility(
      [controlsRef.current, hudRef.current],
      visibleRef.current && !locked,
    );
    applyPlayerChromeVisibility([lockRef?.current], visibleRef.current);
  });
}
