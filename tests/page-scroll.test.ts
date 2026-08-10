import { beforeEach, describe, expect, test } from "bun:test";
import {
  PAGE_SCROLL_MEMORY_LIMIT,
  clearPageScrollMemory,
  pageScrollKey,
  pageScrollRestoreSettled,
  recallPageScroll,
  rememberPageScroll,
  shouldRestorePageScroll,
} from "../src/app/layout/pageScroll";

const HOME = pageScrollKey("entry-1", "/|bilibili|iptv-default", null);
const ROOM_RETURN = pageScrollKey("entry-1", "/|bilibili|iptv-default", null);

beforeEach(() => {
  clearPageScrollMemory();
});

describe("page scroll memory", () => {
  test("recalls a stored position and defaults unknown surfaces to the top", () => {
    rememberPageScroll(HOME, 1240);
    expect(recallPageScroll(HOME)).toBe(1240);
    expect(recallPageScroll(pageScrollKey("entry-2", "/|bilibili|iptv-default", null))).toBe(0);
  });

  test("separates platforms and IPTV follow groups sharing one history entry", () => {
    const bilibili = pageScrollKey("entry-1", "/|bilibili|iptv-default", null);
    const huya = pageScrollKey("entry-1", "/|huya|iptv-default", null);
    const iptvGroup = pageScrollKey("entry-1", "/follow|all|iptv-default", "cctv");
    const otherGroup = pageScrollKey("entry-1", "/follow|all|iptv-default", "sports");

    rememberPageScroll(bilibili, 900);
    rememberPageScroll(iptvGroup, 300);

    expect(recallPageScroll(huya)).toBe(0);
    expect(recallPageScroll(otherGroup)).toBe(0);
    expect(recallPageScroll(bilibili)).toBe(900);
  });

  test("clamps negative offsets and ignores non-finite ones", () => {
    rememberPageScroll(HOME, -40);
    expect(recallPageScroll(HOME)).toBe(0);

    rememberPageScroll(HOME, 220);
    rememberPageScroll(HOME, Number.NaN);
    expect(recallPageScroll(HOME)).toBe(220);
  });

  test("evicts the least recently written surface past the limit", () => {
    for (let i = 0; i < PAGE_SCROLL_MEMORY_LIMIT; i += 1) {
      rememberPageScroll(pageScrollKey(`entry-${i}`, "/", null), i + 1);
    }
    // Touch the oldest so eviction takes the next-oldest instead.
    rememberPageScroll(pageScrollKey("entry-0", "/", null), 10);
    rememberPageScroll(pageScrollKey("entry-overflow", "/", null), 99);

    expect(recallPageScroll(pageScrollKey("entry-0", "/", null))).toBe(10);
    expect(recallPageScroll(pageScrollKey("entry-1", "/", null))).toBe(0);
    expect(recallPageScroll(pageScrollKey("entry-overflow", "/", null))).toBe(99);
  });
});

describe("scroll restore eligibility", () => {
  const back = {
    navigationType: "POP" as const,
    previousEntryKey: "room-entry",
    entryKey: "entry-1",
    previousSurfaceKey: pageScrollKey("room-entry", "/room/bilibili/1|bilibili|iptv-default", null),
    surfaceKey: ROOM_RETURN,
  };

  test("restores when Back returns to a different history entry", () => {
    expect(shouldRestorePageScroll(back)).toBe(true);
  });

  test("starts pushed and replaced navigations at the top", () => {
    expect(shouldRestorePageScroll({ ...back, navigationType: "PUSH" })).toBe(false);
    expect(shouldRestorePageScroll({ ...back, navigationType: "REPLACE" })).toBe(false);
  });

  test("keeps a platform switch inside one entry at the top", () => {
    // A swipe between platforms is a POP-free surface change under the same
    // entry: different rooms the user has not seen at this offset.
    expect(
      shouldRestorePageScroll({
        navigationType: "POP",
        previousEntryKey: "entry-1",
        entryKey: "entry-1",
        previousSurfaceKey: pageScrollKey("entry-1", "/|bilibili|iptv-default", null),
        surfaceKey: pageScrollKey("entry-1", "/|huya|iptv-default", null),
      }),
    ).toBe(false);
  });
});

describe("restore settling", () => {
  test("accepts sub-pixel and overshooting landings", () => {
    expect(pageScrollRestoreSettled(1199.6, 1200)).toBe(true);
    expect(pageScrollRestoreSettled(1240, 1200)).toBe(true);
  });

  test("keeps retrying while the list is still too short", () => {
    expect(pageScrollRestoreSettled(400, 1200)).toBe(false);
  });
});
