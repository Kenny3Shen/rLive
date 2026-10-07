import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mockIPC } from "@tauri-apps/api/mocks";
import fetchThroughTauri, { buildHttpFetchRequest } from "../src/shared/api/tauriFetch";

const url = "https://translate.google.com/translate_a/single";
const response = (status = 200, body = '{"text":"翻译"}') => ({
  status,
  status_text: status === 429 ? "Too Many Requests" : "OK",
  headers: [["content-type", "application/json"]],
  body: Array.from(new TextEncoder().encode(body)),
  url,
});

describe("统一 Rust HTTP 传输", () => {
  let windowDescriptor: PropertyDescriptor | undefined;
  let tauriDescriptor: PropertyDescriptor | undefined;
  beforeEach(() => {
    windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    tauriDescriptor = Object.getOwnPropertyDescriptor(globalThis, "isTauri");
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    Object.defineProperty(globalThis, "isTauri", { configurable: true, value: true });
  });
  afterEach(() => {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
    if (tauriDescriptor) Object.defineProperty(globalThis, "isTauri", tauriDescriptor);
    else Reflect.deleteProperty(globalThis, "isTauri");
  });

  test("合并 Request 和 init，保留 UTF-8 正文与响应状态", async () => {
    let request: unknown;
    mockIPC((cmd, payload) => {
      expect(cmd).toBe("http_fetch");
      request = (payload as { request: unknown }).request;
      return response();
    });
    const result = await fetchThroughTauri(new Request(url, { method: "POST", body: "旧正文" }), {
      body: new URLSearchParams({ text: "你好" }),
    });
    expect(request).toMatchObject({ url, method: "POST" });
    const bytes = (request as { body: number[] }).body;
    expect(new TextDecoder().decode(new Uint8Array(bytes))).toBe("text=%E4%BD%A0%E5%A5%BD");
    expect(result.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.url).toBe(url);
    expect(result.redirected).toBe(false);
    expect(result.headers.get("content-type")).toBe("application/json");
    expect(await result.json()).toEqual({ text: "翻译" });
  });

  test("HTTP 429 返回可供翻译库识别的 Response 而非丢失状态的异常", async () => {
    mockIPC(() => response(429));
    const result = await fetchThroughTauri(url);
    expect(result.status).toBe(429);
    expect(result.ok).toBe(false);
  });

  test("空正文状态可构造合法 Response", async () => {
    mockIPC(() => response(204, ""));
    const result = await fetchThroughTauri(url);
    expect(result.body).toBeNull();
    expect(await result.text()).toBe("");
  });

  test("已取消请求不发 IPC", async () => {
    let calls = 0;
    mockIPC(() => {
      calls++;
      return response();
    });
    const controller = new AbortController();
    controller.abort();
    await expect(fetchThroughTauri(url, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(calls).toBe(0);
  });

  test("在途取消及时结束等待，忽略迟到响应", async () => {
    let finish!: (value: ReturnType<typeof response>) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    mockIPC(
      () =>
        new Promise((resolve) => {
          finish = resolve;
          started();
        }),
    );
    const controller = new AbortController();
    const work = fetchThroughTauri(url, { signal: controller.signal });
    await ready;
    controller.abort();
    await expect(work).rejects.toMatchObject({ name: "AbortError" });
    finish(response());
    await Promise.resolve();
  });

  test("GET 不发送正文，也不把代理字段放进 IPC", async () => {
    const request = await buildHttpFetchRequest(new Request(url));
    expect(request).toEqual({ url, method: "GET", headers: [] });
  });

  test("非 Tauri 环境不回退到系统代理不受控的浏览器 fetch", async () => {
    Object.defineProperty(globalThis, "isTauri", { configurable: true, value: false });
    await expect(fetchThroughTauri(url)).rejects.toMatchObject({ name: "TauriUnavailableError" });
  });
});
