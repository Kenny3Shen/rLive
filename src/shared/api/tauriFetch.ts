import { isTauri } from "@tauri-apps/api/core";
import { invokeCmd } from "./tauri";

export type HttpFetchRequest = {
  url: string;
  method: string;
  headers: [string, string][];
  body?: number[];
};

type HttpFetchResponse = {
  status: number;
  status_text: string;
  headers: [string, string][];
  body: number[];
  url: string;
};

/** Request 负责合并 input/init 与编码正文；代理模式只由 Rust 设置决定。 */
export async function buildHttpFetchRequest(request: Request): Promise<HttpFetchRequest> {
  request.signal.throwIfAborted();
  const body = request.body ? Array.from(new Uint8Array(await request.arrayBuffer())) : undefined;
  request.signal.throwIfAborted();
  return {
    url: request.url,
    method: request.method,
    headers: Array.from(request.headers.entries()),
    ...(body === undefined ? {} : { body }),
  };
}

function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("请求已取消", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    // invoke 无取消接口：及时结束前端等待，Rust 超时负责回收底层请求。
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/**
 * Google 字幕翻译与 GitHub 更新共用的受限 HTTP 传输。
 * 不在前端推导代理或回退 WebView fetch，以免「关闭」仍继承进程/系统代理。
 * URL 白名单、重定向检查、请求超时及响应限长统一在 Rust http_fetch 中实现。
 */
export default async function fetchThroughTauri(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  if (!isTauri()) {
    const error = new Error("网络请求仅在 rLive 客户端中可用");
    error.name = "TauriUnavailableError";
    throw error;
  }
  const request = new Request(input, init);
  const payload = await buildHttpFetchRequest(request);
  const result = await withAbort(
    invokeCmd<HttpFetchResponse>("http_fetch", { request: payload }),
    request.signal,
  );
  request.signal.throwIfAborted();
  const response = new Response(
    [204, 205, 304].includes(result.status) ? null : new Uint8Array(result.body),
    { status: result.status, statusText: result.status_text, headers: result.headers },
  );
  Object.defineProperties(response, {
    url: { value: result.url },
    redirected: { value: result.url !== request.url },
  });
  return response;
}
