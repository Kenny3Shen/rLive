import { isTauri } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { useSettingsStore } from "@/shared/stores/settingsStore";

type TranslationFetchOptions = RequestInit & {
  maxRedirections: number;
  proxy?: { all: string };
};

export function buildTranslationFetchOptions(
  init: RequestInit | undefined,
  configuredProxy: string | null | undefined,
): TranslationFetchOptions {
  const proxy = configuredProxy?.trim();
  return {
    ...init,
    maxRedirections: 3,
    ...(proxy ? { proxy: { all: proxy } } : {}),
  };
}

/**
 * 仅供 google-translate-api-x 使用的浏览器兼容传输层。Tauri 受限的 Rust HTTP
 * 客户端无需削弱 WebView CORS 即可到达 Google 翻译，
 * 并显式继承 rLive 配置的 HTTP(S) 代理。
 */
export default async function fetchThroughTauri(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  if (!isTauri()) {
    const error = new Error("字幕翻译仅在 rLive 客户端中可用");
    error.name = "TauriUnavailableError";
    throw error;
  }

  const options = buildTranslationFetchOptions(init, useSettingsStore.getState().proxy);
  return tauriFetch(input, options);
}
