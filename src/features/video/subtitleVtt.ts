/**
 * B 站 CC 字幕 JSON → WebVTT。
 *
 * 字幕体是 `{ body: [{ from, to, content }] }`（秒，可能带小数）；转成 VTT
 * 挂到 `<track>` 上，渲染交给浏览器（`::cue` 定样式），不自己做时间轴同步。
 */

type SubtitleBodyLine = {
  from: number;
  to: number;
  content: string;
};

function vttTimestamp(seconds: number): string {
  const total = Math.max(0, seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const millis = Math.round((total - Math.floor(total)) * 1000);
  return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

/** 无效行（缺时间或缺内容）跳过而不是整体失败：单行脏数据不值得丢整个字幕。 */
export function subtitleJsonToVtt(raw: string): string {
  let body: SubtitleBodyLine[];
  try {
    body = (JSON.parse(raw) as { body?: SubtitleBodyLine[] }).body ?? [];
  } catch {
    return "";
  }

  const cues: string[] = [];
  for (const line of body) {
    if (
      typeof line?.from !== "number" ||
      typeof line?.to !== "number" ||
      !line.content?.trim() ||
      line.to <= line.from
    ) {
      continue;
    }
    cues.push(`${vttTimestamp(line.from)} --> ${vttTimestamp(line.to)}\n${line.content}`);
  }
  return `WEBVTT\n\n${cues.join("\n\n")}`;
}
