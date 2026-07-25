import { describe, expect, test } from "bun:test";
import type { DanmakuEvent } from "../src/shared/types/live";
import {
  formatSuperChatAmount,
  formatSuperChatDuration,
  retainSuperChatItems,
  safeSuperChatColor,
  superChatDedupeKey,
  superChatPalette,
  type SuperChatLine,
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
      price: 30,
      currency: "CNY",
      background_color: "#2A60B2",
      background_bottom_color: "#1D4A92",
      duration: 60,
    },
    ...overrides,
  };
}

describe("Super Chat presentation", () => {
  test("formats validated price and duration", () => {
    const event = superChat();
    expect(formatSuperChatAmount(event.super_chat)).toBe("¥30");
    expect(formatSuperChatDuration(event.super_chat)).toBe("1 分钟");
  });

  test("does not expose unsafe colours to inline styles", () => {
    expect(safeSuperChatColor("url(javascript:alert(1))")).toBeNull();
    expect(safeSuperChatColor("#abc")).toBe("#abc");
    expect(superChatPalette({ background_color: "url(bad)" })).toBeNull();
    expect(superChatPalette(superChat().super_chat)).toMatchObject({
      senderBackground: "#2A60B2",
      senderForeground: "#ffffff",
      amountForeground: "#2A60B2",
    });
    expect(superChatPalette({ background_color: "#ffcc33" })).toEqual({
      senderBackground: "#ffcc33",
      senderForeground: "#172033",
      amountForeground: "#ffcc33",
    });

    // The Bilibili protocol supplies a tier-dependent background colour. The
    // compact card applies it only to the sender label, so amount tiers remain
    // distinguishable without a coloured strip down the card edge.
    expect(superChatPalette({ background_color: "#2a60b2" })?.senderBackground).not.toBe(
      superChatPalette({ background_color: "#e09443" })?.senderBackground,
    );
  });
});

describe("Super Chat queue helpers", () => {
  test("prefers the stable SC id when de-duplicating", () => {
    const first = superChat({ ts: 1 });
    const replay = superChat({ ts: 999, content: "同一条重放" });
    expect(superChatDedupeKey(first)).toBe(superChatDedupeKey(replay));
  });

  test("uses a conservative fallback key and retains only the newest items", () => {
    const first = superChat({ super_chat: { price: 30 }, ts: 1 });
    const replay = superChat({ super_chat: { price: 30 }, ts: 1 });
    const different = superChat({ super_chat: { price: 30 }, ts: 2 });
    expect(superChatDedupeKey(first)).toBe(superChatDedupeKey(replay));
    expect(superChatDedupeKey(first)).not.toBe(superChatDedupeKey(different));

    const lines: SuperChatLine[] = [
      { id: 1, event: first },
      { id: 2, event: different },
    ];
    expect(
      retainSuperChatItems(lines, [{ id: 3, event: superChat({ ts: 3 }) }], 2).map(
        (line) => line.id,
      ),
    ).toEqual([2, 3]);
  });
});
