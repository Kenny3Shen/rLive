import { describe, expect, test } from "bun:test";
import {
  activeRecordingForContext,
  applyRecordingProgress,
  createSharedRecordingChangeSubscription,
  recordingEndedPlaybackTime,
  recordingSeekReached,
  type RecordingContext,
  type RecordingItem,
} from "../src/features/recording/recording";
import {
  recordingIdFromPlaybackParams,
  recordingPlaybackPath,
} from "../src/features/recording/recordingRoute";
import { shouldPromptBeforeRecordingLeave } from "../src/features/recording/RecordingLeaveGuard";
import { pickRecordingLine } from "../src/features/recording/recordingSource";
import {
  filterRecordedDanmakuEntries,
  parseRecordedDanmakuSidecar,
  type RecordedDanmakuEntry,
} from "../src/features/recording/recordedDanmaku";
import {
  layoutRecordedDanmaku,
  RECORDED_DANMAKU_MAX_DELAY_MS,
  visibleRecordedDanmaku,
  type RecordedDanmakuLayoutOptions,
} from "../src/features/recording/recordedDanmakuLayout";
import type { PlayUrl } from "../src/shared/types/live";
import { deferred, settle } from "./helpers/async";

const context: RecordingContext = {
  source: { url: "https://example.test/live.flv", headers: {} },
  sourceKey: "live:bilibili:100",
  sourceKind: "live",
  siteId: "bilibili",
  roomId: "100",
  title: "测试直播间",
};
function recording(overrides: Partial<RecordingItem> = {}): RecordingItem {
  return {
    id: "recording-1",
    source_key: context.sourceKey,
    source_kind: "live",
    site_id: "bilibili",
    room_id: "100",
    title: context.title,
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
    file_path: "/recordings/1/stream.flv",
    error: null,
    ...overrides,
  };
}

describe("录制订阅所有权", () => {
  test("共用原生监听、重复订阅引用计数，最后退订仅清理一次", async () => {
    let registrations = 0;
    let cleanups = 0;
    let emit = () => {};
    const subscribe = createSharedRecordingChangeSubscription(
      async (handler) => {
        registrations += 1;
        emit = handler;
        return () => {
          cleanups += 1;
        };
      },
      (subscriber: { count: number }) => {
        subscriber.count += 1;
      },
    );
    const first = { count: 0 };
    const other = { count: 0 };
    const off1 = subscribe(first);
    const off2 = subscribe(first);
    const off3 = subscribe(other);
    await settle();
    emit();
    expect([registrations, first.count, other.count]).toEqual([1, 1, 1]);
    off1();
    emit();
    expect(first.count).toBe(2);
    off2();
    emit();
    expect([first.count, other.count]).toEqual([2, 3]);
    off3();
    off3();
    expect(cleanups).toBe(1);
  });

  test("StrictMode 重挂载时回收迟到监听，旧回调不能通知新订阅", async () => {
    const pending = [deferred<() => void>(), deferred<() => void>()];
    const handlers: (() => void)[] = [];
    let cleanups = 0;
    let notifications = 0;
    const subscribe = createSharedRecordingChangeSubscription(
      (handler) => {
        handlers.push(handler);
        return pending[handlers.length - 1]!.promise;
      },
      () => {
        notifications += 1;
      },
    );
    const off = subscribe("client");
    await settle();
    off();
    const offAgain = subscribe("client");
    pending[0]!.resolve(() => {
      cleanups += 1;
    });
    await settle();
    expect([handlers.length, cleanups]).toEqual([2, 1]);
    pending[1]!.resolve(() => {
      cleanups += 1;
    });
    await settle();
    handlers.forEach((handler) => handler());
    expect(notifications).toBe(1);
    offAgain();
    expect(cleanups).toBe(2);
  });
});

