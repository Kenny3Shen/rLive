import { describe, expect, test } from "bun:test";
import type { VideoDownloadItem, VideoDownloadStatus } from "../src/features/video/videoDownload";
import {
  applyVideoDownloadProgress,
  mergeVideoDownload,
  sortVideoDownloads,
  videoDownloadIsActive,
  videoDownloadNeedsPolling,
} from "../src/features/video/videoDownloadState";
import {
  shouldPopToVideoDownloadList,
  videoDownloadPlaybackEntryState,
  videoDownloadPlaybackPath,
  videoDownloadPlaybackReturnTarget,
} from "../src/features/video/videoDownloadRoute";

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
