import { beforeEach, describe, expect, test } from "bun:test";
import {
  PAGE_SCROLL_ANCHOR_STABLE_FRAMES,
  PAGE_SCROLL_MEMORY_LIMIT,
  beginPageScrollRestore,
  clearPageScrollMemory,
  nextPageScrollAnchorStableFrames,
  pageScrollKey,
  pageScrollRestoreSettled,
  pageScrollTargetForAnchor,
  recallPageScroll,
  recallPageScrollSnapshot,
  rememberPageScroll,
  rememberPageScrollAnchor,
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
    // 触碰最旧的，使淘汰发生在次旧的条目上。
    rememberPageScroll(pageScrollKey("entry-0", "/", null), 10);
    rememberPageScroll(pageScrollKey("entry-overflow", "/", null), 99);

    expect(recallPageScroll(pageScrollKey("entry-0", "/", null))).toBe(10);
    expect(recallPageScroll(pageScrollKey("entry-1", "/", null))).toBe(0);
    expect(recallPageScroll(pageScrollKey("entry-overflow", "/", null))).toBe(99);
  });

  test("captures the clicked card as a viewport-relative restore anchor", () => {
    rememberPageScrollAnchor(HOME, 860, "bilibili:123", 24.5);

    expect(recallPageScrollSnapshot(HOME)).toEqual({
      top: 860,
      anchor: { key: "bilibili:123", viewportOffset: 24.5 },
    });
  });

  test("clears a stale card anchor when the user scrolls again", () => {
    rememberPageScrollAnchor(HOME, 860, "bilibili:123", 24.5);
    rememberPageScroll(HOME, 920);

    expect(recallPageScrollSnapshot(HOME)).toEqual({ top: 920, anchor: null });
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
    // 平台之间的滑动是同一条历史下不产生 POP 的表面变化：
    // 是用户在此偏移处没看过的不同房间。
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

describe("restore suppression", () => {
  test("ignores the clamped positions a restore's own writes report", () => {
    rememberPageScroll(HOME, 1240);

    const endRestore = beginPageScrollRestore(HOME);
    // 每次 `scrollTop = target` 写入都会触发 scroll 事件；列表还矮时浏览器会钳制它，
    // 存下这个值会抹掉目标。
    rememberPageScroll(HOME, 0);
    rememberPageScroll(HOME, 380);
    expect(recallPageScroll(HOME)).toBe(1240);

    endRestore();
    rememberPageScroll(HOME, 1240);
    expect(recallPageScroll(HOME)).toBe(1240);
  });

  test("resumes recording once the restore releases", () => {
    rememberPageScroll(HOME, 900);
    beginPageScrollRestore(HOME)();
    rememberPageScroll(HOME, 120);
    expect(recallPageScroll(HOME)).toBe(120);
  });

  test("suppresses only the surface being restored", () => {
    const other = pageScrollKey("entry-2", "/|huya|iptv-default", null);
    rememberPageScroll(HOME, 1240);

    const endRestore = beginPageScrollRestore(HOME);
    rememberPageScroll(other, 640);
    expect(recallPageScroll(other)).toBe(640);
    endRestore();
  });

  test("a superseded restore cannot unlock the one that replaced it", () => {
    rememberPageScroll(HOME, 1240);
    const stale = beginPageScrollRestore(HOME);
    const current = beginPageScrollRestore(HOME);

    stale();
    rememberPageScroll(HOME, 0);
    expect(recallPageScroll(HOME)).toBe(1240);

    current();
    rememberPageScroll(HOME, 200);
    expect(recallPageScroll(HOME)).toBe(200);
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

  test("realigns a card after rows are inserted ahead of it", () => {
    expect(pageScrollTargetForAnchor(860, 412, 24)).toBe(1248);
    expect(pageScrollTargetForAnchor(1248, 24, 24)).toBe(1248);
  });

  test("waits for consecutive aligned frames after the layout stops changing", () => {
    let stableFrames = 0;
    stableFrames = nextPageScrollAnchorStableFrames(24, 24, 1600, null, stableFrames);
    expect(stableFrames).toBe(0);

    stableFrames = nextPageScrollAnchorStableFrames(24, 24, 1700, 1600, stableFrames);
    expect(stableFrames).toBe(0);

    for (let frame = 0; frame < PAGE_SCROLL_ANCHOR_STABLE_FRAMES; frame += 1) {
      stableFrames = nextPageScrollAnchorStableFrames(24.4, 24, 1700, 1700, stableFrames);
    }
    expect(stableFrames).toBe(PAGE_SCROLL_ANCHOR_STABLE_FRAMES);

    expect(nextPageScrollAnchorStableFrames(30, 24, 1700, 1700, stableFrames)).toBe(0);
  });
});
