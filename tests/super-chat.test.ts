import { describe, expect, test } from "bun:test";
import type { DanmakuEvent } from "../frontend/shared/types/live";
import {
  formatSuperChatAmount,
  formatSuperChatDuration,
  retainSuperChatItems,
  safeSuperChatColor,
  superChatAvatarUrl,
  superChatDedupeKey,
  superChatPalette,
  superChatRemainingSeconds,
  type SuperChatLine,
} from "../frontend/features/room/superChat";

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
  test("normalizes only trusted Bilibili sender avatar URLs", () => {
    expect(superChatAvatarUrl({ avatar_url: "//i0.hdslb.com/bfs/face/sc-user.jpg" })).toBe(
      "https://i0.hdslb.com/bfs/face/sc-user.jpg",
    );
    expect(
      superChatAvatarUrl({ avatar_url: "https://user:pass@i0.hdslb.com/face.jpg" }),
    ).toBeNull();
    expect(superChatAvatarUrl({ avatar_url: "https://evil.example/face.jpg" })).toBeNull();
    expect(superChatAvatarUrl({ avatar_url: "javascript:alert(1)" })).toBeNull();
  });

  test("formats validated price and duration", () => {
    const event = superChat();
    expect(formatSuperChatAmount(event.super_chat)).toBe("¥30");
    expect(formatSuperChatDuration(event.super_chat)).toBe("1 分钟");
  });

  test("does not expose unsafe colours to inline styles", () => {
    expect(safeSuperChatColor("url(javascript:alert(1))")).toBeNull();
    expect(safeSuperChatColor("#abc")).toBe("#abc");
    expect(superChatPalette({ background_color: "url(bad)" })).toBeNull();
    expect(superChatPalette(superChat().super_chat)).toEqual({
      messageStart: "#2A60B2",
      messageEnd: "#1D4A92",
      headerForeground: "#ffffff",
      contentForeground: "#ffffff",
    });
    expect(superChatPalette({ background_color: "#ffcc33" })).toEqual({
      messageStart: "#ffcc33",
      messageEnd: "#ffcc33",
      headerForeground: "#172033",
      contentForeground: "#172033",
    });
    expect(
      superChatPalette({ background_color: "#2a60b2", background_bottom_color: "url(bad)" }),
    ).toEqual({
      messageStart: "#2a60b2",
      messageEnd: "#2a60b2",
      headerForeground: "#ffffff",
      contentForeground: "#ffffff",
    });
    expect(superChatPalette({ background_color: "#2a60b280" })).toEqual({
      messageStart: "#2a60b2",
      messageEnd: "#2a60b2",
      headerForeground: "#ffffff",
      contentForeground: "#ffffff",
    });

    // Validated tier colours remain visibly distinct in the message band.
    expect(superChatPalette({ background_color: "#2a60b2" })?.messageStart).not.toBe(
      superChatPalette({ background_color: "#e09443" })?.messageStart,
    );
  });

  test("uses per-band contrast and counts down from the receive timestamp", () => {
    expect(
      superChatPalette({ background_color: "#ffcccc", background_bottom_color: "#b81830" }),
    ).toEqual({
      messageStart: "#ffcccc",
      messageEnd: "#b81830",
      headerForeground: "#172033",
      contentForeground: "#ffffff",
    });

    const info = { duration: 105 };
    expect(superChatRemainingSeconds(info, 1_000_000, 1_000_000)).toBe(105);
    expect(superChatRemainingSeconds(info, 1_000_000, 1_001_900)).toBe(104);
    expect(superChatRemainingSeconds(info, 1_000_000, 1_105_000)).toBe(0);
    expect(superChatRemainingSeconds(info, Number.NaN, 1_001_900)).toBe(105);
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
