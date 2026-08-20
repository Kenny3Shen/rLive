import { invokeCmd } from "@/shared/api/tauri";
import type { LivePlayQuality, LiveRoomDetail, PlayUrl } from "@/shared/types/live";

/**
 * Fetches a play URL dedicated to a recording task.
 *
 * A recording must not reuse the URL the on-screen player is already pulling.
 * The player streams through the Rust `stream_proxy` while a recording connects
 * to the upstream directly, so sharing one address opens two independent
 * connections to it. Sites that sign a URL per request and allow only one
 * consumer per signature — Douyu is the known case — drop the second one, and
 * the recording dies with an `Input/output error` seconds after it starts.
 *
 * Asking the site for a fresh line yields a separately signed URL, so the player
 * and the recording no longer compete. This is what starting a recording from
 * the follow page has always done; it is not a Douyu-specific workaround.
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
 * Chooses which freshly fetched line the recording should use.
 *
 * Matched by `source_id` rather than by index: a re-fetch can reorder or drop
 * CDNs, so an index would silently point at a different line than the one the
 * viewer is watching.
 */
export function pickRecordingLine(lines: readonly PlayUrl[], preferredSourceId?: string): PlayUrl {
  if (lines.length === 0) throw new Error("平台未返回可用播放地址");
  const preferred = preferredSourceId
    ? lines.find((line) => line.source_id === preferredSourceId)
    : undefined;
  return preferred ?? lines[0];
}
