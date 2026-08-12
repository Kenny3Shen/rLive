import { afterEach, describe, expect, test } from "bun:test";
import {
  getClientRuntime,
  supportsNativeHostFeatures,
} from "../src/shared/clientPlatform";
import {
  webBridgeExposureWarning,
  webBridgeShareUrl,
  type WebBridgeInfo,
} from "../src/features/settings/webBridge";

const loopback: WebBridgeInfo = {
  url: "http://127.0.0.1:17650",
  port: 17650,
  lan_exposed: false,
  token: null,
};

const lan: WebBridgeInfo = {
  url: "http://127.0.0.1:17650",
  port: 17650,
  lan_exposed: true,
  token: "0123456789abcdef",
};

describe("web platform runtime", () => {
  test("separates the shell from the device platform", () => {
    expect(getClientRuntime(true)).toBe("native");
    expect(getClientRuntime(false)).toBe("web");
  });

  test("keeps host-permission features on the native shell", () => {
    expect(supportsNativeHostFeatures(true)).toBe(true);
    expect(supportsNativeHostFeatures(false)).toBe(false);
  });
});

describe("web bridge share url", () => {
  test("uses the reported loopback origin with no token", () => {
    expect(webBridgeShareUrl(loopback)).toBe("http://127.0.0.1:17650");
  });

  test("carries the token in the query string, since navigation cannot set headers", () => {
    expect(webBridgeShareUrl(lan)).toBe("http://127.0.0.1:17650/?token=0123456789abcdef");
  });

  test("substitutes a LAN host while keeping the port and token", () => {
    expect(webBridgeShareUrl(lan, "192.168.1.20")).toBe(
      "http://192.168.1.20:17650/?token=0123456789abcdef",
    );
  });

  test("warns only when the listener is reachable beyond this machine", () => {
    expect(webBridgeExposureWarning(loopback)).toBeNull();
    expect(webBridgeExposureWarning(lan)).toContain("局域网");
  });
});

describe("browser transport", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("unwraps a command result and rethrows the backend's own error shape", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body });
      if (url === "/api/status") {
        return new Response(
          JSON.stringify({ platform: "web", nativeOnlyCommands: ["asr_enable"] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/site_list")) {
        return new Response(JSON.stringify({ ok: [{ id: "bilibili" }] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          error: { code: "site_error", message: "房间不存在", site: "huya", retryable: false },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    // Imported lazily so the stubbed fetch is in place before the module's
    // one-shot status probe runs, and cache-busted because the whole suite
    // shares one process: another file may already have probed and cached a
    // `null` status.
    const { invokeOverBridge, isNativeOnlyCommand, webBridgeStatus } = await import(
      `../src/shared/api/webBridge?probe=${Date.now()}`
    );

    expect(await webBridgeStatus()).toEqual({
      platform: "web",
      nativeOnlyCommands: ["asr_enable"],
    });
    expect(isNativeOnlyCommand("asr_enable")).toBe(true);
    expect(isNativeOnlyCommand("site_list")).toBe(false);

    expect(await invokeOverBridge("site_list")).toEqual([{ id: "bilibili" }]);

    await expect(
      invokeOverBridge("site_get_room_detail", { siteId: "huya", roomId: "1" }),
    ).rejects.toMatchObject({ code: "site_error", site: "huya" });

    const detailCall = calls.find((call) => call.url.endsWith("/site_get_room_detail"));
    expect(detailCall?.body).toBe(JSON.stringify({ siteId: "huya", roomId: "1" }));
  });
});
