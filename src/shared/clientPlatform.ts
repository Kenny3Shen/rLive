/**
 * 原生外壳只需要一个稳定的小区分：Android、iOS 或桌面级客户端。优先使用
 * WebView 暴露的 User-Agent Client Hints，
 * 再为当前 Tauri 移动 WebView 和自报为 Macintosh 的 iPad
 * 保留保守兜底。
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

/** 多视图播放刻意限定在桌面级客户端。 */
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
