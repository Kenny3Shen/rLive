/**
 * The native shell only needs a small, stable distinction: Android, iOS, or
 * a desktop-class client. Prefer User-Agent Client Hints when a WebView
 * exposes them, then retain conservative fallbacks for current Tauri mobile
 * WebViews and iPads that identify as Macintosh.
 */
export type ClientPlatform = "android" | "ios" | "desktop";

type ClientNavigator = Pick<Navigator, "userAgent" | "maxTouchPoints"> & {
  userAgentData?: {
    mobile?: boolean;
    platform?: string;
  };
};

function browserNavigator(): ClientNavigator | undefined {
  return typeof navigator === "undefined" ? undefined : navigator;
}

export function getClientPlatform(
  navigatorRef: ClientNavigator | null | undefined = browserNavigator(),
): ClientPlatform {
  if (!navigatorRef) return "desktop";

  const platform = navigatorRef.userAgentData?.platform?.toLowerCase() ?? "";
  const userAgent = navigatorRef.userAgent ?? "";

  if (platform === "android" || /\bAndroid\b/i.test(userAgent)) return "android";

  const isIpadDesktopUserAgent =
    /\bMacintosh\b/i.test(userAgent) && (navigatorRef.maxTouchPoints ?? 0) > 1;
  if (
    platform === "ios" ||
    /\biPhone\b|\biPad\b|\biPod\b/i.test(userAgent) ||
    isIpadDesktopUserAgent
  ) {
    return "ios";
  }

  return "desktop";
}

export function isMobileClient(
  navigatorRef: ClientNavigator | null | undefined = browserNavigator(),
): boolean {
  return getClientPlatform(navigatorRef) !== "desktop";
}

/** Multi-room playback is intentionally limited to desktop-class clients. */
export function supportsMultiRoom(
  navigatorRef: ClientNavigator | null | undefined = browserNavigator(),
): boolean {
  return getClientPlatform(navigatorRef) === "desktop";
}

export function isWindowsDesktop(
  navigatorRef: ClientNavigator | null | undefined = browserNavigator(),
): boolean {
  if (getClientPlatform(navigatorRef) !== "desktop") return false;
  const platform = navigatorRef?.userAgentData?.platform?.toLowerCase() ?? "";
  const userAgent = navigatorRef?.userAgent ?? "";
  return platform === "windows" || /Windows NT/i.test(userAgent);
}

/**
 * Which shell the code is running inside, as opposed to which OS the device is.
 *
 * `getClientPlatform` answers "phone or desktop" and drives layout. This answers
 * "native app or browser tab" and drives capability: a browser reaches Rust over
 * the local HTTP bridge, so it can browse, play and chat, but it has no OS file
 * dialog, no microphone IPC and no Android window controls.
 */
export type ClientRuntime = "native" | "web";

export function getClientRuntime(tauriRuntime: boolean): ClientRuntime {
  return tauriRuntime ? "native" : "web";
}

/** Local ASR, profile files and window controls need the native shell. */
export function supportsNativeHostFeatures(tauriRuntime: boolean): boolean {
  return getClientRuntime(tauriRuntime) === "native";
}
