import type { PlayUrl } from "@/shared/types/live";

type StreamProxySource = Pick<
  PlayUrl,
  "url" | "headers" | "twitch_ad_recovery" | "douyu_flv_recovery"
>;

/**
 * 房间主播放的初始化与软切换共用同一组代理启动参数，避免恢复元数据只在其中
 * 一条路径透传。短时卡片预览不使用这里的长期续接能力。
 */
export function streamProxyStartArgs(
  source: StreamProxySource,
  sessionId: string,
  hls: boolean,
): Record<string, unknown> {
  return {
    url: source.url,
    headers: source.headers,
    sessionId,
    hls,
    ...(source.twitch_ad_recovery ? { twitchAdRecovery: source.twitch_ad_recovery } : {}),
    ...(source.douyu_flv_recovery ? { douyuFlvRecovery: source.douyu_flv_recovery } : {}),
  };
}
