import { describe, expect, test } from "bun:test";
import type { DanmakuEvent } from "../src/shared/types/live";
import {
  DEFAULT_SUPER_CHAT_DURATION_MS,
  MAX_SUPER_CHAT_DEDUPE_KEYS,
  siteSupportsSuperChat,
  superChatDedupeKey,
  superChatDurationMs,
  superChatDurationSeconds,
} from "../src/features/room/superChat";

function superChat(overrides: Partial<DanmakuEvent> = {}): DanmakuEvent {
  return {
    kind: "super_chat",
    user: "Alice",
    content: "加油",
    color: null,
    ts: 1,
    super_chat: {
      id: "100",
      duration: 60,
    },
    ...overrides,
  };
}

describe("Super Chat presentation", () => {
  test("enables SC only for Bilibili", () => {
    expect(siteSupportsSuperChat("bilibili")).toBe(true);
    expect(siteSupportsSuperChat("douyu")).toBe(false);
    expect(siteSupportsSuperChat(undefined)).toBe(false);
  });

  test("accepts the complete validated duration range and converts seconds", () => {
    expect(superChatDurationSeconds({ duration: 1 })).toBe(1);
    expect(superChatDurationMs({ duration: 1 })).toBe(1_000);
    expect(superChatDurationSeconds({ duration: 86_400 })).toBe(86_400);
    expect(superChatDurationMs({ duration: 86_400 })).toBe(86_400_000);
  });

  test("falls back for missing or invalid duration values", () => {
    const invalidValues: SuperChatInfoLike[] = [
      {},
      { duration: null },
      { duration: 0 },
      { duration: -1 },
      { duration: 1.5 },
      { duration: Number.NaN },
      { duration: Number.POSITIVE_INFINITY },
      { duration: 86_401 },
    ];
    for (const info of invalidValues) {
      expect(superChatDurationSeconds(info)).toBeNull();
      expect(superChatDurationMs(info)).toBe(DEFAULT_SUPER_CHAT_DURATION_MS);
    }
  });
});

type SuperChatInfoLike = { duration?: number | null };

describe("Super Chat de-duplication", () => {
  test("prefers the stable SC id when replayed", () => {
    const first = superChat({ ts: 1 });
    const replay = superChat({ ts: 999, content: "同一条重放" });
    expect(superChatDedupeKey(first)).toBe(superChatDedupeKey(replay));
  });

  test("uses a bounded key budget for the floating subscriber", () => {
    expect(MAX_SUPER_CHAT_DEDUPE_KEYS).toBe(240);
    const first = superChat({ super_chat: { duration: 60 }, ts: 1 });
    const replay = superChat({ super_chat: { duration: 60 }, ts: 1 });
    expect(superChatDedupeKey(first)).toBe(superChatDedupeKey(replay));
  });
});
