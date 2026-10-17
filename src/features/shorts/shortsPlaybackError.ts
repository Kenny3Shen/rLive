import { videoJsPlayerErrorMessage } from "@/features/room/player/videoJsPlayer";

/**
 * 竖屏槽位该显示哪种失败。
 *
 * 取流失败只在**当前条目没有存活媒体**时才取代画面：换片预热、重试换代与保留会话
 * 让「这一条正在播、另一次取流失败」成为正常组合，此时把错误铺满舞台会把还在播的
 * 内容说成不可播放。播放器自身的致命错误优先级最高 —— 那说明已附着的媒体确实停了，
 * 与取流查询的状态无关。
 *
 * 判定用「当前条目已附着的媒体会话」而不是「有过一帧」：后者在换片时会被清空，
 * 而重试期间旧会话仍在播，正好是这条判据要覆盖的窗口。
 */
export function shortsPlaybackError({
  playerError,
  queryError,
  sourceLive,
}: {
  /** 播放器 `error` 事件给出的文案；由调用方先按严重程度筛过。 */
  playerError: string | null;
  /** 当前条目的取流查询错误。 */
  queryError: unknown;
  /** 当前条目是否已有一份附着的、仍然存活的媒体会话。 */
  sourceLive: boolean;
}): string | null {
  if (playerError) return playerError;
  if (!queryError || sourceLive) return null;
  return videoJsPlayerErrorMessage(queryError, "取流失败，请重试");
}
