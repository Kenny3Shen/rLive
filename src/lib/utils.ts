import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

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

/**
 * Make remote avatar URLs safe for WebView loading.
 *
 * Live APIs often return protocol-relative image addresses (`//…`). Those work
 * on a normal https webpage, but resolve against Tauri's custom page protocol
 * in the desktop app. Upgrading plain http URLs also avoids mixed-content
 * failures in the WebView.
 */
export function normalizeImageUrl(value: string | null | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;

  const url = raw.startsWith("//") ? `https:${raw}` : raw.replace(/^http:\/\//i, "https://");

  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.href : undefined;
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
