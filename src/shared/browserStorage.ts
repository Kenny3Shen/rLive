export type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** 非浏览器环境或隐私限制下，记忆功能静默降级，不影响主流程。 */
export function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
