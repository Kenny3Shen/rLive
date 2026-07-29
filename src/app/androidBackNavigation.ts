import { onBackButtonPress } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { getClientPlatform } from "@/shared/clientPlatform";

/**
 * Cancelable, app-local event raised before Android falls back to route
 * navigation. Room overlays listen for it so one Back press closes the active
 * surface before leaving the room.
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
  // Do not install a listener on the root route. Tauri's Android app plugin
  // then retains its normal fallback and lets the system finish the Activity.
  return (
    tauriRuntime &&
    getClientPlatform({ userAgent, maxTouchPoints: 0 }) === "android" &&
    pathname !== "/"
  );
}

/** Returns true when a room overlay has consumed the system Back action. */
export function dispatchAndroidBackEvent(target: EventTarget): boolean {
  const event = new Event(ANDROID_BACK_EVENT, { cancelable: true });
  return !target.dispatchEvent(event);
}

/**
 * Bridges Android's native Back dispatcher to the router only while a route
 * can actually go somewhere. Overlay components can cancel the custom event
 * above to take precedence (drawer, popover, etc.).
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
        // Directly opened deep links have no in-app history entry. Keep Back
        // useful without exposing an empty browser history stack.
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
        // Browser previews and desktop builds do not provide this Android
        // plugin event. They keep their normal platform-specific behavior.
      });

    return () => {
      disposed = true;
      if (listener) void listener.unregister();
    };
  }, [navigate, pathname]);

  return null;
}
