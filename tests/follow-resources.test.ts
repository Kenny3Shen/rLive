import { describe, expect, test } from "bun:test";
import {
  legacyRecordingsRedirectTarget,
  legacyVideoDownloadRedirectTarget,
} from "../src/app/legacyFollowRoutes";
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
