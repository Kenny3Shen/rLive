import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  legacyRecordingsRedirectTarget,
  legacyVideoDownloadRedirectTarget,
} from "../src/app/legacyFollowRoutes";
import { FollowViewSwitcher } from "../src/features/follow/FollowHeaderControls";
import { TaskCountBadge } from "../src/features/follow/TaskCountBadge";
import {
  followTaskCountLabel,
  followTaskTotal,
  formatTaskBadgeCount,
} from "../src/features/follow/followTaskCounts";
import {
  followViewFromSearch,
  followViewsFor,
  withFollowView,
} from "../src/features/follow/followRoute";
import {
  VIDEO_DOWNLOAD_VIEW_PARAM,
  videoDownloadViewFromSearch,
  withVideoDownloadView,
} from "../src/features/video/videoDownload";
import {
  RECORDING_LIBRARY_RETURN_SOURCE,
  recordingLibraryReturnPath,
  recordingPlaybackReturnTarget,
  shouldPopToRecordingLibrary,
} from "../src/features/recording/recordingRoute";

describe("关注页媒体资源", () => {
  test("关注任务计数合并录制与下载，并输出完整无障碍描述", () => {
    const both = { recordings: 2, downloads: 3 };
    expect(followTaskTotal(both)).toBe(5);
    expect(followTaskCountLabel(both)).toBe("2 项录制、3 项下载正在进行");
    expect(followTaskCountLabel({ recordings: 1, downloads: 0 })).toBe("1 项录制正在进行");
    expect(followTaskCountLabel({ recordings: 0, downloads: 1 })).toBe("1 项下载正在进行");
    expect(followTaskCountLabel({ recordings: 0, downloads: 0 })).toBeNull();
    expect(formatTaskBadgeCount(9)).toBe("9");
    expect(formatTaskBadgeCount(99)).toBe("99");
    expect(formatTaskBadgeCount(100)).toBe("99+");
  });

  test("任务徽标服务端渲染显示真实分类数量并把可见数字封顶为 99+", () => {
    const html = renderToStaticMarkup(
      createElement(FollowViewSwitcher, {
        value: "recordings",
        onValueChange: () => undefined,
        recordingAvailable: true,
        taskCounts: { recordings: 2, downloads: 100 },
      }),
    );

    expect(html).toContain('aria-label="录制，2 项任务正在进行"');
    expect(html).toContain('aria-label="下载，100 项任务正在进行"');
    expect(html.match(/data-slot="task-count-badge"/g)).toHaveLength(2);
    expect(html).toContain(">2</span>");
    expect(html).toContain(">99+</span>");
    expect(html).not.toContain(">100</span>");
  });

  test("没有进行中任务时不渲染任务徽标", () => {
    const html = renderToStaticMarkup(
      createElement(FollowViewSwitcher, {
        value: "downloads",
        onValueChange: () => undefined,
        recordingAvailable: true,
        taskCounts: { recordings: 0, downloads: 0 },
      }),
    );
    expect(html).not.toContain('data-slot="task-count-badge"');
    expect(renderToStaticMarkup(createElement(TaskCountBadge, { count: 0 }))).toBe("");
  });

  test("主导航与页签消费同一份常驻任务计数", () => {
    const shell = readFileSync(new URL("../src/app/layout/Shell.tsx", import.meta.url), "utf8");
    const sidebar = readFileSync(new URL("../src/app/layout/Sidebar.tsx", import.meta.url), "utf8");

    expect(shell).toContain("const followTaskCounts = useFollowTaskCounts();");
    expect(shell).toContain("<Sidebar taskCounts={followTaskCounts} />");
    expect(shell).toContain("taskCounts={followTaskCounts}");
    expect(sidebar).toContain("<TaskCountBadge");
    expect(sidebar).toContain('item.to === "/follow" ? followTaskCount : 0');
  });

  test("桌面展示五类关注内容，移动端隐藏录制", () => {
    expect(followViewsFor(true)).toEqual(["live", "video", "iptv", "recordings", "downloads"]);
    expect(followViewsFor(false)).toEqual(["live", "video", "iptv", "downloads"]);
    expect(followViewFromSearch("recordings")).toBe("recordings");
    expect(followViewFromSearch("recordings", false)).toBe("live");
    expect(followViewFromSearch("downloads", false)).toBe("downloads");
    expect(
      withFollowView(new URLSearchParams("view=video&platform=bilibili"), "downloads"),
    ).toEqual(new URLSearchParams("view=downloads&platform=bilibili"));
  });

  test("旧录制深链迁移到关注页并保留筛选参数", () => {
    const target = legacyRecordingsRedirectTarget(
      "?view=recorded&platform=bilibili&user=room%2Fuser",
    );
    const url = new URL(target, "https://rlive.local");
    expect(url.pathname).toBe("/follow");
    expect(url.searchParams.get("view")).toBe("recordings");
    expect(url.searchParams.get("recordingView")).toBe("recorded");
    expect(url.searchParams.get("platform")).toBe("bilibili");
    expect(url.searchParams.get("user")).toBe("room/user");
  });

  test("旧视频下载深链迁移到关注页且不转发视频页签参数", () => {
    const target = legacyVideoDownloadRedirectTarget("?tab=download&zone=1005");
    expect(target).not.toBeNull();
    const url = new URL(target!, "https://rlive.local");
    expect(url.pathname).toBe("/follow");
    expect(url.searchParams.get("view")).toBe("downloads");
    expect(url.searchParams.get("tab")).toBeNull();
    expect(url.searchParams.get("zone")).toBe("1005");
    expect(legacyVideoDownloadRedirectTarget("?tab=anime")).toBeNull();
  });

  test("下载范围在地址栏往返并拒绝非法值", () => {
    expect(videoDownloadViewFromSearch("active")).toBe("active");
    expect(videoDownloadViewFromSearch("unknown")).toBe("all");
    const params = withVideoDownloadView(new URLSearchParams("view=downloads"), "completed");
    expect(params.get(VIDEO_DOWNLOAD_VIEW_PARAM)).toBe("completed");
    expect(withVideoDownloadView(params, "all").get(VIDEO_DOWNLOAD_VIEW_PARAM)).toBeNull();
  });

  test("录制回放返回优先保留 URL 筛选，并在无历史时 replace 到关注页", () => {
    const libraryPath = recordingLibraryReturnPath(
      new URLSearchParams("view=recordings&recordingView=recorded&platform=huya&user=from-state"),
    );
    expect(new URL(libraryPath, "https://rlive.local").searchParams.get("view")).toBe("recordings");

    const target = recordingPlaybackReturnTarget(
      "user=from-url&platform=bilibili&recordingView=recording",
      {
        rliveNavigationSource: RECORDING_LIBRARY_RETURN_SOURCE,
        returnTo: libraryPath,
      },
    );
    const url = new URL(target, "https://rlive.local");
    expect(url.pathname).toBe("/follow");
    expect(url.searchParams.get("view")).toBe("recordings");
    expect(url.searchParams.get("user")).toBe("from-url");
    expect(url.searchParams.get("platform")).toBe("bilibili");
    expect(url.searchParams.get("recordingView")).toBe("recording");

    expect(
      recordingPlaybackReturnTarget("user=direct", {
        rliveNavigationSource: RECORDING_LIBRARY_RETURN_SOURCE,
        returnTo: "https://example.com/",
      }),
    ).toBe("/follow?view=recordings&user=direct");
  });

  test("只有明确来自关注页且存在应用历史时才执行后退", () => {
    expect(
      shouldPopToRecordingLibrary(
        { rliveNavigationSource: RECORDING_LIBRARY_RETURN_SOURCE, returnTo: "/follow" },
        2,
      ),
    ).toBe(true);
    expect(shouldPopToRecordingLibrary({ rliveNavigationSource: "sidebar" }, 2)).toBe(false);
    expect(
      shouldPopToRecordingLibrary(
        { rliveNavigationSource: RECORDING_LIBRARY_RETURN_SOURCE, returnTo: "/follow" },
        0,
      ),
    ).toBe(false);
  });
});
