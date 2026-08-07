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
 * Browser-compatible transport used only by google-translate-api-x. Tauri's
 * scoped Rust HTTP client reaches Google Translate without weakening WebView
 * CORS and explicitly inherits rLive's configured HTTP(S) proxy.
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
