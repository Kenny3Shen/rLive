import { describe, expect, test } from "bun:test";
import {
  type IptvAvailabilityState,
} from "../src/features/iptv/availability";
import { useIptvAvailabilityStore } from "../src/features/iptv/availabilityStore";

function available(): IptvAvailabilityState {
  return { status: "available", latencyMs: 80, httpStatus: 200, message: null };
}

describe("IPTV availability session store", () => {
  test("keeps results for a source and discards them on a source switch", () => {
    const store = useIptvAvailabilityStore.getState();
    store.resetForSource("https://a.example/list.m3u");
    useIptvAvailabilityStore.getState().setAvailability("https://a.example/1.m3u8", available());
    useIptvAvailabilityStore.getState().setProgress({ completed: 1, total: 1 });
    expect(useIptvAvailabilityStore.getState().byUrl.size).toBe(1);
    expect(useIptvAvailabilityStore.getState().progress).toEqual({ completed: 1, total: 1 });

    useIptvAvailabilityStore.getState().resetForSource("https://a.example/list.m3u");
    // Same source keeps the cached results, so a page re-mount does not lose them.
    expect(useIptvAvailabilityStore.getState().byUrl.size).toBe(1);

    useIptvAvailabilityStore.getState().resetForSource("https://b.example/list/index.m3u");
    expect(useIptvAvailabilityStore.getState().byUrl.size).toBe(0);
    expect(useIptvAvailabilityStore.getState().progress).toBeNull();
  });

  test("markChecked records the finished run only for the active source", () => {
    const store = useIptvAvailabilityStore.getState();
    store.resetForSource("https://a.example/list/index.m3u");
    store.setAvailability("https://a.example/1.m3u8", available());
    store.markChecked("https://a.example/list/index.m3u", 1_000);
    expect(useIptvAvailabilityStore.getState().lastCheckedAt).toBe(1_000);

    // A stale page finishing after the user switched sources must not move the timestamp.
    store.markChecked("https://a.example/list/index.m3u", 2_000);
    expect(useIptvAvailabilityStore.getState().sourceUrl).toBe("https://a.example/list/index.m3u");
  });

  test("revertChecking restores previous states and drops new unknowns", () => {
    const store = useIptvAvailabilityStore.getState();
    store.resetForSource("https://a.example/list/index.m3u");
    store.setAvailability("https://a.example/1.m3u8", available());
    const previous = new Map(useIptvAvailabilityStore.getState().byUrl);
    store.setAvailability("https://a.example/1.m3u8", { status: "checking" });
    store.setAvailability("https://a.example/2.m3u8", { status: "checking" });

    useIptvAvailabilityStore
      .getState()
      .revertChecking(
        ["https://a.example/1.m3u8", "https://a.example/2.m3u8", "https://a.example/3.m3u8"],
        previous,
      );

    const byUrl = useIptvAvailabilityStore.getState().byUrl;
    expect(byUrl.get("https://a.example/1.m3u8")).toEqual(available());
    expect(byUrl.has("https://a.example/2.m3u8")).toBe(false);
    expect(byUrl.has("https://a.example/3.m3u8")).toBe(false);
    expect(useIptvAvailabilityStore.getState().progress).toBeNull();
  });
});
