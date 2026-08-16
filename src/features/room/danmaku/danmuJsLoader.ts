import type { DanmuJsConstructor } from "danmu.js";

type ModuleRecord = Record<string, unknown>;

function asRecord(value: unknown): ModuleRecord | null {
  return value !== null && (typeof value === "object" || typeof value === "function")
    ? (value as ModuleRecord)
    : null;
}

/**
 * danmu.js 1.2.1 is published as UMD/CJS without an `exports` map. Depending
 * on the runtime and Vite's interop pass, its constructor can appear at any of
 * these equivalent locations. Keep that compatibility knowledge in one place.
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

/** Load the browser-only renderer without evaluating its CSS-injecting UMD in SSR tests. */
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
