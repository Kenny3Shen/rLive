import { isTauri } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

/**
 * Browser-compatible transport used only by @vitalets/google-translate-api.
 * The package imports node-fetch, while rLive needs Tauri's scoped Rust HTTP
 * client to reach Google Translate from a WebView without weakening CORS.
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
  return tauriFetch(input, init);
}
