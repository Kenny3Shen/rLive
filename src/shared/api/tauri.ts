import { invoke, isTauri } from "@tauri-apps/api/core";
import type { AppError } from "../types/error";

export const TAURI_UNAVAILABLE_ERROR_CODE = "tauri_unavailable";

export function isTauriUnavailableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === TAURI_UNAVAILABLE_ERROR_CODE
  );
}

export async function invokeCmd<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw {
      code: TAURI_UNAVAILABLE_ERROR_CODE,
      message: "当前浏览器预览未连接 rLive 本地服务，请在 rLive 客户端中使用此功能。",
      site: null,
      retryable: false,
    } satisfies AppError;
  }

  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    const err = e as AppError | string;
    if (typeof err === "object" && err && "code" in err) throw err;
    throw {
      code: "invoke_failed",
      message: String(e),
      site: null,
      retryable: true,
    } satisfies AppError;
  }
}
