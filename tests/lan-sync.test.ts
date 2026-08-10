import { describe, expect, test } from "bun:test";
import {
  lanSyncCountdown,
  normalizeLanSyncCode,
  profileImportSummary,
  validateLanSyncReceiver,
} from "../src/features/settings/lanSync";

describe("LAN profile sync", () => {
  test("normalizes pairing codes to six digits", () => {
    expect(normalizeLanSyncCode("12a 34-567")).toBe("123456");
  });

  test("requires both the sender address and a complete pairing code", () => {
    expect(validateLanSyncReceiver("", "123456")).toContain("同步地址");
    expect(validateLanSyncReceiver("192.168.1.20:43210", "12345")).toContain("6 位");
    expect(validateLanSyncReceiver("192.168.1.20:43210", "123456")).toBeNull();
  });

  test("formats a bounded session countdown", () => {
    expect(lanSyncCountdown(65_000, 0)).toBe("1:05");
    expect(lanSyncCountdown(1_000, 2_000)).toBe("0:00");
  });

  test("summarizes every portable imported data group", () => {
    expect(
      profileImportSummary({
        follows: 2,
        iptv_favorites: 3,
        iptv_favorite_groups: 1,
        tags: 4,
        history: 5,
        settings: true,
      }),
    ).toContain("3 个 IPTV 关注");
  });
});