describe("录制状态与播放边界", () => {
  test("进度只更新活动录制且不倒退，结束后的迟到事件不覆盖结果", () => {
    const active = recording({ duration_ms: 2_000, size_bytes: 1_024, danmaku_count: 3 });
    const completed = recording({ id: "completed", status: "completed" });
    const progress = { recordingId: active.id, durationMs: 3_000, sizeBytes: 512, danmakuCount: 5 };
    const updated = applyRecordingProgress([active, completed], progress)!;
    expect(updated[0]).toMatchObject({ duration_ms: 3_000, size_bytes: 1_024, danmaku_count: 5 });
    expect(updated[1]).toBe(completed);
    const finished = [completed];
    expect(applyRecordingProgress(finished, { ...progress, recordingId: completed.id })).toBe(
      finished,
    );
  });

  test("提前 EOF 不冒充播完，非末尾 seek 不因媒体结束而成功", () => {
    expect(recordingEndedPlaybackTime(20, 60, 1.5)).toBe(20);
    expect(recordingEndedPlaybackTime(59, 60, 1.5)).toBe(60);
    expect(recordingSeekReached(20, 20, 60, true, 1.5)).toBe(false);
    expect(recordingSeekReached(59, 60, 60, true, 1.5)).toBe(true);
    expect(recordingSeekReached(20, 20, 60, false, 1.5)).toBe(true);
  });

  test.each([
    [{}, true],
    [{ source_key: "legacy" }, true],
    [{ source_key: "other", room_id: "200" }, false],
    [{ status: "completed" }, false],
  ] as const)("活动录制按稳定键或房间身份匹配：%j", (patch, matched) => {
    const active = recording(patch);
    expect(activeRecordingForContext([active], context)).toBe(matched ? active : null);
  });

  test("空身份不能串用其他录制", () => {
    const anonymous = recording({ source_key: " ", site_id: null, room_id: null });
    expect(
      activeRecordingForContext([anonymous], {
        ...context,
        sourceKey: "",
        siteId: undefined,
        roomId: undefined,
      }),
    ).toBeNull();
    expect(activeRecordingForContext([recording()], null)).toBeNull();
  });

  test.each([
    [{}, "/", true],
    [{ continue_on_leave: true }, "/", false],
    [{ status: "completed" }, "/", false],
    [{}, "/room/bilibili/100", false],
  ] as const)("离开只确认需要停止的活动任务：%j/%s", (patch, to, expected) => {
    expect(shouldPromptBeforeRecordingLeave(recording(patch), "/room/bilibili/100", to)).toBe(
      expected,
    );
  });
});

function entries(times: number[], content = "加油"): RecordedDanmakuEntry[] {
  return parseRecordedDanmakuSidecar(
    times
      .map((offset_ms, i) =>
        JSON.stringify({
          offset_ms,
          events: [{ kind: "chat", user: `用户${i}`, content, color: null, ts: i }],
        }),
      )
      .join("\n"),
  );
}
function options(patch: Partial<RecordedDanmakuLayoutOptions> = {}): RecordedDanmakuLayoutOptions {
  return {
    laneCount: 4,
    stageWidth: 960,
    padding: 20,
    laneGap: 14.4,
    measure: (text) => [...text].length * 24,
    lifetimeFor: (width) => ((1000 + width) / 160) * 1000,
    staticLayout: false,
    mergeWindowMs: 0,
    maxGroupSpanMs: 30_000,
    ...patch,
  };
}

