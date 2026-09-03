import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { proxyImageUrl, type ProxyImageOptions } from "@/shared/api/imageProxy";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format viewer / online counts like Simple Live (万). */
export function formatOnline(n: number): string {
  if (n >= 10_000) {
    const w = n / 10_000;
    return `${w.toFixed(1).replace(/\.0$/, "")}万`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(n);
}

export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return (bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1) + " " + units[index];
}

/**
 * 让远程头像地址对 WebView 加载安全。
 *
 * 直播 API 常返回协议相对图片地址（`//…`）。它们在普通 https 网页上可用，
 * 但在桌面应用里会相对 Tauri 自定义页面协议解析。升级纯 http 地址也避免了
 * WebView 的混合内容失败。
 *
 * 有防盗链的 CDN 主机（Bilibili / 斗鱼 / 虎牙 / 抖音 / Twitch）额外经本机图片代理
 * 路由，由其附加 WebView 无法发送的平台 Referer。代理启动之前的地址或未知主机的
 * 地址原样返回。
 *
 * 用于头像和其他跨会话保持同一地址的图片素材。
 * 直播房间封面属于 `normalizeCoverUrl`。
 */
export function normalizeImageUrl(value: string | null | undefined): string | undefined {
  return normalizeRemoteImage(value);
}

/**
 * `normalizeImageUrl` 的直播封面版本，封面被排除在磁盘缓存之外。直播封面要么每次
 * 采集重新生成（虎牙把秒级时间戳写进文件名，斗鱼的 `asrpic` 同理），
 * 要么来自内容每几分钟轮换的稳定 URL（Twitch `previews-ttv`）。缓存前者会用永不
 * 再读的条目填满预算；缓存后者则显示冻结的预览。
 */
export function normalizeCoverUrl(value: string | null | undefined): string | undefined {
  return normalizeRemoteImage(value, { cache: false });
}

/**
 * `normalizeImageUrl` 的视频封面版本。B 站视频/番剧封面是 `bfs/archive/<hash>.jpg`
 * 这类内容寻址的稳定 URL，同一地址永远指向同一张图，因此进磁盘缓存：
 * 返回列表时封面由 WebView HTTP 缓存（24h max-age）或本机磁盘直出，
 * 不再整屏重新加载。与直播封面的差异正在于此。
 */
export function normalizeVideoCoverUrl(value: string | null | undefined): string | undefined {
  return normalizeRemoteImage(value);
}

function normalizeRemoteImage(
  value: string | null | undefined,
  options?: ProxyImageOptions,
): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;

  const url = raw.startsWith("//") ? `https:${raw}` : raw.replace(/^http:\/\//i, "https://");

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return undefined;
    return proxyImageUrl(parsed.href, options) ?? parsed.href;
  } catch {
    return undefined;
  }
}

export const SITE_LABELS: Record<string, string> = {
  bilibili: "哔哩哔哩",
  douyu: "斗鱼直播",
  huya: "虎牙直播",
  douyin: "抖音直播",
  twitch: "Twitch",
};

export const SITE_ACCENT: Record<string, string> = {
  bilibili: "#FB7299",
  douyu: "#FF5D23",
  huya: "#FF9A00",
  douyin: "#25F4EE",
  twitch: "#9146FF",
};
