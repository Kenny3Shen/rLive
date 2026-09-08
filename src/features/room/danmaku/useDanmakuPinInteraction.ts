import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { DANMAKU_MENU_ATTR } from "./DanmakuActionMenu";

const PIN_AUTO_RELEASE_MS = 20_000;
const PIN_TAP_MAX_DISTANCE_PX = 14;
const PIN_TAP_MAX_DURATION_MS = 320;
const PIN_CLAIM_WINDOW_MS = 500;

/** 短促且基本不动的按压才是点选，长按与拖动仍交给播放器。 */
export function isDanmakuPinTap(
  deltaX: number,
  deltaY: number,
  durationMs: number,
  maxDistance = PIN_TAP_MAX_DISTANCE_PX,
): boolean {
  return (
    durationMs >= 0 &&
    durationMs <= PIN_TAP_MAX_DURATION_MS &&
    Math.hypot(deltaX, deltaY) <= maxDistance
  );
}

function bulletFromTarget(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>("[data-rlive-danmaku-id]") : null;
}

function isMenuTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(`[${DANMAKU_MENU_ATTR}]`));
}

type DanmakuPinInteractionOptions = {
  hostRef: RefObject<HTMLElement | null>;
  enabled?: boolean;
  tapMaxDistance?: number;
  selectedId: string | null;
  hasBullet: (id: string) => boolean;
  selectBullet: (id: string, element: HTMLElement) => void;
  releaseSelection: () => void;
};

/** 直播与 VOD 共用的点选委托，不干预各自的弹幕调度与播放时钟。 */
export function useDanmakuPinInteraction({
  hostRef,
  enabled = true,
  tapMaxDistance = PIN_TAP_MAX_DISTANCE_PX,
  ...callbacks
}: DanmakuPinInteractionOptions): void {
  const latest = useRef(callbacks);
  useLayoutEffect(() => {
    latest.current = callbacks;
  });

  useEffect(() => {
    if (!enabled) {
      latest.current.releaseSelection();
      return;
    }
    const host = hostRef.current;
    if (!host) return;
    const doc = host.ownerDocument;
    let tap: {
      pointerId: number;
      id: string;
      element: HTMLElement;
      x: number;
      y: number;
      startedAt: number;
    } | null = null;
    let claimedAt = -Infinity;

    const onPointerDown = (event: PointerEvent) => {
      claimedAt = -Infinity;
      tap = null;
      if (!event.isPrimary || event.button !== 0) return;
      if (isMenuTarget(event.target) && host.contains(event.target as Node)) return;
      const element = bulletFromTarget(event.target);
      const id = element?.dataset.rliveDanmakuId;
      if (!element || !host.contains(element) || !id || !latest.current.hasBullet(id)) {
        latest.current.releaseSelection();
        return;
      }
      if (latest.current.selectedId !== id) latest.current.releaseSelection();
      tap = {
        pointerId: event.pointerId,
        id,
        element,
        x: event.clientX,
        y: event.clientY,
        startedAt: event.timeStamp,
      };
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!tap || tap.pointerId !== event.pointerId) return;
      // 已经拖出阈值后即使手指回到起点，也不再将它识别为点按。
      if (!isDanmakuPinTap(event.clientX - tap.x, event.clientY - tap.y, 0, tapMaxDistance))
        tap = null;
    };
    const onPointerUp = (event: PointerEvent) => {
      const press = tap;
      if (!press || press.pointerId !== event.pointerId) return;
      tap = null;
      if (
        event.defaultPrevented ||
        !press.element.isConnected ||
        !latest.current.hasBullet(press.id) ||
        !isDanmakuPinTap(
          event.clientX - press.x,
          event.clientY - press.y,
          event.timeStamp - press.startedAt,
          tapMaxDistance,
        )
      )
        return;
      // 弹幕会在按下与松开之间移动，必须在 document 捕获阶段认领这次点按。
      event.preventDefault();
      claimedAt = event.timeStamp;
      if (latest.current.selectedId === press.id) latest.current.releaseSelection();
      else latest.current.selectBullet(press.id, press.element);
    };
    const onPointerCancel = (event: PointerEvent) => {
      if (tap?.pointerId === event.pointerId) tap = null;
    };
    const swallowClaimedClick = (event: MouseEvent) => {
      if (isMenuTarget(event.target)) return;
      if (event.timeStamp - claimedAt > PIN_CLAIM_WINDOW_MS) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const cancel = () => {
      tap = null;
      claimedAt = -Infinity;
      latest.current.releaseSelection();
    };
    const onVisibilityChange = () => {
      if (doc.hidden) cancel();
    };
    doc.addEventListener("pointerdown", onPointerDown, true);
    doc.addEventListener("pointermove", onPointerMove, true);
    doc.addEventListener("pointerup", onPointerUp, true);
    doc.addEventListener("pointercancel", onPointerCancel, true);
    doc.addEventListener("click", swallowClaimedClick, true);
    doc.addEventListener("dblclick", swallowClaimedClick, true);
    doc.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("blur", cancel);
    return () => {
      doc.removeEventListener("pointerdown", onPointerDown, true);
      doc.removeEventListener("pointermove", onPointerMove, true);
      doc.removeEventListener("pointerup", onPointerUp, true);
      doc.removeEventListener("pointercancel", onPointerCancel, true);
      doc.removeEventListener("click", swallowClaimedClick, true);
      doc.removeEventListener("dblclick", swallowClaimedClick, true);
      doc.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("blur", cancel);
    };
  }, [enabled, hostRef, tapMaxDistance]);

  useEffect(() => {
    if (!callbacks.selectedId) return;
    // 被钉住的 bullet 没有 transitionend，超时释放防止永久占据轨道。
    const timer = window.setTimeout(() => latest.current.releaseSelection(), PIN_AUTO_RELEASE_MS);
    return () => window.clearTimeout(timer);
  }, [callbacks.selectedId]);
}