describe("录制弹幕解析与排布", () => {
  test("忽略未完整写入的尾行，执行屏蔽设置，不读未来的合并计数", () => {
    const parsed = parseRecordedDanmakuSidecar(
      JSON.stringify({
        offset_ms: 1200,
        events: [
          { kind: "chat", user: "甲", content: "普通", color: null, ts: 1 },
          { kind: "chat", user: "乙", content: "剧透", color: null, ts: 2 },
          { kind: "chat", user: "丙", content: "屏蔽用户", color: null, ts: 3 },
          { kind: "gift", user: "丁", content: "礼物", color: null, ts: 4 },
          { kind: "super_chat", user: "戊", content: "留言", color: null, ts: 5 },
          { kind: "system", user: "系统", content: "断开", color: null, ts: 6 },
        ],
      }) + "\n{",
    );
    expect(parsed).toHaveLength(5);
    expect(
      filterRecordedDanmakuEntries(parsed, {
        filterGifts: true,
        showSuperChat: false,
        shieldWords: [" 剧透 "],
        blockedUsers: ["丙"],
      }).map((value) => value.text),
    ).toEqual(["普通"]);
    const layout = layoutRecordedDanmaku(
      entries([1000, 2000, 4000]),
      options({ mergeWindowMs: 10_000 }),
    );
    expect(visibleRecordedDanmaku(layout, 2500).map((value) => value.text)).toEqual(["加油 ×2"]);
    expect(visibleRecordedDanmaku(layout, 4000).map((value) => value.text)).toEqual(["加油 ×3"]);
  });

  test("高密度车道不重叠，延迟有界；稀疏流不丢弹幕", () => {
    const dense = entries(
      Array.from({ length: 120 }, (_, i) => i * 150),
      "密集弹幕内容占满车道",
    );
    const layout = layoutRecordedDanmaku(dense, options());
    expect(layout.placements.length).toBeGreaterThan(0);
    expect(layout.placements.length).toBeLessThan(dense.length);
    for (const placement of layout.placements) {
      expect(placement.startMs - placement.entry.offsetMs).toBeLessThanOrEqual(
        RECORDED_DANMAKU_MAX_DELAY_MS,
      );
      expect(placement.startMs).toBeGreaterThanOrEqual(placement.entry.offsetMs);
    }
    for (let time = 0; time < 20_000; time += 50) {
      const lanes = new Map<number, { left: number; right: number }[]>();
      for (const bullet of visibleRecordedDanmaku(layout, time)) {
        const { placement, progress } = bullet;
        const left = 980 - (1000 + placement.width) * progress;
        const lane = lanes.get(placement.lane) ?? [];
        lane.push({ left, right: left + placement.width });
        lanes.set(placement.lane, lane);
      }
      for (const lane of lanes.values()) {
        lane.sort((a, b) => a.left - b.left);
        for (let i = 1; i < lane.length; i += 1) {
          expect(lane[i]!.left - lane[i - 1]!.right).toBeGreaterThan(-0.5);
        }
      }
    }
    const sparse = entries([0, 3000, 6000]);
    expect(
      layoutRecordedDanmaku(sparse, options()).placements.map((value) => value.startMs),
    ).toEqual([0, 3000, 6000]);
  });

  test("减少动态效果独占车道；合并不能吞掉锚点过期后的消息", () => {
    const fixed = layoutRecordedDanmaku(
      entries([0, 500, 1000, 1500]),
      options({
        laneCount: 1,
        staticLayout: true,
        lifetimeFor: () => 4000,
      }),
    );
    for (let i = 1; i < fixed.placements.length; i += 1) {
      expect(fixed.placements[i]!.startMs).toBeGreaterThanOrEqual(fixed.placements[i - 1]!.endMs);
    }
    const offsets = [0, 4000, 8000, 12000];
    const merged = layoutRecordedDanmaku(
      entries(offsets),
      options({ mergeWindowMs: 10_000, maxGroupSpanMs: 5000 }),
    );
    expect(merged.placements.length).toBeGreaterThan(1);
    expect(merged.placements.flatMap((value) => value.memberOffsets).sort((a, b) => a - b)).toEqual(
      offsets,
    );
  });
});

test("录制路由分段编码可往返，拒绝半路径与损坏编码", () => {
  const id = "bilibili_100/主播_20260820";
  const [room, session] = recordingPlaybackPath(id).replace("/recordings/play/", "").split("/");
  expect(recordingIdFromPlaybackParams(room, session)).toBe(id);
  expect(recordingIdFromPlaybackParams(room, undefined)).toBeNull();
  expect(recordingIdFromPlaybackParams(room, "%E4%B8")).toBeNull();
});

test("重新取流按线路身份而非下标选择，线路消失可回退，空列表明确报错", () => {
  const line = (source_id: string): PlayUrl => ({
    source_id,
    url: `https://${source_id}/new.flv`,
    headers: {},
    label: source_id,
    protocol: "flv",
    priority: 0,
  });
  const lines = [line("b"), line("a")];
  expect(pickRecordingLine(lines, "a")).toBe(lines[1]!);
  expect(pickRecordingLine(lines, "removed")).toBe(lines[0]!);
  expect(() => pickRecordingLine([], "a")).toThrow("平台未返回可用播放地址");
});
