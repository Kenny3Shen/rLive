import { describe, expect, test } from "bun:test";
import {
  activeRecordingCount,
  activeRecordingForContext,
  applyRecordingProgress,
  clampRecordingPlaybackTime,
  createSharedRecordingChangeSubscription,
  formatRecordingDuration,
  formatRecordingSize,
  recordingEndedPlaybackTime,
  recordingPlatformFromSearch,
  recordingSeekReached,
  recordingProtocolLabel,
  recordingUserGroupKey,
  recordingsForPlatform,
  recordingsForView,
  type RecordingContext,
  type RecordingItem,
} from "../src/features/recording/recording";
import {
  RECORDING_VIEW_PARAM,
  recordingIdFromPlaybackParams,
  recordingPlaybackPath,
  recordingViewFromSearch,
  withRecordingView,
} from "../src/features/recording/recordingRoute";
import { shouldPromptBeforeRecordingLeave } from "../src/features/recording/RecordingLeaveGuard";
import { pickRecordingLine } from "../src/features/recording/recordingSource";
import {
  activeRecordingForLiveRoom,
  autoRecordableFollows,
  followRecordingSessionKey,
  followRecordingContext,
  liveRecordingSourceKey,
} from "../src/features/recording/followRecording";
import type { FollowUser, PlayUrl } from "../src/shared/types/live";
import {
  filterRecordedDanmakuEntries,
  firstRecordedDanmakuAtOrAfter,
  parseRecordedDanmakuSidecar,
  recordedDanmakuFrame,
} from "../src/features/recording/recordedDanmaku";

const liveContext: RecordingContext = {
  source: {
    url: "https://example.test/live.flv",
    headers: {},
  },
  sourceKey: "live:bilibili:100",
  sourceKind: "live",
  siteId: "bilibili",
  roomId: "100",
  title: "测试直播间",
};

