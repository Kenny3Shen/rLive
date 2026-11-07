import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient, QueryObserver } from "@tanstack/query-core";
import {
  ACTIVE_RECORDINGS_QUERY_KEY,
  activeRecordingCount,
  activeRecordingForContext,
  applyRecordingProgress,
  createSharedRecordingChangeSubscription,
  recordingEndedPlaybackTime,
  recordingSeekReached,
  type RecordingContext,
  type RecordingItem,
} from "../src/features/recording/recording";
import { createSharedEventSubscription } from "../src/shared/sharedEventSubscription";
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
import { recordedDanmakuListEntries } from "../src/features/recording/recordedDanmakuListMapping";
import type { PlayUrl } from "../src/shared/types/live";
import { deferred, settle } from "./helpers/async";

function readSource(path: string): string {
  return readFileSync(join(import.meta.dir, "..", path), "utf8");
}

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

  test("whenReady 等到共享监听注册成功，注册失败会释放临时订阅", async () => {
    let shouldFail = true;
    let cleanups = 0;
    const subscribe = createSharedEventSubscription<string, void>(
      async () => {
        if (shouldFail) throw new Error("listen failed");
        return () => {
          cleanups += 1;
        };
      },
      () => undefined,
    );

    expect(await subscribe.whenReady("query").catch((error: Error) => error.message)).toBe(
      "listen failed",
    );
    shouldFail = false;
    const release = await subscribe.whenReady("query");
    release();
    expect(cleanups).toBe(1);
  });
});

