import { redirect, type LoaderFunctionArgs } from "react-router-dom";
import { FOLLOW_VIEW_PARAM } from "@/features/follow/followRoute";
import { RECORDING_VIEW_PARAM } from "@/features/recording/recordingRoute";
import { VIDEO_TAB_PARAM } from "@/features/video/videoRoute";

const FOLLOW_PATH = "/follow";

/**
 * 录制库已并入关注页。旧 `/recordings` 的 `view` 是录制范围，不能与关注页
 * 自己的 `view` 混用；其余筛选原样保留。
 */
export function legacyRecordingsRedirectTarget(search: string): string {
  const params = new URLSearchParams(search);
  const recordingView = params.get(FOLLOW_VIEW_PARAM);
  params.delete(FOLLOW_VIEW_PARAM);
  params.set(FOLLOW_VIEW_PARAM, "recordings");
  if (recordingView !== null) params.set(RECORDING_VIEW_PARAM, recordingView);
  return `${FOLLOW_PATH}?${params.toString()}`;
}

/** 旧视频下载页签的兼容落点；非下载页签返回 null，不干扰视频发现页。 */
export function legacyVideoDownloadRedirectTarget(search: string): string | null {
  const params = new URLSearchParams(search);
  if (params.get(VIDEO_TAB_PARAM) !== "download") return null;
  params.delete(VIDEO_TAB_PARAM);
  params.set(FOLLOW_VIEW_PARAM, "downloads");
  return `${FOLLOW_PATH}?${params.toString()}`;
}

export function legacyRecordingsRedirect({ request }: LoaderFunctionArgs): Response {
  return redirect(legacyRecordingsRedirectTarget(new URL(request.url).search));
}

export function legacyVideoDownloadRedirect({ request }: LoaderFunctionArgs): Response | null {
  const target = legacyVideoDownloadRedirectTarget(new URL(request.url).search);
  return target ? redirect(target) : null;
}
