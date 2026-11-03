import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { VideoDownloadItem, VideoDownloadStatus } from "../src/features/video/videoDownload";
import {
  applyVideoDownloadProgress,
  mergeVideoDownload,
  sortVideoDownloads,
  videoDownloadIsActive,
  videoDownloadNeedsPolling,
  videoDownloadPrimaryAction,
} from "../src/features/video/videoDownloadState";
import {
  shouldPopToVideoDownloadList,
  videoDownloadPlaybackEntryState,
  videoDownloadPlaybackPath,
  videoDownloadPlaybackReturnTarget,
} from "../src/features/video/videoDownloadRoute";
import { parseDownloadedDanmaku } from "../src/features/video/videoDownloadDanmaku";
import { videoCardDownloadInput } from "../src/features/video/videoCardDownload";
import type { VideoArchive } from "../src/shared/types/video";

function downloadItem(
  id: string,
  status: VideoDownloadStatus,
  createdAt: number,
): VideoDownloadItem {
  return {
    id,
    bvid: "BV1test",
    cid: 1,
    ep_id: null,
    title: id,
    cover: "",
    author: "",
    duration: 0,
    qn: 80,
    quality_label: "1080P",
    status,
    downloaded_bytes: 0,
    total_bytes: 0,
    created_at: createdAt,
    completed_at: status === "completed" ? createdAt : null,
    file_path: `${id}.mp4`,
    error: status === "failed" ? "网络中断" : null,
  };
}

function archive(overrides: Partial<VideoArchive> = {}): VideoArchive {
  return {
    bvid: "BV1test",
    aid: "1",
    cid: 11,
    title: "稿件标题",
    cover: "archive-cover",
    desc: "",
    tags: [],
    author: "稿件作者",
    author_face: null,
    author_mid: "42",
    author_fans: 0,
    author_videos: 0,
    view: 0,
    danmaku: 0,
    pubdate: 0,
    reply: 0,
    pages: [],
    ugc_season: null,
    ...overrides,
  };
}

describe("视频卡片下载入参", () => {
  test("已有 cid 时直接使用卡片信息，不依赖稿件详情", () => {
    expect(
      videoCardDownloadInput({
        bvid: "BV1card",
        cid: 22,
        title: "卡片标题",
        cover: "card-cover",
        author: "卡片作者",
        duration: 90,
      }),
    ).toEqual({
      bvid: "BV1card",
      cid: 22,
      ep_id: null,
      title: "卡片标题",
      cover: "card-cover",
      author: "卡片作者",
      duration: 90,
    });
  });

  test("缺少 cid 时选稿件详情的首个分 P，并使用该 P 的时长", () => {
    expect(
      videoCardDownloadInput(
        {
          bvid: "BV1card",
          cid: null,
          title: "列表标题",
          cover: "card-cover",
          author: "列表作者",
          duration: 999,
        },
        archive({
          pages: [
            { page: 1, cid: 31, part: "第一集", duration: 120 },
            { page: 2, cid: 32, part: "第二集", duration: 180 },
          ],
        }),
      ),
    ).toMatchObject({ cid: 31, title: "稿件标题", duration: 120 });
  });

  test("传入 archive 时仍保留显式 cid，不被首个分 P 覆盖", () => {
    expect(
      videoCardDownloadInput(
        {
          bvid: "BV1card",
          cid: 32,
          title: "列表标题",
          cover: "card-cover",
          author: "列表作者",
          duration: 180,
        },
        archive({
          pages: [
            { page: 1, cid: 31, part: "第一集", duration: 120 },
            { page: 2, cid: 32, part: "第二集", duration: 180 },
          ],
        }),
      ),
    ).toMatchObject({ cid: 32, duration: 180 });
  });

  test("单 P 稿件的 pages 为空时回退详情首 P cid", () => {
    expect(
      videoCardDownloadInput(
        {
          bvid: "BV1single",
          cid: null,
          title: "单 P",
          cover: "",
          author: "",
          duration: 75,
        },
        archive({ cid: 44 }),
      ),
    ).toMatchObject({ cid: 44, duration: 75 });
  });

  test("详情也没有有效 cid 时明确失败", () => {
    expect(() =>
      videoCardDownloadInput(
        {
          bvid: "BV1bad",
          cid: null,
          title: "",
          cover: "",
          author: "",
          duration: 0,
        },
        archive({ cid: 0 }),
      ),
    ).toThrow("无法确定这条视频的可下载分 P");
  });
});

