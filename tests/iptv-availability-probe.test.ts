import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import {
  iptvCheckIdentity,
  type IptvAvailabilityState,
  type IptvChannelAvailability,
} from "../src/features/iptv/availability";
import {
  cancelIptvAvailabilityProbe,
  probeIptvAvailability,
} from "../src/features/iptv/availabilityProbe";
import { useIptvAvailabilityStore } from "../src/features/iptv/availabilityStore";
import type { IptvChannel } from "../src/features/iptv/types";
import { deferred } from "./helpers/async";

const sourceUrl = "https://a/list.m3u";
const channel: IptvChannel = {
  id: "one",
  name: "频道",
  group: "",
  logo: null,
  url: "https://a/live.m3u8",
  protocol: "hls",
  headers: {},
};
const identity = iptvCheckIdentity(channel);
const result: IptvChannelAvailability = {
  url: channel.url,
  available: true,
  latencyMs: 10,
  httpStatus: 200,
  message: null,
};
const store = useIptvAvailabilityStore;
let windowDescriptor: PropertyDescriptor | undefined;
let tauriDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  cancelIptvAvailabilityProbe();
  store.setState({
    cacheBySource: new Map(),
    byIdentity: new Map(),
    sourceUrl: null,
    progress: null,
    lastCheckedAt: null,
  });
  windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  tauriDescriptor = Object.getOwnPropertyDescriptor(globalThis, "isTauri");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  Object.defineProperty(globalThis, "isTauri", { configurable: true, value: true });
});
afterEach(() => {
  cancelIptvAvailabilityProbe();
  clearMocks();
  if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
  else Reflect.deleteProperty(globalThis, "window");
  if (tauriDescriptor) Object.defineProperty(globalThis, "isTauri", tauriDescriptor);
  else Reflect.deleteProperty(globalThis, "isTauri");
});

describe("IPTV 检测批次与缓存反馈", () => {
  test("播放失败优先于在途浅探测，下一次手动检测可强制更新", async () => {
    const response = deferred<IptvChannelAvailability[]>();
    mockIPC(() => response.promise);
    const work = probeIptvAvailability([channel], { sourceUrl });
    expect(store.getState().byIdentity.get(identity)?.status).toBe("checking");
    store.getState().recordPlaybackStatus(sourceUrl, channel, "error", "分片失败", 2);
    response.resolve([result]);
    await work;
    expect(store.getState().byIdentity.get(identity)?.status).toBe("unavailable");
    expect(store.getState().progress).toBeNull();
    mockIPC(() => [result]);
    await probeIptvAvailability([channel], { sourceUrl });
    expect(store.getState().cacheBySource.get(sourceUrl)?.get(identity)?.status).toBe("available");
  });
  test("取消恢复已有结果并删除未知检测中条目，迟到结果不回写", async () => {
    const previous: IptvAvailabilityState = {
      status: "unavailable",
      latencyMs: 8,
      httpStatus: 403,
      message: "403",
      checkedAt: 1,
    };
    store.getState().resetForSource(sourceUrl);
    store.getState().setManyAvailability([{ identity, state: previous }], sourceUrl);
    const unknown = { ...channel, url: "https://a/other.m3u8" };
    const response = deferred<IptvChannelAvailability[]>();
    mockIPC(() => response.promise);
    const work = probeIptvAvailability([channel, unknown], { sourceUrl });
    cancelIptvAvailabilityProbe();
    expect(store.getState().byIdentity.get(identity)).toEqual(previous);
    expect(store.getState().byIdentity.has(iptvCheckIdentity(unknown))).toBe(false);
    response.resolve([result]);
    expect(await work).toBeNull();
    expect(store.getState().byIdentity.get(identity)).toEqual(previous);
  });
  test("IPC 失败不丢已有缓存且不遗留检测中", async () => {
    mockIPC(() => {
      throw new Error("offline");
    });
    expect(await probeIptvAvailability([channel], { sourceUrl })).toBeNull();
    expect(store.getState().byIdentity.size).toBe(0);
    expect(store.getState().progress).toBeNull();
  });
});
