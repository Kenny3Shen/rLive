import { safeDanmuColor } from "@/features/room/danmaku/danmakuAdapter";
import { floatingRichSpans } from "@/features/room/danmaku/content";
import type { VideoDanmakuEntry } from "@/features/video/videoDanmaku";
import type { RecordedDanmakuEntry } from "./recordedDanmaku";

/** 录制轨与 VOD 侧栏列表共用的只读映射；播放画布仍消费原始录制条目。 */
export function recordedDanmakuListEntries(
  entries: readonly RecordedDanmakuEntry[],
): VideoDanmakuEntry[] {
  return entries.map((entry) => ({
    id: `recording:${entry.sequence}`,
    progressMs: entry.offsetMs,
    mode: "scroll",
    color: safeDanmuColor(
      entry.event.color,
      entry.event.kind === "super_chat" ? "#ffd76a" : "#ffffff",
    ),
    content: entry.text,
    pool: 0,
    user: entry.event.user.trim(),
    spans: floatingRichSpans(entry.event),
  }));
}
