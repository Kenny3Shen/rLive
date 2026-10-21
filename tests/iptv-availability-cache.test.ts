import { beforeEach, describe, expect, test } from "bun:test";
import { iptvCheckIdentity, type IptvAvailabilityState } from "../src/features/iptv/availability";
import {
  IPTV_AVAILABILITY_CACHE_KEY,
  readIptvAvailabilityCache,
  writeIptvAvailabilityCache,
} from "../src/features/iptv/availabilityCache";
import { useIptvAvailabilityStore } from "../src/features/iptv/availabilityStore";
import type { IptvChannel } from "../src/features/iptv/types";
import { memoryStorage, throwingStorage } from "./helpers/storage";

const source = "https://a/list.m3u";
const otherSource = "https://b/list.m3u";
const channel: IptvChannel = {
  id: "one",
  name: "频道",
  group: "",
  logo: null,
  url: "https://a/live.m3u8",
  protocol: "hls",
  headers: { Referer: "https://site" },
};
const identity = iptvCheckIdentity(channel);
const available: IptvAvailabilityState = {
  status: "available",
  latencyMs: 10,
  httpStatus: 200,
  message: null,
  checkedAt: 1,
};
const store = useIptvAvailabilityStore;

beforeEach(() => {
  store.setState({
    cacheBySource: new Map(),
    byIdentity: new Map(),
    sourceUrl: null,
    progress: null,
    lastCheckedAt: null,
  });
});

describe("IPTV 本机可用性缓存", () => {
  test("多来源结果持久化，重启不恢复检测中标记", () => {
    const storage = memoryStorage();
    writeIptvAvailabilityCache(
      new Map([
        [
          source,
          new Map<string, IptvAvailabilityState>([
            [identity, available],
            ["pending", { status: "checking" }],
          ]),
        ],
        [otherSource, new Map([[identity, { ...available, status: "unavailable" as const }]])],
      ]),
      storage,
    );
    const restored = readIptvAvailabilityCache(storage);
    expect(restored.get(source)?.get(identity)).toEqual(available);
    expect(restored.get(source)?.has("pending")).toBe(false);
    expect(restored.get(otherSource)?.get(identity)?.status).toBe("unavailable");
  });
  test("损坏数据和禁用存储降级为无缓存", () => {
    expect(
      readIptvAvailabilityCache(memoryStorage({ [IPTV_AVAILABILITY_CACHE_KEY]: "{" })).size,
    ).toBe(0);
    expect(readIptvAvailabilityCache(throwingStorage()).size).toBe(0);
    expect(() => writeIptvAvailabilityCache(new Map(), throwingStorage())).not.toThrow();
  });
  test("跳过非法字段和伪造的检测中结果", () => {
    const storage = memoryStorage({
      [IPTV_AVAILABILITY_CACHE_KEY]: JSON.stringify([
        [
          source,
          [
            [identity, available],
            ["bad", { ...available, checkedAt: "yesterday" }],
            ["pending", { status: "checking" }],
          ],
        ],
      ]),
    });
    expect([...readIptvAvailabilityCache(storage).get(source)!]).toEqual([[identity, available]]);
  });
  test("切换来源后返回复用原结果，同 URL 在另一来源独立", () => {
    store.getState().resetForSource(source);
    store.getState().setManyAvailability([{ identity, state: available }], source);
    store.getState().resetForSource(otherSource);
    expect(store.getState().byIdentity.size).toBe(0);
    store.getState().recordPlaybackStatus(otherSource, channel, "error", "播放失败", 2);
    store.getState().resetForSource(source);
    expect(store.getState().byIdentity.get(identity)).toEqual(available);
    expect(store.getState().cacheBySource.get(otherSource)?.get(identity)?.status).toBe(
      "unavailable",
    );
  });
});

describe("IPTV 播放反馈", () => {
  test("连接、就绪与缓冲不修改缓存，重连耗尽才标记不可用", () => {
    store.getState().resetForSource(source);
    store.getState().setManyAvailability([{ identity, state: available }], source);
    for (const status of ["connecting", "ready", "idle"]) {
      store.getState().recordPlaybackStatus(source, channel, status, "重试中");
      expect(store.getState().byIdentity.get(identity)).toEqual(available);
    }
    store.getState().recordPlaybackStatus(source, channel, "error", "自动重连失败", 2);
    expect(store.getState().byIdentity.get(identity)).toEqual({
      status: "unavailable",
      latencyMs: null,
      httpStatus: null,
      message: "自动重连失败",
      checkedAt: 2,
    });
  });
  test("恢复播放修正失败或补齐无缓存，不重复刷新已有可用结果", () => {
    store.getState().resetForSource(source);
    store.getState().recordPlaybackStatus(source, channel, "error", null, 2);
    store.getState().recordPlaybackStatus(source, channel, "playing", null, 3);
    const playing = store.getState().byIdentity.get(identity);
    expect(playing).toMatchObject({
      status: "available",
      message: "已实际播放",
      latencyMs: null,
      checkedAt: 3,
    });
    store.getState().recordPlaybackStatus(source, channel, "playing", null, 4);
    expect(store.getState().byIdentity.get(identity)).toBe(playing);
  });
  test("同 URL 不同请求头不串状态，非活动来源反馈不污染当前列表", () => {
    store.getState().resetForSource(source);
    store.getState().setManyAvailability([{ identity, state: available }], source);
    const changed = { ...channel, headers: { Referer: "https://other" } };
    store.getState().recordPlaybackStatus(source, changed, "error", null, 2);
    expect(store.getState().byIdentity.get(identity)).toEqual(available);
    expect(store.getState().byIdentity.get(iptvCheckIdentity(changed))?.status).toBe("unavailable");
    store.getState().recordPlaybackStatus(otherSource, channel, "error", null, 3);
    expect(store.getState().byIdentity.get(identity)).toEqual(available);
  });
  test("迟到浅探测不能覆盖较新的播放失败，手动重查仍可更新", () => {
    store.getState().resetForSource(source);
    const checking: IptvAvailabilityState = { status: "checking" };
    store.getState().setManyAvailability([{ identity, state: checking }], source);
    store.getState().recordPlaybackStatus(source, channel, "error", "分片失败", 2);
    store.getState().setManyAvailability([{ identity, state: available }], source, checking);
    expect(store.getState().byIdentity.get(identity)?.status).toBe("unavailable");
    store.getState().revertChecking([identity], new Map());
    expect(store.getState().byIdentity.get(identity)?.status).toBe("unavailable");
    store.getState().setManyAvailability([{ identity, state: checking }], source);
    store.getState().setManyAvailability([{ identity, state: available }], source, checking);
    expect(store.getState().byIdentity.get(identity)).toEqual(available);
  });
  test("其他来源的迟到批次不污染当前来源", () => {
    store.getState().resetForSource(source);
    store.getState().setManyAvailability([{ identity, state: available }], otherSource);
    expect(store.getState().byIdentity.size).toBe(0);
  });
});
