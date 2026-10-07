import type { VideoChapter } from "@/shared/types/video";

/** 先按毫秒取整再拆分，避免 59.9999 秒变成非法的 00:00:59.1000。 */
function vttTimestamp(millis: number): string {
  const hours = Math.floor(millis / 3_600_000);
  const minutes = Math.floor((millis % 3_600_000) / 60_000);
  const seconds = Math.floor((millis % 60_000) / 1_000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis % 1_000).padStart(3, "0")}`;
}

/**
 * 后端归一化的章节 → WebVTT。这里只处理序列化，不在前端重建平台章节规则。
 * 空隙、重叠区间与实际媒体时长由 Video.js TimeSlider.Chapters 统一处理。
 */
export function chaptersToVtt(chapters: readonly VideoChapter[] | undefined): string {
  const cues: string[] = [];
  for (const chapter of chapters ?? []) {
    const start = Math.round(chapter.start_time * 1_000);
    const end = Math.round(chapter.end_time * 1_000);
    // WebVTT 精度只有毫秒，舍入后退化为零长的片段不能写入轨道。
    if (end <= start) continue;
    // 标题只占一行，不能伪装成下一条 cue 或时间分隔符。
    const title = chapter.title.replace(/\s+/g, " ").replace(/-->/g, "→").trim();
    cues.push(`${vttTimestamp(start)} --> ${vttTimestamp(end)}\n${title}`);
  }
  return cues.length ? `WEBVTT\n\n${cues.join("\n\n")}\n` : "";
}
