import { invokeCmd } from "@/shared/api/tauri";

/**
 * CDN hosts whose images the backend image proxy is allowed to fetch and that
 * receive a platform Referer. Keep in sync with `ALLOWED_IMAGE_HOSTS` in
 * `src-tauri/src/image_proxy.rs`.
 */
const PROXIED_HOST_SUFFIXES = [
  "douyucdn.cn",
  "douyu.com",
  "hdslb.com",
  "bilibili.com",
  "huya.com",
  "msstatic.com",
  "douyin.com",
  "douyinpic.com",
  "douyinliving.com",
  "byteimg.com",
  "jtvnw.net",
  "twitch.tv",
];

let proxyBase: string | null = null;
let proxyPromise: Promise<string | null> | null = null;

function getImageProxyBase(): Promise<string | null> {
  if (proxyBase !== null) return Promise.resolve(proxyBase);
  if (!proxyPromise) {
    proxyPromise = invokeCmd<string>("image_proxy_url")
      .then((base) => (proxyBase = base))
      .catch(() => {
        proxyBase = null;
        return null;
      });
  }
  return proxyPromise;
}

function shouldProxyHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return PROXIED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** Synchronous check for render-time decisions; falls back to direct URLs. */
export function isImageProxyReady(): boolean {
  return proxyBase !== null;
}

/**
 * Preload the loopback image proxy once at startup. Images rendered before it
 * resolves fall back to direct CDN URLs.
 */
export function preloadImageProxy(): Promise<string | null> {
  return getImageProxyBase();
}

/**
 * Rewrite a remote image URL through the localhost hotlink proxy, or return
 * `undefined` when the proxy is unavailable or the host is not proxied.
 */
export function proxyImageUrl(url: string): string | undefined {
  if (proxyBase === null) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return undefined;
    if (!shouldProxyHost(parsed.hostname)) return undefined;
    return `${proxyBase}/img?url=${encodeURIComponent(parsed.href)}`;
  } catch {
    return undefined;
  }
}
