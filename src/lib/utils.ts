import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format viewer / online counts like Simple Live (万). */
export function formatOnline(n: number): string {
  if (n >= 10_000) {
    const w = n / 10_000;
    return `${w >= 10 ? Math.round(w) : w.toFixed(1).replace(/\.0$/, "")}万`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(n);
}

export const SITE_LABELS: Record<string, string> = {
  bilibili: "哔哩哔哩",
  douyu: "斗鱼直播",
  huya: "虎牙直播",
  douyin: "抖音直播",
  kuaishou: "快手直播",
};

export const SITE_ACCENT: Record<string, string> = {
  bilibili: "#FB7299",
  douyu: "#FF5D23",
  huya: "#FF9A00",
  douyin: "#25F4EE",
  kuaishou: "#FF4906",
};
