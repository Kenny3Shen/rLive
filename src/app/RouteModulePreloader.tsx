import { useEffect } from "react";
import { getClientPlatform } from "@/shared/clientPlatform";
import { idleRouteModuleLoadersForPlatform, type RouteModuleLoader } from "./routeModules";

export const ROUTE_PRELOAD_AFTER_LOAD_DELAY_MS = 1_500;
const IDLE_FALLBACK_DELAY_MS = 250;

export type RoutePreloadConnection = {
  saveData?: boolean;
  effectiveType?: string;
};

type IdleCapableWindow = Pick<
  Window,
  "setTimeout" | "clearTimeout" | "addEventListener" | "removeEventListener"
> & {
  requestIdleCallback?: (callback: () => void) => number;
  cancelIdleCallback?: (handle: number) => void;
};

type PreloadDocument = Pick<
  Document,
  "hidden" | "readyState" | "addEventListener" | "removeEventListener"
>;

export function shouldSkipIdleRoutePreloading(
  connection: RoutePreloadConnection | null | undefined,
): boolean {
  return Boolean(
    connection?.saveData ||
    connection?.effectiveType === "slow-2g" ||
    connection?.effectiveType === "2g",
  );
}

export function startIdleRoutePreloading(
  loaders: readonly RouteModuleLoader[],
  idleWindow: IdleCapableWindow = window,
  documentRef: PreloadDocument = document,
): () => void {
  let cancelled = false;
  let loading = false;
  let firstScreenReady = false;
  let nextIndex = 0;
  let loadDelayId: number | null = null;
  let idleCallbackId: number | null = null;
  let idleFallbackId: number | null = null;

  const clearScheduled = () => {
    if (loadDelayId !== null) idleWindow.clearTimeout(loadDelayId);
    if (idleCallbackId !== null) idleWindow.cancelIdleCallback?.(idleCallbackId);
    if (idleFallbackId !== null) idleWindow.clearTimeout(idleFallbackId);
    loadDelayId = null;
    idleCallbackId = null;
    idleFallbackId = null;
  };

  const scheduleNext = () => {
    if (
      cancelled ||
      documentRef.hidden ||
      loading ||
      nextIndex >= loaders.length ||
      idleCallbackId !== null ||
      idleFallbackId !== null
    )
      return;

    const runNext = () => {
      idleCallbackId = null;
      idleFallbackId = null;
      if (cancelled || documentRef.hidden) return;

      const loader = loaders[nextIndex];
      nextIndex += 1;
      if (!loader) return;

      // import 无法中途取消；切回前台时仍需等待在途模块，避免并发加载。
      loading = true;
      void Promise.resolve()
        .then(loader)
        .catch(() => undefined)
        .finally(() => {
          loading = false;
          scheduleNext();
        });
    };

    if (idleWindow.requestIdleCallback && idleWindow.cancelIdleCallback) {
      idleCallbackId = idleWindow.requestIdleCallback(runNext);
    } else {
      idleFallbackId = idleWindow.setTimeout(runNext, IDLE_FALLBACK_DELAY_MS);
    }
  };

  const resume = () => {
    if (cancelled || documentRef.hidden || documentRef.readyState !== "complete") return;
    if (firstScreenReady) {
      scheduleNext();
    } else if (loadDelayId === null) {
      loadDelayId = idleWindow.setTimeout(() => {
        loadDelayId = null;
        firstScreenReady = true;
        scheduleNext();
      }, ROUTE_PRELOAD_AFTER_LOAD_DELAY_MS);
    }
  };

  const onVisibilityChange = () => {
    if (documentRef.hidden) clearScheduled();
    else resume();
  };

  idleWindow.addEventListener("load", resume, { once: true });
  documentRef.addEventListener("visibilitychange", onVisibilityChange);
  resume();

  return () => {
    cancelled = true;
    idleWindow.removeEventListener("load", resume);
    documentRef.removeEventListener("visibilitychange", onVisibilityChange);
    clearScheduled();
  };
}

/** 只预加载代码：首屏完成后在前台空闲时进行，并遵守网络与平台限制。 */
export function RouteModulePreloader() {
  useEffect(() => {
    const connection = (navigator as Navigator & { connection?: RoutePreloadConnection })
      .connection;
    if (shouldSkipIdleRoutePreloading(connection)) return;

    return startIdleRoutePreloading(idleRouteModuleLoadersForPlatform(getClientPlatform()));
  }, []);

  return null;
}