describe("视频下载状态", () => {
  test("分组保留后端语义：仅已完成离开未完成任务", () => {
    expect(videoDownloadIsActive("completed")).toBe(false);
    for (const status of ["queued", "downloading", "paused", "merging", "failed"] as const) {
      expect(videoDownloadIsActive(status)).toBe(true);
    }
  });

  test("只轮询会自行推进的排队、下载和合并状态", () => {
    for (const status of ["queued", "downloading", "merging"] as const) {
      expect(videoDownloadNeedsPolling(status)).toBe(true);
    }
    for (const status of ["paused", "completed", "failed"] as const) {
      expect(videoDownloadNeedsPolling(status)).toBe(false);
    }
  });

  test("下载卡主入口始终由任务状态唯一决定", () => {
    expect(
      Object.fromEntries(
        (["queued", "downloading", "paused", "merging", "completed", "failed"] as const).map(
          (status) => [status, videoDownloadPrimaryAction(status)],
        ),
      ),
    ).toEqual({
      queued: "pause",
      downloading: "pause",
      paused: "resume",
      merging: null,
      completed: "play",
      failed: "retry",
    });
  });
});

describe("视频下载列表排序", () => {
  test("未完成优先，再按创建时间倒序，且不修改输入", () => {
    const input = [
      downloadItem("completed-new", "completed", 500),
      downloadItem("paused-old", "paused", 100),
      downloadItem("downloading-new", "downloading", 300),
      downloadItem("failed-old", "failed", 50),
      downloadItem("completed-old", "completed", 200),
    ];
    const originalOrder = input.map((item) => item.id);

    expect(sortVideoDownloads(input).map((item) => item.id)).toEqual([
      "downloading-new",
      "paused-old",
      "failed-old",
      "completed-new",
      "completed-old",
    ]);
    expect(input.map((item) => item.id)).toEqual(originalOrder);
  });

  test("新增或更新任务后立即按统一契约排序", () => {
    const items = [downloadItem("older", "queued", 100)];
    expect(
      mergeVideoDownload(items, downloadItem("newer", "queued", 200)).map((item) => item.id),
    ).toEqual(["newer", "older"]);

    const updated = mergeVideoDownload(items, downloadItem("older", "completed", 100));
    expect(updated.map((item) => item.id)).toEqual(["older"]);
  });

  test("进度事件更新后保持同一排序", () => {
    const items = [
      downloadItem("newer", "downloading", 200),
      downloadItem("older", "downloading", 100),
    ];
    const updated = applyVideoDownloadProgress(items, {
      id: "older",
      downloaded_bytes: 10,
      total_bytes: 20,
      status: "completed",
    });

    expect(updated.map((item) => [item.id, item.downloaded_bytes])).toEqual([
      ["newer", 0],
      ["older", 10],
    ]);
  });
});

describe("本地下载播放路由", () => {
  test("下载 id 进入可编码的独立播放路由", () => {
    expect(videoDownloadPlaybackPath("local/id 1")).toBe("/video/download/play/local%2Fid%201");
  });

  test("列表进入时优先回退，深链接回落已完成下载页", () => {
    const state = videoDownloadPlaybackEntryState("/follow?view=downloads&downloadView=active");
    expect(shouldPopToVideoDownloadList(state, 3)).toBe(true);
    expect(shouldPopToVideoDownloadList(state, 0)).toBe(false);
    expect(shouldPopToVideoDownloadList(null, 3)).toBe(false);
    expect(videoDownloadPlaybackReturnTarget(state)).toBe(
      "/follow?view=downloads&downloadView=active",
    );
    expect(videoDownloadPlaybackReturnTarget(null)).toBe(
      "/follow?view=downloads&downloadView=completed",
    );
    expect(videoDownloadPlaybackReturnTarget({ returnTo: "https://example.com" })).toBe(
      "/follow?view=downloads&downloadView=completed",
    );
  });
});

