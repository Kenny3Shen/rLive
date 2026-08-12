/**
 * Transport used when the frontend runs in an ordinary browser tab instead of
 * the Tauri WebView.
 *
 * rLive's backend serves the built bundle over a loopback HTTP bridge, so the
 * page can reach the very same Rust commands through `POST /api/invoke/<cmd>`
 * and receive danmaku through `GET /api/events`. Nothing here reimplements a
 * command; it only changes how the existing ones are called.
 */
import type { AppError } from "../types/error";

/** Set when the page was served by the bridge rather than a plain dev server. */
const BRIDGE_TOKEN_KEY = "rlive.webBridgeToken";

export type WebBridgeStatus = {
  platform: "web";
  nativeOnlyCommands: readonly string[];
};

let statusPromise: Promise<WebBridgeStatus | null> | null = null;
let nativeOnlyCommands: ReadonlySet<string> = new Set();

function bridgeToken(): string | null {
  if (typeof window === "undefined") return null;
  // A LAN-exposed bridge requires a token. It arrives once in the URL and is
  // kept in sessionStorage so a reload does not need the query string, and so
  // it is dropped when the tab closes.
  const fromUrl = new URLSearchParams(window.location.search).get("token");
  if (fromUrl) {
    try {
      window.sessionStorage.setItem(BRIDGE_TOKEN_KEY, fromUrl);
    } catch {
      // Private-mode storage failures are not fatal: the in-URL token still
      // authorizes this navigation.
    }
    return fromUrl;
  }
  try {
    return window.sessionStorage.getItem(BRIDGE_TOKEN_KEY);
  } catch {
    return null;
  }
}

function authHeaders(): Record<string, string> {
  const token = bridgeToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** Appends the bridge token to a URL that cannot carry request headers. */
export function withBridgeToken(path: string): string {
  const token = bridgeToken();
  if (!token) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}token=${encodeURIComponent(token)}`;
}

function appError(code: string, message: string, retryable: boolean): AppError {
  return { code, message, site: null, retryable } satisfies AppError;
}

/**
 * Probes the bridge once. A `null` result means this page is not served by
 * rLive, so browser callers get the same "not connected" error as before.
 */
export async function webBridgeStatus(): Promise<WebBridgeStatus | null> {
  statusPromise ??= (async () => {
    try {
      const response = await fetch("/api/status", {
        headers: authHeaders(),
        cache: "no-store",
      });
      if (!response.ok) return null;
      const status = (await response.json()) as WebBridgeStatus;
      if (status?.platform !== "web") return null;
      nativeOnlyCommands = new Set(status.nativeOnlyCommands ?? []);
      return status;
    } catch {
      return null;
    }
  })();
  return statusPromise;
}

/** True once the bridge has reported that a command needs the native client. */
export function isNativeOnlyCommand(cmd: string): boolean {
  return nativeOnlyCommands.has(cmd);
}

export async function invokeOverBridge<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/invoke/${encodeURIComponent(cmd)}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(args ?? {}),
    });
  } catch (error) {
    throw appError("web_bridge_unreachable", `无法连接 rLive 本地服务: ${String(error)}`, true);
  }

  if (response.status === 401) {
    throw appError("web_bridge_unauthorized", "访问令牌无效，请重新打开 rLive 提供的链接。", false);
  }

  let payload: { ok?: unknown; error?: AppError };
  try {
    payload = (await response.json()) as typeof payload;
  } catch (error) {
    throw appError("web_bridge_bad_response", `本地服务返回了非 JSON 响应: ${String(error)}`, true);
  }

  // The bridge reports command failures inside the body, so a failed command
  // rejects with the identical AppError shape `invoke` produces.
  if (payload.error) throw payload.error;
  if (!response.ok) {
    throw appError("web_bridge_bad_response", `本地服务返回 HTTP ${response.status}`, true);
  }
  return payload.ok as T;
}
