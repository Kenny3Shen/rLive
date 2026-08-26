export const RECORDING_VIEW_PARAM = "view";

/** 头部页签在其间翻页的三种录制库作用域。 */
export type RecordingView = "all" | "recording" | "recorded";

export const RECORDING_VIEWS: readonly RecordingView[] = ["all", "recording", "recorded"];

/**
 * 活动作用域保存在地址栏而不是页面状态里：应用头部拥有页签而页面拥有列表，
 * search 参数是双方都能读取、又互不导入对方状态的唯一位置。
 * 这与 `/history` 共享其时间线切换器的方式一致。
 */
export function recordingViewFromSearch(value: string | null | undefined): RecordingView {
  return value === "recording" || value === "recorded" ? value : "all";
}

export function withRecordingView(current: URLSearchParams, view: RecordingView): URLSearchParams {
  const next = new URLSearchParams(current);
  if (view === "all") next.delete(RECORDING_VIEW_PARAM);
  else next.set(RECORDING_VIEW_PARAM, view);
  return next;
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
