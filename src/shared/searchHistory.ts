/**
 * 搜索历史记忆：每个搜索表面各持一份最近搜索词列表（最新在前、去重、截断）。
 *
 * 与播放器音量记忆（`playerVolume.ts`）、直播线路偏好（`linePreference.ts`）同一
 * 取向——存 localStorage 而不是走 `settings_set`：每次提交都读改写 SQLite 里的
 * 单键 JSON 太重，而历史是纯增益，坏数据静默按空历史处理即可。纯函数与存储分离，
 * 便于单测；具体存储键由调用方给出，直播与视频两个搜索表面因此互不污染。
 */

/** 每份历史保留的最近搜索词条数。 */
export const MAX_SEARCH_HISTORY_ITEMS = 10;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** 读历史；键不存在、数据损坏或存储不可用时一律按空历史处理。 */
export function readSearchHistory(
  key: string,
  storage: StorageLike | null = browserStorage(),
): string[] {
  if (!storage) return [];
  let raw: string | null = null;
  try {
    raw = storage.getItem(key);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
  } catch {
    return [];
  }
}

/** 写历史；存储不可用时静默（历史是纯增益，不该打断搜索）。 */
export function writeSearchHistory(
  key: string,
  history: readonly string[],
  storage: StorageLike | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(history));
  } catch {
    // 隐私模式或配额耗尽：静默失败。
  }
}

/**
 * 把一次提交的词并进历史：去首尾空白，空词不记；已存在则提到最前（去重），
 * 超出上限截断。返回新列表，调用方据此落盘与更新界面。
 */
export function addSearchHistoryEntry(
  history: readonly string[],
  keyword: string,
  max = MAX_SEARCH_HISTORY_ITEMS,
): string[] {
  const trimmed = keyword.trim();
  if (!trimmed || max <= 0) return [...history];
  return [trimmed, ...history.filter((item) => item !== trimmed)].slice(0, max);
}

/** 删除单条；不存在时原样返回。 */
export function removeSearchHistoryEntry(history: readonly string[], keyword: string): string[] {
  return history.filter((item) => item !== keyword);
}
