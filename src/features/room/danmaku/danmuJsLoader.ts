import type { DanmuJsConstructor } from "danmu.js";

type ModuleRecord = Record<string, unknown>;

function asRecord(value: unknown): ModuleRecord | null {
  return value !== null && (typeof value === "object" || typeof value === "function")
    ? (value as ModuleRecord)
    : null;
}

/**
 * danmu.js 1.2.1 以 UMD/CJS 发布且没有 `exports` map。取决于运行时和 Vite 的
 * 互操作处理，其构造函数可能出现在这些等价位置中的任何一个。
 * 把这份兼容性知识集中在一处。
 */
export function resolveDanmuJsConstructor(moduleValue: unknown): DanmuJsConstructor | null {
  const root = asRecord(moduleValue);
  const globalRoot = typeof globalThis === "undefined" ? null : asRecord(globalThis);
  const nestedDefault = root ? asRecord(root.default) : null;
  const candidates = [
    moduleValue,
    root?.DanmuJs,
    root?.default,
    nestedDefault?.DanmuJs,
    nestedDefault?.default,
    globalRoot?.DanmuJs,
    globalRoot?.default,
  ];
  const constructor = candidates.find((candidate) => typeof candidate === "function");
  return (constructor as DanmuJsConstructor | undefined) ?? null;
}

let constructorPromise: Promise<DanmuJsConstructor> | null = null;

/** 加载仅限浏览器的渲染器，避免 SSR 测试中求值其注入 CSS 的 UMD。 */
export function loadDanmuJs(): Promise<DanmuJsConstructor> {
  if (constructorPromise) return constructorPromise;

  constructorPromise = import("danmu.js")
    .then((moduleValue) => {
      const constructor = resolveDanmuJsConstructor(moduleValue);
      if (!constructor) throw new Error("danmu.js constructor is unavailable");
      return constructor;
    })
    .catch((error: unknown) => {
      constructorPromise = null;
      throw error;
    });
  return constructorPromise;
}