function recordingItem(overrides: Partial<RecordingItem> = {}): RecordingItem {
  return {
    id: "recording-1",
    source_key: liveContext.sourceKey,
    source_kind: "live",
    site_id: "bilibili",
    room_id: "100",
    title: liveContext.title,
    user_name: "主播",
    cover: "",
    user_avatar: "",
    protocol: "flv",
    status: "recording",
    started_at: 1,
    ended_at: null,
    duration_ms: 0,
    size_bytes: 0,
    include_danmaku: false,
    continue_on_leave: false,
    danmaku_count: 0,
    danmaku_file: null,
    file_path: "/recordings/recording-1/stream.flv",
    error: null,
    ...overrides,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("recording change subscription", () => {
  test("forwards activity progress to every shared subscriber", async () => {
    let nativeHandler:
      | ((progress?: {
          recordingId: string;
          durationMs: number;
          sizeBytes: number;
          danmakuCount: number;
        }) => void)
      | null = null;
    const received: number[] = [];
    const subscribe = createSharedRecordingChangeSubscription(
      async (handler) => {
        nativeHandler = handler;
        return () => undefined;
      },
      (_subscriber: string, progress) => {
        if (progress) received.push(progress.durationMs);
      },
    );
    const unsubscribeFirst = subscribe("first");
    const unsubscribeSecond = subscribe("second");
    await flushMicrotasks();

    nativeHandler?.({
      recordingId: "recording-1",
      durationMs: 1_500,
      sizeBytes: 2_048,
      danmakuCount: 3,
    });

    expect(received).toEqual([1_500, 1_500]);
    unsubscribeFirst();
    unsubscribeSecond();
  });

  test("shares one native listener and reference-counts duplicate subscribers", async () => {
    let registrations = 0;
    let cleanups = 0;
    let nativeHandler: (() => void) | null = null;
    const subscribe = createSharedRecordingChangeSubscription(
      async (handler) => {
        registrations += 1;
        nativeHandler = handler;
        return () => {
          cleanups += 1;
        };
      },
      (subscriber: { invalidations: number }) => {
        subscriber.invalidations += 1;
      },
    );
    const sharedClient = { invalidations: 0 };
    const otherClient = { invalidations: 0 };

    const unsubscribeFirst = subscribe(sharedClient);
    const unsubscribeSecond = subscribe(sharedClient);
    const unsubscribeOther = subscribe(otherClient);
    await flushMicrotasks();

    expect(registrations).toBe(1);
    nativeHandler?.();
    expect(sharedClient.invalidations).toBe(1);
    expect(otherClient.invalidations).toBe(1);

    unsubscribeFirst();
    nativeHandler?.();
    expect(sharedClient.invalidations).toBe(2);
    unsubscribeSecond();
    nativeHandler?.();
    expect(sharedClient.invalidations).toBe(2);
    expect(otherClient.invalidations).toBe(3);

    unsubscribeOther();
    unsubscribeOther();
    await flushMicrotasks();
    expect(cleanups).toBe(1);
  });

  test("replaces a stale async listener after a StrictMode-style remount", async () => {
    const handlers: Array<() => void> = [];
    const resolvers: Array<(cleanup: () => void) => void> = [];
    let registrations = 0;
    let firstCleanup = 0;
    let secondCleanup = 0;
    const subscriber = { invalidations: 0 };
    const subscribe = createSharedRecordingChangeSubscription(
      (handler) => {
        registrations += 1;
        handlers.push(handler);
        return new Promise((resolve) => resolvers.push(resolve));
      },
      (client: { invalidations: number }) => {
        client.invalidations += 1;
      },
    );

    const unsubscribeFirst = subscribe(subscriber);
    await flushMicrotasks();
    unsubscribeFirst();
    const unsubscribeSecond = subscribe(subscriber);
    await flushMicrotasks();
    expect(registrations).toBe(1);

    resolvers[0]!(() => {
      firstCleanup += 1;
    });
    await flushMicrotasks();
    await flushMicrotasks();
    expect(firstCleanup).toBe(1);
    expect(registrations).toBe(2);

    resolvers[1]!(() => {
      secondCleanup += 1;
    });
    await flushMicrotasks();
    handlers[0]!();
    handlers[1]!();
    expect(subscriber.invalidations).toBe(1);

    unsubscribeSecond();
    expect(secondCleanup).toBe(1);
  });
});

describe("recording progress events", () => {
  test("patches only the matching active recording with monotonic counters", () => {
    const active = recordingItem({ duration_ms: 2_000, size_bytes: 1_024, danmaku_count: 3 });
    const completed = recordingItem({ id: "completed", status: "completed", duration_ms: 5_000 });

    const updated = applyRecordingProgress([active, completed], {
      recordingId: active.id,
      durationMs: 3_000,
      sizeBytes: 512,
      danmakuCount: 5,
    });

    expect(updated?.[0]).toEqual({
      ...active,
      duration_ms: 3_000,
      size_bytes: 1_024,
      danmaku_count: 5,
    });
    expect(updated?.[1]).toBe(completed);
  });

  test("ignores late progress after the recording has finished", () => {
    const completed = recordingItem({ status: "completed", duration_ms: 5_000 });
    const items = [completed];

    expect(
      applyRecordingProgress(items, {
        recordingId: completed.id,
        durationMs: 6_000,
        sizeBytes: 2_048,
        danmakuCount: 7,
      }),
    ).toBe(items);
  });
});

describe("recording presentation helpers", () => {
  test("filters local recordings by a validated live platform", () => {
    const bilibili = recordingItem({ id: "bilibili", site_id: "bilibili" });
    const twitch = recordingItem({ id: "twitch", site_id: "twitch" });
    const iptv = recordingItem({ id: "iptv", source_kind: "iptv", site_id: null });
    const items = [bilibili, twitch, iptv];

    expect(recordingPlatformFromSearch("twitch")).toBe("twitch");
    expect(recordingPlatformFromSearch("unknown")).toBe("all");
    expect(recordingsForPlatform(items, "twitch")).toEqual([twitch]);
    expect(recordingsForPlatform(items, "all")).toBe(items);
    expect(recordingUserGroupKey(bilibili)).not.toBe(recordingUserGroupKey(twitch));
  });

  test("scopes the library by the header tab, counting every finished state as recorded", () => {
    const active = recordingItem({ id: "active", status: "recording" });
    const completed = recordingItem({ id: "completed", status: "completed" });
    const interrupted = recordingItem({ id: "interrupted", status: "interrupted" });
    const failed = recordingItem({ id: "failed", status: "failed" });
    const items = [active, completed, interrupted, failed];

    expect(recordingViewFromSearch(null)).toBe("all");
    expect(recordingViewFromSearch("recording")).toBe("recording");
    expect(recordingViewFromSearch("recorded")).toBe("recorded");
    expect(recordingViewFromSearch("bogus")).toBe("all");

    expect(recordingsForView(items, "all")).toBe(items);
    expect(recordingsForView(items, "recording")).toEqual([active]);
    expect(recordingsForView(items, "recorded")).toEqual([completed, interrupted, failed]);
  });

  test("keeps the recording view out of the address bar only when it is the default", () => {
    const params = new URLSearchParams({ platform: "twitch" });

    expect(withRecordingView(params, "all").toString()).toBe("platform=twitch");
    expect(withRecordingView(params, "recording").get(RECORDING_VIEW_PARAM)).toBe("recording");
    // The source params are never mutated in place.
    expect(params.has(RECORDING_VIEW_PARAM)).toBe(false);
  });

  test("counts only capturing tasks for the navigation badge", () => {
    expect(activeRecordingCount(undefined)).toBe(0);
    expect(activeRecordingCount([])).toBe(0);
    expect(
      activeRecordingCount([
        recordingItem({ id: "a", status: "recording" }),
        recordingItem({ id: "b", status: "recording" }),
        recordingItem({ id: "c", status: "completed" }),
        recordingItem({ id: "d", status: "interrupted" }),
        recordingItem({ id: "e", status: "failed" }),
      ]),
    ).toBe(2);
  });

  test("formats short and long durations as timecodes", () => {
    expect(formatRecordingDuration(0)).toBe("0:00");
    expect(formatRecordingDuration(65_000)).toBe("1:05");
    expect(formatRecordingDuration(3_661_000)).toBe("1:01:01");
  });

  test("bounds playback progress when a media backend reports time past EOF", () => {
    expect(clampRecordingPlaybackTime(37, 32)).toBe(32);
    expect(clampRecordingPlaybackTime(-1, 32)).toBe(0);
    expect(clampRecordingPlaybackTime(Number.NaN, 32)).toBe(0);
    expect(clampRecordingPlaybackTime(37, 0)).toBe(37);
  });

  test("does not disguise an early media EOF as the recording end", () => {
    expect(recordingEndedPlaybackTime(20, 60, 1.5)).toBe(20);
    expect(recordingEndedPlaybackTime(59, 60, 1.5)).toBe(60);
    expect(recordingEndedPlaybackTime(61, 60, 1.5)).toBe(60);
  });

  test("does not complete a non-terminal seek when media ends at its target", () => {
    expect(recordingSeekReached(20, 20, 60, true, 1.5)).toBe(false);
    expect(recordingSeekReached(59, 60, 60, true, 1.5)).toBe(true);
    expect(recordingSeekReached(20, 20, 60, false, 1.5)).toBe(true);
  });

  test("formats local storage sizes with stable units", () => {
    expect(formatRecordingSize(0)).toBe("0 B");
    expect(formatRecordingSize(1024)).toBe("1.0 KB");
    expect(formatRecordingSize(1_536)).toBe("1.5 KB");
    expect(formatRecordingSize(1024 ** 3)).toBe("1.0 GB");
  });

  test("keeps protocol labels readable in the library", () => {
    expect(recordingProtocolLabel("flv")).toBe("FLV");
    expect(recordingProtocolLabel("hls")).toBe("HLS");
    expect(recordingProtocolLabel("mpeg_ts")).toBe("MPEG-TS");
    expect(recordingProtocolLabel("native")).toBe("原生");
  });

  test("parses synchronized danmaku batches and ignores an incomplete tail", () => {
    const entries = parseRecordedDanmakuSidecar(
      JSON.stringify({
        offset_ms: 1200,
        events: [
          {
            kind: "chat",
            user: "小明",
            content: "晚上好",
            color: "#ffffff",
            ts: 1,
          },
          {
            kind: "system",
            user: "system",
            content: "连接断开",
            color: null,
            ts: 2,
          },
        ],
      }) + "\n{",
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.offsetMs).toBe(1200);
    expect(entries[0]?.text).toBe("晚上好");
    expect(firstRecordedDanmakuAtOrAfter(entries, 0)).toBe(0);
    expect(firstRecordedDanmakuAtOrAfter(entries, 1201)).toBe(1);
  });

  test("applies gift, super chat, and shield-word settings to recorded danmaku", () => {
    const entries = parseRecordedDanmakuSidecar(
      JSON.stringify({
        offset_ms: 1200,
        events: [
          { kind: "chat", user: "甲", content: "普通消息", color: null, ts: 1 },
          { kind: "chat", user: "乙", content: "包含剧透内容", color: null, ts: 2 },
          { kind: "gift", user: "丙", content: "赠送礼物", color: null, ts: 3 },
          { kind: "super_chat", user: "丁", content: "醒目留言", color: null, ts: 4 },
        ],
      }),
    );

    expect(
      filterRecordedDanmakuEntries(entries, {
        filterGifts: true,
        showSuperChat: false,
        shieldWords: [" 剧透 "],
      }).map((entry) => entry.event.content),
    ).toEqual(["普通消息"]);
    expect(
      filterRecordedDanmakuEntries(entries, {
        filterGifts: false,
        showSuperChat: true,
        shieldWords: [],
      }).map((entry) => entry.event.kind),
    ).toEqual(["chat", "chat", "gift", "super_chat"]);
  });

  test("aggregates only visible history without reading future danmaku", () => {
    const entries = parseRecordedDanmakuSidecar(
      [
        {
          offset_ms: 1000,
          events: [{ kind: "chat", user: "甲", content: "加油", color: null, ts: 1 }],
        },
        {
          offset_ms: 2000,
          events: [{ kind: "chat", user: "乙", content: "加油", color: null, ts: 2 }],
        },
        {
          offset_ms: 4000,
          events: [{ kind: "chat", user: "丙", content: "加油", color: null, ts: 3 }],
        },
      ]
        .map((batch) => JSON.stringify(batch))
        .join("\n"),
    );

    const beforeFuture = recordedDanmakuFrame(entries, 2500, 5000, 10);
    expect(beforeFuture).toHaveLength(1);
    expect(beforeFuture[0]?.text).toBe("加油 ×2");
    expect(beforeFuture[0]?.aggregationCount).toBe(2);

    const afterFuture = recordedDanmakuFrame(entries, 4000, 5000, 10);
    expect(afterFuture).toHaveLength(1);
    expect(afterFuture[0]?.text).toBe("加油 ×3");
    expect(afterFuture[0]?.aggregationCount).toBe(3);
  });
});

describe("active recording context matching", () => {
  test("matches an active session by its stable source key", () => {
    const active = recordingItem();

    expect(activeRecordingForContext([active], liveContext)).toBe(active);
  });

  test("falls back to the live site and room identity when a source key changes", () => {
    const active = recordingItem({ source_key: "legacy-live-key" });

    expect(activeRecordingForContext([active], liveContext)).toBe(active);
  });

  test("does not match an unrelated live session when the context identity is missing", () => {
    const active = recordingItem({
      source_key: "live:unknown:other",
      site_id: null,
      room_id: null,
    });
    const context: RecordingContext = {
      ...liveContext,
      sourceKey: "live:unknown:current",
      siteId: undefined,
      roomId: undefined,
    };

    expect(activeRecordingForContext([active], context)).toBeNull();
  });

  test("still matches a stable source key when the live identity is missing", () => {
    const active = recordingItem({ site_id: null, room_id: null });
    const context: RecordingContext = {
      ...liveContext,
      siteId: undefined,
      roomId: undefined,
    };

    expect(activeRecordingForContext([active], context)).toBe(active);
  });

  test("does not treat empty or whitespace-only source keys as stable identities", () => {
    const active = recordingItem({ source_key: "   ", site_id: null, room_id: null });
    const emptyContext: RecordingContext = {
      ...liveContext,
      sourceKey: "",
      siteId: undefined,
      roomId: undefined,
    };
    const whitespaceContext = { ...emptyContext, sourceKey: "  " };

    expect(activeRecordingForContext([active], emptyContext)).toBeNull();
    expect(activeRecordingForContext([active], whitespaceContext)).toBeNull();
  });

  test("normalizes a non-empty source key before matching", () => {
    const active = recordingItem({ source_key: `  ${liveContext.sourceKey}  ` });
    const context = { ...liveContext, sourceKey: ` ${liveContext.sourceKey} ` };

    expect(activeRecordingForContext([active], context)).toBe(active);
  });

  test("ignores completed sessions and unrelated active sessions", () => {
    const completed = recordingItem({ status: "completed" });
    const otherRoom = recordingItem({
      id: "recording-2",
      source_key: "live:bilibili:200",
      room_id: "200",
    });

    expect(activeRecordingForContext([completed, otherRoom], liveContext)).toBeNull();
    expect(activeRecordingForContext([recordingItem()], null)).toBeNull();
  });
});

describe("follow card recording", () => {
  const target = { site_id: "douyin" as const, room_id: " 123456 " };

  function followedRoom(overrides: Partial<FollowUser>): FollowUser {
    return {
      site_id: "douyin",
      room_id: "123456",
      user_name: "主播",
      face: "",
      tag_ids: [],
      auto_record: false,
      live_status: false,
      live_started_at: null,
      updated_at: 1,
      ...overrides,
    };
  }

  test("keeps the requested room identity in the stable source key", () => {
    expect(liveRecordingSourceKey(target)).toBe("live:douyin:123456");

    const source = { url: "https://example.test/live.flv", headers: {} };
    const context = followRecordingContext(
      target,
      {
        site_id: "douyin",
        room_id: "987654",
        title: "关注页录制",
        cover: "",
        user_name: "主播",
        user_avatar: "https://example.test/avatar.jpg",
        online: 1,
        status: true,
        notice: "",
        url: "https://live.douyin.com/123456",
        raw: {},
      },
      source,
    );

    expect(context).toMatchObject({
      source,
      sourceKey: "live:douyin:123456",
      sourceKind: "live",
      siteId: "douyin",
      roomId: "987654",
      title: "关注页录制",
      userName: "主播",
      cover: "https://example.test/avatar.jpg",
      userAvatar: "https://example.test/avatar.jpg",
    });
  });

  test("separates automatic attempts by live session", () => {
    expect(
      followRecordingSessionKey({
        ...target,
        live_started_at: 1_704_067_200_000,
      }),
    ).not.toBe(
      followRecordingSessionKey({
        ...target,
        live_started_at: 1_704_070_800_000,
      }),
    );
    expect(followRecordingSessionKey({ ...target, live_started_at: null })).toContain("unknown");
  });

  test("only auto-records live follows enabled individually", () => {
    const enabledLive = followedRoom({ auto_record: true, live_status: true });
    const disabledLive = followedRoom({ room_id: "2", live_status: true });
    const enabledOffline = followedRoom({ room_id: "3", auto_record: true });

    expect(autoRecordableFollows([enabledLive, disabledLive, enabledOffline])).toEqual([
      enabledLive,
    ]);
  });

  test("detects an active recording by requested key or canonical room identity", () => {
    const byRequestedKey = recordingItem({
      site_id: "douyin",
      room_id: "987654",
      source_key: "live:douyin:123456",
    });
    const byCanonicalRoom = recordingItem({
      site_id: "douyin",
      room_id: "123456",
      source_key: "legacy-key",
    });

    expect(activeRecordingForLiveRoom([byRequestedKey], target)).toBe(byRequestedKey);
    expect(activeRecordingForLiveRoom([byCanonicalRoom], target)).toBe(byCanonicalRoom);
    expect(
      activeRecordingForLiveRoom([byCanonicalRoom], { ...target, room_id: "other" }),
    ).toBeNull();
  });
});

describe("recording leave confirmation policy", () => {
  test("prompts for an active default session when navigating away", () => {
    expect(shouldPromptBeforeRecordingLeave(recordingItem(), "/room/bilibili/100", "/")).toBe(true);
  });

  test("does not prompt after background continuation was enabled", () => {
    expect(
      shouldPromptBeforeRecordingLeave(
        recordingItem({ continue_on_leave: true }),
        "/room/bilibili/100",
        "/",
      ),
    ).toBe(false);
  });

  test("does not prompt without an active session or a real destination change", () => {
    expect(
      shouldPromptBeforeRecordingLeave(
        recordingItem({ status: "completed" }),
        "/room/bilibili/100",
        "/",
      ),
    ).toBe(false);
    expect(
      shouldPromptBeforeRecordingLeave(recordingItem(), "/room/bilibili/100", "/room/bilibili/100"),
    ).toBe(false);
    expect(shouldPromptBeforeRecordingLeave(null, "/room/bilibili/100", "/")).toBe(false);
  });
});

describe("recording playback route", () => {
  const id = "bilibili_100/主播_20260820-192158";

  test("spends one path segment on each bundle level", () => {
    // Encoding the id as a single segment would emit %2F, which react-router
    // hands back only half-decoded, so the id would match no library item.
    const path = recordingPlaybackPath(id);
    expect(path).toBe("/recordings/play/bilibili_100/%E4%B8%BB%E6%92%AD_20260820-192158");
    expect(path).not.toContain("%2F");
  });

  test("rejoins the id from both route params", () => {
    const [roomDir, sessionDir] = recordingPlaybackPath(id)
      .replace("/recordings/play/", "")
      .split("/");
    expect(recordingIdFromPlaybackParams(roomDir, sessionDir)).toBe(id);
  });

  test("refuses a half-written or malformed playback path", () => {
    expect(recordingIdFromPlaybackParams("bilibili_100", undefined)).toBeNull();
    expect(recordingIdFromPlaybackParams(undefined, "主播_1")).toBeNull();
    expect(recordingIdFromPlaybackParams("bilibili_100", "%E4%B8")).toBeNull();
  });
});

describe("dedicated recording play url", () => {
  function line(sourceId: string, url: string): PlayUrl {
    return {
      url,
      headers: {},
      source_id: sourceId,
      label: sourceId,
      protocol: "flv",
      priority: 0,
    };
  }

  test("keeps the watched line by identity, not by position", () => {
    // A re-fetch may reorder CDNs. Selecting by index would hand the recording a
    // different line than the one on screen.
    const refetched = [
      line("cdn-b", "https://b.example/2.flv"),
      line("cdn-a", "https://a.example/2.flv"),
    ];
    expect(pickRecordingLine(refetched, "cdn-a").source_id).toBe("cdn-a");
  });

  test("falls back to the first line when the watched one is gone", () => {
    const refetched = [line("cdn-c", "https://c.example/2.flv")];
    expect(pickRecordingLine(refetched, "cdn-a").source_id).toBe("cdn-c");
    expect(pickRecordingLine(refetched).source_id).toBe("cdn-c");
  });

  test("reports an empty line list instead of returning undefined", () => {
    expect(() => pickRecordingLine([], "cdn-a")).toThrow("平台未返回可用播放地址");
  });

  test("a re-signed url differs from the one the player holds", () => {
    // The point of the re-fetch: the recording must not share the player's
    // address, or a per-request signature is consumed by two connections.
    const played = line("cdn-a", "https://a.example/live.flv?sign=first&tt=1");
    const resigned = line("cdn-a", "https://a.example/live.flv?sign=second&tt=2");
    const picked = pickRecordingLine([resigned], played.source_id);
    expect(picked.source_id).toBe(played.source_id);
    expect(picked.url).not.toBe(played.url);
  });
});
