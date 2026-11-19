import { describe, expect, test } from "bun:test";
import {
  createImageProxyOriginState,
  parseImageProxyOrigins,
  proxyOriginForUrl,
} from "../src/shared/api/imageProxy";

const ORIGINS = [
  "http://127.0.0.1:4101",
  "http://127.0.0.1:4102",
  "http://127.0.0.1:4103",
  "http://127.0.0.1:4104",
] as const;

describe("图片代理 origin 协议", () => {
  test("接受新结构并只保留合法的回环 origin", () => {
    expect(
      parseImageProxyOrigins({
        origins: [
          "http://127.0.0.1:4101/",
          "http://127.0.0.1:4101",
          "https://127.0.0.1:4102",
          "http://localhost:4103",
          "http://127.0.0.1:4104/path",
          "http://127.0.0.1:4105",
        ],
      }),
    ).toEqual(["http://127.0.0.1:4101", "http://127.0.0.1:4105"]);
  });

  test("兼容旧版单 origin 字符串并拒绝无效结构", () => {
    expect(parseImageProxyOrigins("http://127.0.0.1:4101")).toEqual(["http://127.0.0.1:4101"]);
    expect(parseImageProxyOrigins({ origins: [] })).toBeNull();
    expect(parseImageProxyOrigins({ origins: "http://127.0.0.1:4101" })).toBeNull();
    expect(parseImageProxyOrigins(null)).toBeNull();
  });
});

describe("图片代理稳定分流", () => {
  test("同一上游 URL 始终命中同一 origin", () => {
    const cover = "https://i0.hdslb.com/bfs/archive/cover.jpg@480w_270h.webp";
    const selected = proxyOriginForUrl(ORIGINS, cover);

    expect(selected).toBe(proxyOriginForUrl(ORIGINS, cover));
    expect(ORIGINS).toContain(selected);
  });

  test("不同图片可铺满四个回环 origin", () => {
    const selected = new Set(
      Array.from({ length: 64 }, (_, index) =>
        proxyOriginForUrl(ORIGINS, `https://i0.hdslb.com/bfs/archive/${index}.jpg`),
      ),
    );

    expect(selected.size).toBe(4);
  });
});

describe("图片代理 origin 初始化", () => {
  test("并发预加载共享同一请求", async () => {
    let calls = 0;
    const state = createImageProxyOriginState(async () => {
      calls += 1;
      return { origins: ORIGINS };
    });

    const first = state.preload();
    const second = state.preload();
    expect(first).toBe(second);
    expect(await first).toEqual(ORIGINS);
    expect(calls).toBe(1);
  });

  test("初始化失败后下一次预加载会重试", async () => {
    let calls = 0;
    const state = createImageProxyOriginState(async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary failure");
      return { origins: ORIGINS };
    });

    expect(await state.preload()).toBeNull();
    expect(await state.preload()).toEqual(ORIGINS);
    expect(calls).toBe(2);
  });

  test("刷新代理路由后忽略旧请求的迟到结果", async () => {
    let resolveOld: ((value: unknown) => void) | undefined;
    let calls = 0;
    const state = createImageProxyOriginState(() => {
      calls += 1;
      if (calls === 1) {
        return new Promise((resolve) => {
          resolveOld = resolve;
        });
      }
      return Promise.resolve({ origins: ORIGINS });
    });

    const old = state.preload();
    expect(await state.refresh()).toEqual(ORIGINS);
    resolveOld?.({ origins: ["http://127.0.0.1:4999"] });
    expect(await old).toBeNull();
    expect(state.get()).toEqual(ORIGINS);
  });
});