describe("下载卡媒体入口接线", () => {
  const source = readFileSync(
    new URL("../src/features/video/VideoDownloadPage.tsx", import.meta.url),
    "utf8",
  );

  test("整卡入口沿用媒体卡的缩放原点、回滚锚点与按下预加载", () => {
    expect(source).toContain("const playerOrigin = `download:${item.id}`;");
    expect(source).toContain("data-player-origin={playerOrigin}");
    expect(source).toContain("data-page-scroll-anchor={playerOrigin}");
    expect(source).toMatch(/onPointerDown=\{\(\) => \{\s+if \(playbackPath\)/);
    expect(source).toContain("playbackTrigger={");
    expect(source).toContain("<LocalMediaCard");
    expect(source).toContain('kind="download"');
  });

  test("卡片与菜单共享状态到主入口的映射", () => {
    expect(source).toContain("const primaryAction = videoDownloadPrimaryAction(item.status);");
    expect(source).toContain('primaryAction === "pause"');
    expect(source).toContain('primaryAction === "resume"');
    expect(source).toContain('primaryAction === "retry"');
    expect(source).not.toContain('label="播放"');
  });

  test("已完成列表不重复显示小标题，保留状态筛选和可访问分组", () => {
    expect(source).not.toContain(
      '<h2 className="text-sm font-semibold text-foreground">已完成</h2>',
    );
    expect(source).toContain('aria-label="已完成的下载"');
    expect(source).toContain('completed: "已完成"');
  });

  test("下载进度只用于未完成任务，次要操作与骨架复用媒体卡规范", () => {
    expect(source).toContain("progress={");
    expect(source).toContain("!playable ? (");
    expect(source).toContain("<LocalMediaCardProgress");
    expect(source).toContain("<LocalMediaCardSkeleton");
    expect(source).toContain('label="打开文件位置"');
    expect(source).toContain('label="使用系统播放器"');
    expect(source).toContain('label="删除下载"');
  });
});

describe("本地下载播放字幕与排版", () => {
  const playbackSource = readFileSync(
    new URL("../src/features/video/VideoDownloadPlaybackPage.tsx", import.meta.url),
    "utf8",
  );
  const playerSource = readFileSync(
    new URL("../src/features/video/LocalDownloadPlayer.tsx", import.meta.url),
    "utf8",
  );
  const contractSource = readFileSync(
    new URL("../src/features/video/videoDownload.ts", import.meta.url),
    "utf8",
  );

  test("播放信息直接携带离线字幕轨与失败原因", () => {
    expect(contractSource).toContain("subtitles: VideoDownloadSubtitle[];");
    expect(contractSource).toContain("subtitle_error: string | null;");
    expect(contractSource).toContain("export type VideoDownloadSubtitle = {");
    expect(playbackSource).toContain("const subtitles = playback.data?.subtitles ?? [];");
    expect(playbackSource).toContain(
      "const subtitleError = playback.data?.subtitle_error || null;",
    );
  });

  test("弹幕只加载授权的本机快照，复用时间轴渲染且不启用在线交互", () => {
    expect(contractSource).toContain("danmaku_url: string | null;");
    expect(contractSource).toContain("danmaku_error: string | null;");
    expect(playbackSource).toContain("enabled: Boolean(danmakuUrl)");
    expect(playbackSource).toContain("await fetch(danmakuUrl, { signal })");
    expect(playbackSource).toContain("parseDownloadedDanmaku(await response.json())");
    expect(playerSource).toContain("<VideoDanmakuLayer");
    expect(playerSource).toContain("interactive={false}");
    expect(playerSource).toContain("osdOn={danmakuVisible}");
    expect(playerSource).toContain("onToggleOsd={");
    expect(playbackSource).not.toContain("videoGetDanmaku");
    expect(playerSource).not.toContain("videoGetDanmaku");
  });

  test("播放页只保留底部操作栏，并为所有状态提供返回入口", () => {
    expect(playbackSource).not.toContain("PlaybackTopBar");
    expect(playbackSource).not.toContain("正在播放应用内下载缓存");
    expect(playbackSource).toContain("返回下载列表");
    expect(playbackSource).toContain("系统播放器");
    expect(playbackSource).toContain("打开文件位置");
    expect(playbackSource.match(/<DownloadFooter/g)).toHaveLength(2);
    expect(playbackSource).toContain('<ErrorState error={subtitleError} title="字幕缓存不完整" />');
    expect(playbackSource).toContain("onNavigateBack={goBack}");
  });

  test("Video.js 直接加载缓存 VTT，字幕菜单接入公共控制栏", () => {
    expect(playerSource).toContain('import { useCaptionsOptions } from "@videojs/react";');
    expect(playerSource).toContain("{subtitles.map((subtitle) => (");
    expect(playerSource).toContain('kind="subtitles"');
    expect(playerSource).toContain("src={subtitle.url}");
    expect(playerSource).toContain("srcLang={subtitle.lan}");
    expect(playerSource).toContain("label={subtitle.lan_doc}");
    expect(playerSource).toContain('crossOrigin={subtitles.length > 0 ? "anonymous" : undefined}');
    expect(playerSource).toContain("captionsSlot={");
    expect(playerSource).toContain("<DownloadCaptions");
    expect(playerSource).toContain('aria-label="字幕来源"');
    expect(playerSource).toContain('option.value === "off" ? "关闭字幕" : option.label');
    expect(playerSource).toContain("onOpenChange(false);");
    expect(playerSource).not.toContain("video_get_subtitle");
    expect(playerSource).not.toContain("videoGetSubtitle");
  });

  test("画内 HUD 在普通窗口和全屏都承担返回，加载与错误态保留同一语义", () => {
    expect(playerSource).toContain("fullscreen: true,");
    expect(playerSource).toContain("hasActions: true,");
    expect(playerSource).toContain(
      'const backLabel = fullscreen.fullscreen ? "退出全屏" : "返回下载列表";',
    );
    expect(playerSource).toContain("if (fullscreen.fullscreen) void fullscreen.exit();");
    expect(playerSource).toContain("else onNavigateBack();");
    expect(playerSource).toContain("{(loading || error) && (");
    expect(playerSource).toContain("<PlayerLoadingBackButton label={backLabel}");
    expect(playerSource).toContain("onBack={handlePlayerBack}");
    expect(playerSource).toContain("backLabel={backLabel}");
  });
});

describe("下载弹幕快照", () => {
  test("合并分段按媒体时间排序，保留空段并维持跨段唯一标识", () => {
    const item = {
      progress: 5000,
      mode: 4,
      fontsize: 25,
      color: 0xff0000,
      content: "弹幕",
      weight: 1,
      pool: 0,
    };
    const entries = parseDownloadedDanmaku([
      { segment_index: 3, items: [{ ...item, progress: 720000 }] },
      { segment_index: 2, items: [] },
      { segment_index: 1, items: [item] },
    ]);
    expect(entries.map((entry) => entry.progressMs)).toEqual([5000, 720000]);
    expect(entries.map((entry) => entry.id)).toEqual(["1:0", "3:0"]);
    expect(entries[0]?.mode).toBe("bottom");
    expect(entries[0]?.color).toBe("#ff0000");
    expect(parseDownloadedDanmaku([])).toEqual([]);
  });

  test("损坏快照与重复段号明确报错，不进入渲染器", () => {
    for (const value of [
      null,
      {},
      [null],
      [{ segment_index: 0, items: [] }],
      [{ segment_index: 1, items: [null] }],
      [
        { segment_index: 1, items: [] },
        { segment_index: 1, items: [] },
      ],
    ]) {
      expect(() => parseDownloadedDanmaku(value)).toThrow();
    }
  });
});
