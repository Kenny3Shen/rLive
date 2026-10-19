import type { PlayUrl } from "@/shared/types/live";
import { webPlaybackKind, type VideoJsPlaybackKind } from "../player/videoJsPlayer";

/**
 * 播放源的语义身份。
 *
 * 等价对象不重建播放器，任一路由信息变化都会被识别：URL、排序后的请求头、
 * `source_id`、`label`、`protocol` 与 `priority`。JSON 让 URL 与请求头取值中的
 * 分隔符无歧义，并可在下方重建为不可变的播放快照。该 key 只存在于当前
 * WebView 内存。
 */
export function playUrlKey(playUrl: PlayUrl | null): string {
  if (!playUrl) return "";
  return JSON.stringify([
    playUrl.url,
    Object.entries(playUrl.headers).sort(([a], [b]) => a.localeCompare(b)),
    playUrl.source_id,
    playUrl.label,
    playUrl.protocol,
    playUrl.priority,
  ]);
}

/** 从语义 key 还原播放源；结构不完整时返回 null。 */
export function playbackSourceFromKey(key: string): PlayUrl | null {
  if (!key) return null;
  try {
    const parsed: unknown = JSON.parse(key);
    if (!Array.isArray(parsed) || typeof parsed[0] !== "string" || !Array.isArray(parsed[1])) {
      return null;
    }
    const entries = parsed[1].filter(
      (entry): entry is [string, string] =>
        Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string",
    );
    const protocol = parsed[4];
    if (
      protocol !== "flv" &&
      protocol !== "hls" &&
      protocol !== "mpeg_ts" &&
      protocol !== "native" &&
      protocol !== "unknown"
    ) {
      return null;
    }
    const sourceId = parsed[2];
    const label = parsed[3];
    const priority = parsed[5];
    if (
      typeof sourceId !== "string" ||
      typeof label !== "string" ||
      typeof priority !== "number" ||
      !Number.isFinite(priority)
    ) {
      return null;
    }
    return {
      url: parsed[0],
      headers: Object.fromEntries(entries),
      source_id: sourceId,
      label,
      protocol,
      priority,
    };
  } catch {
    return null;
  }
}

/**
 * 续期后的新地址能否在现有播放器上原地重连。
 *
 * 只要求协议相同：适配器可以重新加载来源，或重建同一媒体元素内的传输层。
 * 协议变化需要新的适配器，必须完整重建。地址与语义 key 是否变化不影响这个
 * 判断 —— 续期经常返回同一个签名地址，但上游连接已经关闭，仍需要在原地重连。
 */
export function canRenewPlaybackInPlace(active: PlayUrl | null, next: PlayUrl | null): boolean {
  if (!active || !next) return false;
  return webPlaybackKind(active) === webPlaybackKind(next);
}

/**
 * 是否应通过软切换在现有播放器上应用新来源。
 *
 * `force` 用于「语义 key 没变、但传输必须重连」的续期：此时来源比较不会产生
 * 换源信号，只有显式请求才能让适配器重新打开传输。
 */
export function shouldSoftSwitchToSource(input: {
  enabled: boolean;
  activeSourceKey: string;
  targetSourceKey: string;
  activeKind: VideoJsPlaybackKind | null;
  targetKind: VideoJsPlaybackKind | null;
  force?: boolean;
}): boolean {
  // 没有活动播放器时由初始化路径决定来源，软切换不能与它竞争。
  if (!input.enabled || !input.activeSourceKey || !input.targetSourceKey) return false;
  if (!input.activeKind || input.activeKind !== input.targetKind) return false;
  if (input.targetSourceKey !== input.activeSourceKey) return true;
  return input.force === true;
}
