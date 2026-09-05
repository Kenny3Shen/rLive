import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PLAYER_VOLUME,
  readPlayerVolume,
  rememberPlayerVolume,
} from "../src/shared/playerVolume";

function memoryStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set("rlive-player-volume", initial);
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

describe("player volume memory", () => {
  test("restores the remembered volume and mute state", () => {
    const storage = memoryStorage();
    rememberPlayerVolume(35, true, storage);
    expect(readPlayerVolume(storage)).toEqual({ volume: 35, muted: true });

    // 静音态与音量各自独立:取消静音后音量不该被记忆里的旧静音标记重置。
    rememberPlayerVolume(35, false, storage);
    expect(readPlayerVolume(storage)).toEqual({ volume: 35, muted: false });
  });

  test("falls back to the default volume without a record", () => {
    expect(readPlayerVolume(memoryStorage())).toEqual({
      volume: DEFAULT_PLAYER_VOLUME,
      muted: false,
    });
  });

  test("ignores damaged records instead of locking the player at silence", () => {
    // 坏 JSON、非对象、缺字段、非法音量:任何一种都必须回到能听见声音的默认态。
    for (const raw of ["}{", '"80"', "null", "{}", '{"volume":"loud"}']) {
      expect(readPlayerVolume(memoryStorage(raw))).toEqual({
        volume: DEFAULT_PLAYER_VOLUME,
        muted: false,
      });
    }
    // 静音标记只认真正的 true:字符串等脏值不该让播放器静音启动。
    expect(readPlayerVolume(memoryStorage('{"volume":50,"muted":"yes"}'))).toEqual({
      volume: 50,
      muted: false,
    });
  });

  test("clamps stored volume into the media element range", () => {
    const storage = memoryStorage();
    rememberPlayerVolume(140, false, storage);
    expect(readPlayerVolume(storage).volume).toBe(100);
    rememberPlayerVolume(-20, false, storage);
    expect(readPlayerVolume(storage).volume).toBe(0);
    rememberPlayerVolume(41.6, false, storage);
    expect(readPlayerVolume(storage).volume).toBe(42);
    // 记忆之外被改坏的越界值同样在读取侧收敛。
    expect(readPlayerVolume(memoryStorage('{"volume":9999}')).volume).toBe(100);
  });

  test("survives unavailable storage", () => {
    // 隐私模式/配额耗尽:记忆失效不能把播放器带崩。
    const storage = throwingStorage();
    expect(() => rememberPlayerVolume(60, false, storage)).not.toThrow();
    expect(readPlayerVolume(storage)).toEqual({ volume: DEFAULT_PLAYER_VOLUME, muted: false });
    expect(readPlayerVolume(null)).toEqual({ volume: DEFAULT_PLAYER_VOLUME, muted: false });
  });
});