describe("录制状态与播放边界", () => {
  test("进行中徽标只统计 recording，结束、中断与失败后清零", () => {
    expect(
      activeRecordingCount([
        recording({ id: "one" }),
        recording({ id: "two" }),
        recording({ id: "completed", status: "completed" }),
        recording({ id: "interrupted", status: "interrupted" }),
        recording({ id: "failed", status: "failed" }),
      ]),
    ).toBe(2);
    expect(activeRecordingCount([])).toBe(0);
    expect(activeRecordingCount(undefined)).toBe(0);
  });

  test("QueryObserver select 忽略录制进度变化，只在活动数量变化时通知", async () => {
    const client = new QueryClient();
    const first = recording({ duration_ms: 1_000, size_bytes: 1_024, danmaku_count: 3 });
    const second = recording({ id: "recording-2", duration_ms: 2_000 });
    const completed = recording({ id: "completed", status: "completed" });
    const initial = [first, second, completed];
    client.setQueryData(ACTIVE_RECORDINGS_QUERY_KEY, initial);
    const notifications: number[] = [];
    const observer = new QueryObserver(client, {
      queryKey: ACTIVE_RECORDINGS_QUERY_KEY,
      queryFn: async () => initial,
      select: activeRecordingCount,
      notifyOnChangeProps: ["data"],
    });
    const unsubscribe = observer.subscribe((result) => {
      notifications.push(result.data ?? -1);
    });

    expect(observer.getCurrentResult().data).toBe(2);
    client.setQueryData(ACTIVE_RECORDINGS_QUERY_KEY, [
      { ...first, duration_ms: 8_000, size_bytes: 4_096, danmaku_count: 9 },
      second,
      completed,
    ]);
    await settle();
    expect(observer.getCurrentResult().data).toBe(2);
    expect(notifications).toEqual([]);

    client.setQueryData(ACTIVE_RECORDINGS_QUERY_KEY, [
      { ...first, status: "completed" },
      second,
      completed,
    ]);
    await settle();
    expect(observer.getCurrentResult().data).toBe(1);
    expect(notifications).toEqual([1]);

    unsubscribe();
    client.clear();
  });

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

describe("录制库媒体卡片", () => {
  test("录制卡复用下载卡布局，保留观看进度和卡片及右键菜单操作", () => {
    const source = readSource("src/features/recording/RecordingsPage.tsx");
    expect(source).toContain('kind="recording"');
    expect(source).toContain("<LocalMediaArtwork");
    expect(source).toContain("<LocalMediaCardProgress");
    expect(source).toContain("<LocalMediaCardSkeleton");
    expect(source).toContain("data-player-origin={playerOrigin}");
    expect(source).toContain("data-page-scroll-anchor={playerOrigin}");
    expect(source).toContain('label="删除录制"');
    expect(source).toContain("<ContextMenu>");
    expect(source).toContain("打开文件位置");
    expect(source).toContain("停止并保存");
    expect(source).toContain("导出 ASS 弹幕字幕");
    expect(source).toContain('item.status !== "recording"');
    expect(source).not.toContain('label="播放"');
    expect(source).not.toContain("grid-cols-[repeat(auto-fill,minmax(min(100%,17rem),1fr))]");
    expect(source).not.toContain('size="sm"');
  });

  test("窄屏加载骨架保留范围、平台和用户筛选的真实高度", () => {
    const source = readSource("src/features/recording/RecordingsPage.tsx");
    const skeleton = source.slice(
      source.indexOf("function RecordingsSkeleton"),
      source.indexOf("export function RecordingsPage"),
    );
    expect(skeleton).toContain('className="h-10 w-full rounded-lg md:hidden"');
    expect(skeleton).toContain('className="h-11 w-full rounded-lg md:hidden"');
    expect(skeleton).toContain("[@media(pointer:coarse)]:h-11");
  });
});

describe("录制弹幕解析与排布", () => {
  test("画布取舞台布局尺寸，入场 transform 不缩窄离屏调度范围", () => {
    const source = readSource("src/features/recording/RecordedDanmakuCanvas.tsx");
    const resizeSource = source.slice(
      source.indexOf("function resize()"),
      source.indexOf("function scheduleFrame()"),
    );
    expect(resizeSource).toContain("Math.max(1, stage.clientWidth)");
    expect(resizeSource).toContain("Math.max(1, stage.clientHeight)");
    expect(resizeSource).not.toContain("stage.getBoundingClientRect()");
    expect(source).toContain("padding: HORIZONTAL_PADDING");
    expect(source).toContain("(cssWidth + width + HORIZONTAL_PADDING * 2) * bullet.progress");
  });

  test("回放页只有底部操作栏，画内 HUD 在窗口态可返回", () => {
    const page = readSource("src/features/recording/RecordingPlaybackPage.tsx");
    const player = readSource("src/features/recording/RecordingPlayer.tsx");
    expect(page).not.toContain("PlaybackTopBar");
    expect(page).toContain("<PlaybackFooter");
    expect(page).toContain("返回录制库");
    expect(page).toContain('value="danmaku"');
    expect(page).toContain("<RecordedDanmakuList");
    expect(player).toContain("fullscreen: true,");
    expect(player).toContain("hasActions: true,");
    expect(player).toContain("onBack={handlePlayerBack}");
    expect(player).toContain("if (fullscreen.fullscreen) void fullscreen.exit();");
    expect(player).toContain("else onNavigateBack();");
  });

  test("弹幕轨查询与解析由页面共享，播放器不重复请求", () => {
    const page = readSource("src/features/recording/RecordingPlaybackPage.tsx");
    const player = readSource("src/features/recording/RecordingPlayer.tsx");
    const track = readSource("src/features/recording/useRecordedDanmakuTrack.ts");
    expect(page).toContain("const danmakuTrack = useRecordedDanmakuTrack(item);");
    expect(track).toContain("recordingDanmakuUrl");
    expect(track).toContain("parseRecordedDanmakuSidecar");
    expect(player).not.toContain("recordingDanmakuUrl");
    expect(player).not.toContain("parseRecordedDanmakuSidecar");
  });

  test("录制列表映射保留发送者、录制内时间与图片表情", () => {
    const [entry] = parseRecordedDanmakuSidecar(
      JSON.stringify({
        offset_ms: 12_345,
        events: [
          {
            kind: "chat",
            user: "观众甲",
            content: "你好[表情]",
            color: "#ffd76a",
            spans: [
              { type: "text", text: "你好" },
              { type: "image", image_url: "https://i0.hdslb.com/bfs/emote/a.png" },
            ],
            ts: 1,
          },
        ],
      }),
    );
    expect(recordedDanmakuListEntries([entry!])[0]).toMatchObject({
      progressMs: 12_345,
      user: "观众甲",
      content: "你好[表情]",
      color: "#ffd76a",
      spans: [
        { type: "text", text: "你好" },
        { type: "image", image_url: "https://i0.hdslb.com/bfs/emote/a.png" },
      ],
    });
  });

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
