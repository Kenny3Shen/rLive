import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * 在系统浏览器打开外部链接。优先走原生 opener 插件；浏览器开发预览没有
 * 该插件时退回 `window.open`。返回是否成功打开（弹窗拦截也算失败），
 * 通知反馈由调用方按结果给出。
 */
export function openExternalUrl(url: string): Promise<boolean> {
  return openUrl(url)
    .then(() => true)
    .catch(() => window.open(url, "_blank", "noopener,noreferrer") !== null);
}
