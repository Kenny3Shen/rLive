import { describe, expect, test } from "bun:test";
import { createSerialTaskQueue } from "../frontend/features/room/player/serialTaskQueue";
import {
  hlsResponseStatus,
  isHlsStream,
  isTwitchCommercialBreak,
  nextHlsFatalRecoveryAction,
  playUrlKey,
  requestPlayerAutoplay,
} from "../frontend/features/room/player/useWebPlayer";

describe("player session queue", () => {
  test("does not start the replacement until the prior lifecycle has finished", async () => {
    const queue = createSerialTaskQueue();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.enqueue(async () => {
      order.push("first:start");
      await firstGate;
      order.push("first:end");
    });
    const second = queue.enqueue(() => {
      order.push("second:start");
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  test("continues after a failed lifecycle operation", async () => {
    const queue = createSerialTaskQueue();
    const order: string[] = [];

    await expect(
      queue.enqueue(() => {
        order.push("failed");
        throw new Error("expected failure");
      }),
    ).rejects.toThrow("expected failure");

    await queue.enqueue(() => {
      order.push("replacement");
    });

    expect(order).toEqual(["failed", "replacement"]);
  });

  test("keeps an equivalent play source stable across query object replacement", () => {
    const first = playUrlKey({
      url: "https://cdn.example/live.flv",
      headers: { Referer: "https://example/", Cookie: "SESS=one" },
    });
    const equivalent = playUrlKey({
      url: "https://cdn.example/live.flv",
      headers: { Cookie: "SESS=one", Referer: "https://example/" },
    });
    const changed = playUrlKey({
      url: "https://cdn.example/live.flv",
      headers: { Cookie: "SESS=two", Referer: "https://example/" },
    });

    expect(equivalent).toBe(first);
    expect(changed).not.toBe(first);
  });

  test("routes Twitch-style HLS manifests to the HLS player path", () => {
    expect(isHlsStream("https://usher.ttvnw.net/api/channel/hls/demo.m3u8?sig=one")).toBe(true);
    expect(isHlsStream("https://cdn.example.test/live.flv")).toBe(false);
  });

  test("renews a Twitch HLS URL after one exhausted in-place recovery", () => {
    expect(nextHlsFatalRecoveryAction(1)).toEqual({ type: "restart" });
    expect(nextHlsFatalRecoveryAction(2)).toEqual({
      type: "refresh_play_url",
      retryAfterMs: 0,
    });
    expect(hlsResponseStatus({ response: { code: 403 } })).toBe(403);
    expect(nextHlsFatalRecoveryAction(1, false, true)).toEqual({
      type: "refresh_play_url",
      retryAfterMs: 0,
    });
  });

  test("treats a Twitch commercial response as temporary platform content", () => {
    expect(
      isTwitchCommercialBreak({
        response: { data: "Commercial break in progress. Please wait." },
      }),
    ).toBe(true);
    expect(nextHlsFatalRecoveryAction(2, true)).toEqual({
      type: "refresh_play_url",
      retryAfterMs: 8_000,
    });
    expect(isTwitchCommercialBreak("normal HLS manifest error")).toBe(false);
  });

  test("does not let a pending old autoplay block a replacement proxy session", async () => {
    const queue = createSerialTaskQueue();
    let resolveOldPlay: (() => void) | undefined;
    const oldPlay = new Promise<void>((resolve) => {
      resolveOldPlay = resolve;
    });
    let oldSessionCurrent = true;
    let replacementStarted = false;
    const video = { muted: false } as Pick<HTMLVideoElement, "muted">;

    await queue.enqueue(() => {
      requestPlayerAutoplay(
        { play: () => oldPlay },
        video,
        () => oldSessionCurrent,
        () => {},
      );
    });
    await queue.enqueue(() => {
      replacementStarted = true;
    });

    // A browser can leave `HTMLMediaElement.play()` pending until the live
    // stream produces its first segment. That must not retain the serialized
    // proxy queue after this room has been left.
    expect(replacementStarted).toBe(true);

    oldSessionCurrent = false;
    resolveOldPlay?.();
    await Promise.resolve();
    expect(video.muted).toBe(false);
  });
});
