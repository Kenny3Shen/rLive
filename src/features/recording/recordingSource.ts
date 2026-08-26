import { invokeCmd } from "@/shared/api/tauri";
import type { LivePlayQuality, LiveRoomDetail, PlayUrl } from "@/shared/types/live";

/**
 * 为录制任务抓取专用的播放地址。
 *
 * 录制不得复用屏幕上播放器正在拉取的 URL。播放器经 Rust `stream_proxy` 推流
 * 而录制直连上游，共用一个地址等于向其开启两条独立连接。
 * 按请求签名且每个签名只允许一个消费者的站点 —— 斗鱼是已知案例 —— 会掐断
 * 第二条，录制在开始数秒后以 `Input/output error` 死掉。
 *
 * 向站点请求新线路会得到单独签名的 URL，播放器与录制不再竞争。
 * 从关注页启动录制一直都是这么做的；
 * 这不是斗鱼专属的变通方案。
 */
export async function fetchRecordingPlayUrl(
  siteId: string,
  detail: LiveRoomDetail,
  quality: LivePlayQuality,
  preferredSourceId?: string,
): Promise<PlayUrl> {
  const lines = await invokeCmd<PlayUrl[]>("site_get_play_urls", {
    siteId,
    detail,
    quality,
  });
  return pickRecordingLine(lines, preferredSourceId);
}

/**
 * 为新抓取的线路选择录制应使用的那条。
 *
 * 按 `source_id` 匹配而不是按下标：重新抓取可能重排或丢弃 CDN，
 * 按下标会静默指向与观众正在观看不同的线路。
 */
export function pickRecordingLine(lines: readonly PlayUrl[], preferredSourceId?: string): PlayUrl {
  if (lines.length === 0) throw new Error("平台未返回可用播放地址");
  const preferred = preferredSourceId
    ? lines.find((line) => line.source_id === preferredSourceId)
    : undefined;
  return preferred ?? lines[0];
}
