import { describe, expect, test } from "bun:test";
import {
  FOLLOW_STATUS_REFRESH_INTERVAL_MS,
  followStatusRefreshDelay,
} from "../src/features/follow/followRefresh";

describe("follow status refresh scheduling", () => {
  test("refreshes immediately when nothing has been fetched yet", () => {
    expect(followStatusRefreshDelay(0, 1_700_000_000_000)).toBe(0);
  });

  test("resumes the existing cadence when a page is revisited", () => {
    const now = 1_700_000_000_000;
    // Re-entering the page 10s after the last refresh must wait out the rest of
    // the interval instead of issuing another remote status request.
    expect(followStatusRefreshDelay(now - 10_000, now)).toBe(
      FOLLOW_STATUS_REFRESH_INTERVAL_MS - 10_000,
    );
  });

  test("refreshes at once when the cached status is older than one interval", () => {
    const now = 1_700_000_000_000;
    expect(followStatusRefreshDelay(now - FOLLOW_STATUS_REFRESH_INTERVAL_MS, now)).toBe(0);
    expect(followStatusRefreshDelay(now - 10 * FOLLOW_STATUS_REFRESH_INTERVAL_MS, now)).toBe(0);
  });

  test("never waits longer than one interval when the clock moves backwards", () => {
    const now = 1_700_000_000_000;
    expect(followStatusRefreshDelay(now + 5 * FOLLOW_STATUS_REFRESH_INTERVAL_MS, now)).toBe(0);
  });

  test("honours a custom interval", () => {
    const now = 1_700_000_000_000;
    expect(followStatusRefreshDelay(now - 2_000, now, 5_000)).toBe(3_000);
  });
});
