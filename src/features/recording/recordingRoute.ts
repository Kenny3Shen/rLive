import { FOLLOW_VIEW_PARAM } from "@/features/follow/followRoute";

/** 关注页已经用 `view` 表示一级页签，录制范围改用独立参数。 */
export const RECORDING_VIEW_PARAM = "recordingView";

/** 录制库的三种范围。 */
export type RecordingView = "all" | "recording" | "recorded";

export const RECORDING_VIEWS: readonly RecordingView[] = ["all", "recording", "recorded"];

/** 活动范围写入地址栏，供关注页和录制库共同读取。 */
export function recordingViewFromSearch(value: string | null | undefined): RecordingView {
  return value === "recording" || value === "recorded" ? value : "all";
}

export function withRecordingView(current: URLSearchParams, view: RecordingView): URLSearchParams {
  const next = new URLSearchParams(current);
  if (view === "all") next.delete(RECORDING_VIEW_PARAM);
  else next.set(RECORDING_VIEW_PARAM, view);
  return next;
}

export const RECORDING_LIBRARY_RETURN_SOURCE = "follow-recordings";

export type RecordingLibraryReturnState = {
  rliveNavigationSource: typeof RECORDING_LIBRARY_RETURN_SOURCE;
  returnTo: string;
};

export function recordingLibraryReturnPath(searchParams: URLSearchParams): string {
  const params = new URLSearchParams(searchParams);
  params.set(FOLLOW_VIEW_PARAM, "recordings");
  return `/follow?${params.toString()}`;
}

export function isRecordingLibraryReturnState(
  state: unknown,
): state is RecordingLibraryReturnState {
  return (
    typeof state === "object" &&
    state !== null &&
    "rliveNavigationSource" in state &&
    state.rliveNavigationSource === RECORDING_LIBRARY_RETURN_SOURCE &&
    "returnTo" in state &&
    typeof state.returnTo === "string"
  );
}

/**
 * 无应用历史可退时，以来源 state 的 returnTo 为底，再用回放 URL 中的筛选覆盖。
 * `user` 因此优先采用 URL，录制库尚未加载完成也不会丢掉当前用户。
 */
export function recordingPlaybackReturnTarget(search: string, state: unknown): string {
  const sourceState = isRecordingLibraryReturnState(state) ? state : null;
  let target: URL;
  try {
    target = new URL(sourceState?.returnTo ?? "/follow", "https://rlive.local");
  } catch {
    target = new URL("/follow", "https://rlive.local");
  }
  if (target.origin !== "https://rlive.local" || target.pathname !== "/follow") {
    target = new URL("/follow", "https://rlive.local");
  }

  const playbackParams = new URLSearchParams(search);
  target.searchParams.set(FOLLOW_VIEW_PARAM, "recordings");
  for (const key of ["user", "platform", RECORDING_VIEW_PARAM]) {
    const value = playbackParams.get(key);
    if (value !== null) target.searchParams.set(key, value);
  }
  return `${target.pathname}${target.search}`;
}

export function shouldPopToRecordingLibrary(state: unknown, historyIndex: unknown): boolean {
  return (
    isRecordingLibraryReturnState(state) &&
    typeof historyIndex === "number" &&
    Number.isInteger(historyIndex) &&
    historyIndex > 0
  );
}

/**
 * 为录制 id 构建回放路径。
 *
 * id 是两级分卷路径（`platform_room/user_timestamp`），
 * 回放路由为每级花费一个段。若整体 `encodeURIComponent` 编码 id，
 * 分隔符会变成 `%2F`，路由器只会交还半解码的参数，
 * 匹配不到任何库条目。
 */
export function recordingPlaybackPath(id: string): string {
  const levels = id.split("/").map(encodeURIComponent).join("/");
  return `/recordings/play/${levels}`;
}

/**
 * 从回放路由参数重建录制 id。某一级缺失时返回 null，
 * 使手输的 URL 匹配失败，而不是解析出半个 id。
 */
export function recordingIdFromPlaybackParams(
  roomDir: string | undefined,
  sessionDir: string | undefined,
): string | null {
  if (!roomDir || !sessionDir) return null;
  try {
    return `${decodeURIComponent(roomDir)}/${decodeURIComponent(sessionDir)}`;
  } catch {
    // 畸形的百分号转义无法命名一场录制。
    return null;
  }
}
