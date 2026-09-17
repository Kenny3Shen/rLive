import { describe, expect, test } from "bun:test";
import {
  addSearchHistoryEntry,
  MAX_SEARCH_HISTORY_ITEMS,
  readSearchHistory,
  removeSearchHistoryEntry,
  writeSearchHistory,
} from "../src/shared/searchHistory";

function memoryStorage(initial?: Record<string, string>) {
  const values = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

function throwingStorage() {
  return {
    getItem: () => {
      throw new Error("storage disabled");
    },
    setItem: () => {
      throw new Error("storage disabled");
    },
  };
}

describe("search history memory", () => {
  test("puts the newest keyword first and dedupes", () => {
    let history = addSearchHistoryEntry([], " 主播 ");
    expect(history).toEqual(["主播"]);
    history = addSearchHistoryEntry(history, "房间号");
    expect(history).toEqual(["房间号", "主播"]);
    // 已存在的词提到最前，不产生重复项。
    history = addSearchHistoryEntry(history, "主播");
    expect(history).toEqual(["主播", "房间号"]);
  });

  test("ignores empty keywords", () => {
    expect(addSearchHistoryEntry(["a"], "   ")).toEqual(["a"]);
    expect(addSearchHistoryEntry([], "")).toEqual([]);
  });

  test("caps the list at the limit", () => {
    let history: string[] = [];
    for (let index = 0; index < MAX_SEARCH_HISTORY_ITEMS + 5; index += 1) {
      history = addSearchHistoryEntry(history, `词${index}`);
    }
    expect(history).toHaveLength(MAX_SEARCH_HISTORY_ITEMS);
    expect(history[0]).toBe(`词${MAX_SEARCH_HISTORY_ITEMS + 4}`);
  });

  test("removes a single entry", () => {
    expect(removeSearchHistoryEntry(["a", "b", "c"], "b")).toEqual(["a", "c"]);
    expect(removeSearchHistoryEntry(["a"], "missing")).toEqual(["a"]);
  });

  test("round-trips through storage under an isolated key", () => {
    const storage = memoryStorage();
    writeSearchHistory("live_search_history", ["斗鱼", "虎牙"], storage);
    expect(readSearchHistory("live_search_history", storage)).toEqual(["斗鱼", "虎牙"]);
    // 另一个搜索表面用别的键，互不污染。
    expect(readSearchHistory("video_search_history", storage)).toEqual([]);
  });

  test("treats damaged or missing records as empty history", () => {
    expect(readSearchHistory("live_search_history", memoryStorage())).toEqual([]);
    for (const raw of ["}{", '"x"', "null", "{}", "[1, 2]", '["", "ok"]']) {
      expect(readSearchHistory("live_search_history", memoryStorage({ live_search_history: raw }))).toEqual(
        raw === '["", "ok"]' ? ["ok"] : [],
      );
    }
  });

  test("survives unavailable storage", () => {
    const storage = throwingStorage();
    expect(() => writeSearchHistory("live_search_history", ["a"], storage)).not.toThrow();
    expect(readSearchHistory("live_search_history", storage)).toEqual([]);
    expect(readSearchHistory("live_search_history", null)).toEqual([]);
    expect(addSearchHistoryEntry([], "a")).toEqual(["a"]);
  });
});
