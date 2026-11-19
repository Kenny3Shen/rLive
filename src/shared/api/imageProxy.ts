import { invokeCmd } from "@/shared/api/tauri";

/**
 * 允许后端图片代理抓取并附加平台 Referer 的 CDN 主机。与
 * `src-tauri/src/image_proxy.rs` 的 `ALLOWED_IMAGE_HOSTS` 保持同步。
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
  "7tv.app",
  "acfun.cn",
  "aixifan.com",
  "yximgs.com",
  "kwimgs.com",
];

type ImageProxyResponse = string | { origins: unknown };

export type ImageProxyOriginState = {
  get: () => readonly string[] | null;
  preload: () => Promise<readonly string[] | null>;
  refresh: () => Promise<readonly string[] | null>;
};

function normalizeProxyOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value.trim());
    if (
      parsed.protocol !== "http:" ||
      parsed.hostname !== "127.0.0.1" ||
      parsed.port === "" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

/** 解析新协议，并兼容热更新期间旧版后端返回的单个 origin 字符串。 */
export function parseImageProxyOrigins(response: unknown): readonly string[] | null {
  const candidates =
    typeof response === "string"
      ? [response]
      : response &&
          typeof response === "object" &&
          "origins" in response &&
          Array.isArray(response.origins)
        ? response.origins
        : null;
  if (!candidates) return null;

  const origins = candidates
    .map(normalizeProxyOrigin)
    .filter((origin): origin is string => origin !== null);
  return origins.length === 0 ? null : Array.from(new Set(origins));
}

/**
 * 对规范化后的上游 URL 做稳定分流，让 WebView 可以同时使用多个回环 origin，
 * 绕过单个 HTTP/1.1 origin 的连接数上限。revision 不参与选择，避免缓存键变化时
 * 改变图片所属的 origin。
 */
export function proxyOriginForUrl(
  origins: readonly string[],
  upstreamUrl: string,
): string | undefined {
  if (origins.length === 0) return undefined;
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(upstreamUrl)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return origins[hash % origins.length];
}

/**
 * 图片代理 origin 的进程内状态。失败后清空在途 Promise，使下一次显式预加载可以
 * 重试；刷新会递增 epoch，忽略旧设置下迟到的响应。
 */
export function createImageProxyOriginState(
  requestOrigins: () => Promise<unknown>,
): ImageProxyOriginState {
  let origins: readonly string[] | null = null;
  let pending: Promise<readonly string[] | null> | null = null;
  let epoch = 0;

  function preload(): Promise<readonly string[] | null> {
    if (origins) return Promise.resolve(origins);
    if (pending) return pending;

    const requestEpoch = epoch;
    const request = requestOrigins()
      .then((response) => {
        if (requestEpoch !== epoch) return null;
        origins = parseImageProxyOrigins(response);
        return origins;
      })
      .catch(() => null);
    const tracked = request.finally(() => {
      if (requestEpoch === epoch && pending === tracked) pending = null;
    });
    pending = tracked;
    return tracked;
  }

  return {
    get: () => origins,
    preload,
    refresh: () => {
      epoch += 1;
      origins = null;
      pending = null;
      return preload();
    },
  };
}

const imageProxyOriginState = createImageProxyOriginState(() =>
  invokeCmd<ImageProxyResponse>("image_proxy_url"),
);

/**
 * 后端代理是否会抓取该主机。导出它便于测试断言弹幕片段校验器信任的每个 CDN
 * 都可缓存。
 */
export function shouldProxyHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return PROXIED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** 启动时预加载回环图片代理。在它就绪前渲染的图片回退到直连 CDN URL。 */
export function preloadImageProxy(): Promise<readonly string[] | null> {
  return imageProxyOriginState.preload();
}

/** 代理路由变化后重新获取监听器；失败不会把初始化 Promise 永久锁死。 */
export function refreshImageProxy(): Promise<readonly string[] | null> {
  return imageProxyOriginState.refresh();
}

export type ProxyImageOptions = {
  /** 浏览列表查询快照的版本，只作为本机 HTTP 缓存键，不传给 CDN。 */
  coverRevision?: string;
  /**
   * 让抓取的内容进入后端磁盘缓存。直播房间封面关闭此项：平台为每次采集生成新
   * URL（虎牙把秒级时间戳写进文件名，斗鱼的 `asrpic` 同理），
   * 每次刷新都会写入一个永不再读的新条目并淘汰真正重复的头像。
   * 这些图片仍经代理转发以获得 Referer。
   */
  cache?: boolean;
};

/**
 * 经本机防盗链代理改写远程图片地址；代理不可用或主机不在白名单时返回
 * `undefined`。
 */
export function proxyImageUrl(url: string, options?: ProxyImageOptions): string | undefined {
  const origins = imageProxyOriginState.get();
  if (origins === null) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return undefined;
    if (!shouldProxyHost(parsed.hostname)) return undefined;
    const base = proxyOriginForUrl(origins, parsed.href);
    return base ? buildProxyTarget(base, parsed.href, options) : undefined;
  } catch {
    return undefined;
  }
}

/** 单张被代理图片的请求目标；`nocache=1` 选择退出磁盘缓存。 */
export function buildProxyTarget(base: string, href: string, options?: ProxyImageOptions): string {
  const flags = options?.cache === false ? "nocache=1&" : "";
  const revision =
    options?.cache === false && options.coverRevision
      ? `revision=${encodeURIComponent(options.coverRevision)}&`
      : "";
  return `${base}/img?${flags}${revision}url=${encodeURIComponent(href)}`;
}
