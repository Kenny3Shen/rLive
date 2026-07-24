import { invoke } from "@tauri-apps/api/core";
import type { AppError } from "../types/error";

export async function invokeCmd<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
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
