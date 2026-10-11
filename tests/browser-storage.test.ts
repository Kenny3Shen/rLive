import { afterEach, describe, expect, test } from "bun:test";
import { browserStorage } from "../src/shared/browserStorage";
import {
  readPlayerVolume,
  rememberPlayerVolume,
  DEFAULT_PLAYER_VOLUME,
} from "../src/shared/playerVolume";
import { readSearchHistory, writeSearchHistory } from "../src/shared/searchHistory";
import {
  readPlaybackLinePreference,
  rememberPlaybackLine,
} from "../src/features/room/playback/linePreference";
import type { PlayUrl } from "../src/shared/types/live";
import { memoryStorage } from "./helpers/storage";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

const line: PlayUrl = {
  source_id: "primary",
  label: "主线路",
  protocol: "hls",
  priority: 0,
  url: "https://example.test/live.m3u8",
  headers: {},
};

function rememberDefaults() {
  rememberPlayerVolume(35, true);
  writeSearchHistory("search", ["主播"]);
  rememberPlaybackLine("room", line, 2, undefined, 100);
}

describe("浏览器记忆共用存储入口", () => {
  test("三种记忆默认访问同一存储，但互不覆盖", () => {
    const storage = memoryStorage();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { localStorage: storage },
    });
    expect(browserStorage()).toBe(storage);
    rememberDefaults();
    expect(readPlayerVolume()).toEqual({ volume: 35, muted: true });
    expect(readSearchHistory("search")).toEqual(["主播"]);
    expect(readPlaybackLinePreference("room")).toEqual({
      roomKey: "room",
      sourceId: "primary",
      index: 2,
      updatedAt: 100,
    });
  });

  test.each([
    ["无 window", undefined],
    [
      "localStorage getter 拒绝访问",
      {
        get localStorage() {
          throw new Error("禁止访问");
        },
      },
    ],
  ])("%s 时三种记忆安全降级", (_name, value) => {
    Object.defineProperty(globalThis, "window", { configurable: true, value });
    expect(browserStorage()).toBeNull();
    expect(rememberDefaults).not.toThrow();
    expect(readPlayerVolume()).toEqual({ volume: DEFAULT_PLAYER_VOLUME, muted: false });
    expect(readSearchHistory("search")).toEqual([]);
    expect(readPlaybackLinePreference("room")).toBeNull();
  });
});
