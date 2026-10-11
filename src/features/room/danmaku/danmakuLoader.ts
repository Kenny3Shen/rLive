import type { DanmakuRenderer } from "./danmakuRenderer";

let loading: Promise<typeof DanmakuRenderer> | null = null;

/** 延后加载包含 Danmaku DOM 引擎的运行时；加载失败时清空缓存，下次挂载可重试。 */
export function loadDanmakuRenderer(): Promise<typeof DanmakuRenderer> {
  loading ??= import("./danmakuRenderer")
    .then((module) => module.DanmakuRenderer)
    .catch((error: unknown) => {
      loading = null;
      throw error;
    });
  return loading;
}
