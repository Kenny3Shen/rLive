import { useEffect } from "react";
import { IDLE_ROUTE_MODULE_LOADERS, type RouteModuleLoader } from "./routeModules";

export const ROUTE_PRELOAD_AFTER_LOAD_DELAY_MS = 1_500;
const IDLE_FALLBACK_DELAY_MS = 250;

export type RoutePreloadConnection = {
  saveData?: boolean;
  effectiveType?: string;
};

type IdleCapableWindow = Window & {
  requestIdleCallback?: (callback: () => void) => number;
  cancelIdleCallback?: (handle: number) => void;
};

export function shouldSkipIdleRoutePreloading(
  connection: RoutePreloadConnection | null | undefined,
): boolean {
  return Boolean(
    connection?.saveData ||
    connection?.effectiveType === "slow-2g" ||
    connection?.effectiveType === "2g",
  );
}

function startIdleRoutePreloading(loaders: readonly RouteModuleLoader[]): () => void {
  const idleWindow = window as IdleCapableWindow;
  let cancelled = false;
  let nextIndex = 0;
  let loadDelayId: number | null = null;
  let idleCallbackId: number | null = null;
  let idleFallbackId: number | null = null;

  const scheduleNext = () => {
    if (cancelled || nextIndex >= loaders.length) return;

    const runNext = () => {
      idleCallbackId = null;
      idleFallbackId = null;
      if (cancelled) return;

      const loader = loaders[nextIndex];
      nextIndex += 1;
      if (!loader) return;

      void loader()
        .catch(() => undefined)
        .finally(() => {
          if (!cancelled) scheduleNext();
        });
    };

    if (idleWindow.requestIdleCallback) {
      idleCallbackId = idleWindow.requestIdleCallback(runNext);
    } else {
      idleFallbackId = window.setTimeout(runNext, IDLE_FALLBACK_DELAY_MS);
    }
  };

  const beginAfterFirstScreen = () => {
    if (cancelled || loadDelayId !== null) return;
    loadDelayId = window.setTimeout(scheduleNext, ROUTE_PRELOAD_AFTER_LOAD_DELAY_MS);
  };

  if (document.readyState === "complete") {
    beginAfterFirstScreen();
  } else {
    window.addEventListener("load", beginAfterFirstScreen, { once: true });
  }

  return () => {
    cancelled = true;
    window.removeEventListener("load", beginAfterFirstScreen);
    if (loadDelayId !== null) window.clearTimeout(loadDelayId);
    if (idleCallbackId !== null) idleWindow.cancelIdleCallback?.(idleCallbackId);
    if (idleFallbackId !== null) window.clearTimeout(idleFallbackId);
  };
}

/** Preload code only, after the first screen and only when the connection allows it. */
export function RouteModulePreloader() {
  useEffect(() => {
    const connection = (navigator as Navigator & { connection?: RoutePreloadConnection })
      .connection;
    if (shouldSkipIdleRoutePreloading(connection)) return;

    return startIdleRoutePreloading(IDLE_ROUTE_MODULE_LOADERS);
  }, []);

  return null;
}
