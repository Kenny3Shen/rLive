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
  "biliimg.com",
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

/**
 * Whether the backend proxy will fetch this host. Exported so a test can assert
 * that every CDN the danmaku span validator trusts is also cacheable.
 */
export function shouldProxyHost(hostname: string): boolean {
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

export type ProxyImageOptions = {
  /**
   * Keep the fetched body in the backend disk cache. Off for live room covers:
   * platforms mint a fresh URL per capture (Huya bakes a second-precision
   * timestamp into the filename, Douyu the same in `asrpic`), so every refresh
   * would write a new entry that is never read again and evict the avatars that
   * do repeat. Those images still go through the proxy for the Referer.
   */
  cache?: boolean;
};

/**
 * Rewrite a remote image URL through the localhost hotlink proxy, or return
 * `undefined` when the proxy is unavailable or the host is not proxied.
 */
export function proxyImageUrl(url: string, options?: ProxyImageOptions): string | undefined {
  if (proxyBase === null) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return undefined;
    if (!shouldProxyHost(parsed.hostname)) return undefined;
    return buildProxyTarget(proxyBase, parsed.href, options);
  } catch {
    return undefined;
  }
}

/** Request target for one proxied image; `nocache=1` opts out of the disk cache. */
export function buildProxyTarget(base: string, href: string, options?: ProxyImageOptions): string {
  const flags = options?.cache === false ? "nocache=1&" : "";
  return `${base}/img?${flags}url=${encodeURIComponent(href)}`;
}
