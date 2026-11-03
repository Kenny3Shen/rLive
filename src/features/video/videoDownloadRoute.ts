import { FOLLOW_VIEW_PARAM } from "@/features/follow/followRoute";

export const VIDEO_DOWNLOAD_PLAYBACK_ROUTE_PREFIX = "/video/download/play/";
const FOLLOW_PATH = "/follow";

export type VideoDownloadPlaybackEntryState = {
  fromVideoDownloadList: true;
  returnTo: string;
};

export function videoDownloadPlaybackPath(id: string): string {
  return `${VIDEO_DOWNLOAD_PLAYBACK_ROUTE_PREFIX}${encodeURIComponent(id)}`;
}

export function videoDownloadPlaybackEntryState(returnTo: string): VideoDownloadPlaybackEntryState {
  return { fromVideoDownloadList: true, returnTo };
}

/**
 * 从下载列表进入时优先撤销这次 history，保留原来的筛选与页面滚动。
 * 直接打开深链接时则稳定落回关注页的“已完成”下载范围。
 */
export function videoDownloadPlaybackReturnTarget(state: unknown): string {
  const params = new URLSearchParams();
  params.set(FOLLOW_VIEW_PARAM, "downloads");
  params.set("downloadView", "completed");
  if (
    state &&
    typeof state === "object" &&
    "fromVideoDownloadList" in state &&
    state.fromVideoDownloadList === true &&
    "returnTo" in state &&
    typeof state.returnTo === "string" &&
    (state.returnTo === FOLLOW_PATH || state.returnTo.startsWith(`${FOLLOW_PATH}?`))
  ) {
    return state.returnTo;
  }
  return `${FOLLOW_PATH}?${params.toString()}`;
}

export function shouldPopToVideoDownloadList(state: unknown, historyIndex: unknown): boolean {
  return (
    typeof historyIndex === "number" &&
    historyIndex > 0 &&
    Boolean(
      state &&
      typeof state === "object" &&
      "fromVideoDownloadList" in state &&
      state.fromVideoDownloadList === true,
    )
  );
}
