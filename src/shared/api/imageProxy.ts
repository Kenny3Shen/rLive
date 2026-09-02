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
 * 后端代理是否会抓取该主机。导出它便于测试断言弹幕片段校验器信任的每个 CDN
 * 都可缓存。
 */
export function shouldProxyHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return PROXIED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** 供渲染期决策使用的同步检查；失败时回退直连 URL。 */
export function isImageProxyReady(): boolean {
  return proxyBase !== null;
}

/** 启动时预加载一次回环图片代理。在它就绪前渲染的图片回退到直连 CDN URL。 */
export function preloadImageProxy(): Promise<string | null> {
  return getImageProxyBase();
}

export type ProxyImageOptions = {
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

/** 单张被代理图片的请求目标；`nocache=1` 选择退出磁盘缓存。 */
export function buildProxyTarget(base: string, href: string, options?: ProxyImageOptions): string {
  const flags = options?.cache === false ? "nocache=1&" : "";
  return `${base}/img?${flags}url=${encodeURIComponent(href)}`;
}
