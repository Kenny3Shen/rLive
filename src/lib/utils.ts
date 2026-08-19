import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { proxyImageUrl } from "@/shared/api/imageProxy";

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
 * Make remote avatar URLs safe for WebView loading.
 *
 * Live APIs often return protocol-relative image addresses (`//…`). Those work
 * on a normal https webpage, but resolve against Tauri's custom page protocol
 * in the desktop app. Upgrading plain http URLs also avoids mixed-content
 * failures in the WebView.
 *
 * Hotlink-protected CDN hosts (Bilibili / Douyu / Huya / Douyin / Twitch) are
 * additionally routed through the localhost image proxy, which attaches the
 * platform Referer the WebView cannot send. URLs that predate the proxy's
 * startup or belong to unknown hosts are returned untouched.
 */
export function normalizeImageUrl(value: string | null | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;

  const url = raw.startsWith("//") ? `https:${raw}` : raw.replace(/^http:\/\//i, "https://");

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return undefined;
    return proxyImageUrl(parsed.href) ?? parsed.href;
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
