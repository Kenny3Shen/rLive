import type { DanmakuComment } from "@/features/room/danmaku/danmakuTypes";
import type { VideoDanmakuEntry } from "@/features/video/videoDanmaku";
import type { AcfunVideoDanmakuItem } from "./acfunTypes";

function acfunDanmakuMode(mode: number): DanmakuComment["mode"] {
  if (mode === 4) return "bottom";
  if (mode === 5) return "top";
  return "scroll";
}

function acfunDanmakuColor(color: number): string {
  if (!Number.isFinite(color)) return "#ffffff";
  const value = Math.trunc(color);
  if (value <= 0 || value > 0xffffff) return "#ffffff";
  return `#${value.toString(16).padStart(6, "0")}`;
}

export function acfunVideoDanmakuEntries(
  items: readonly AcfunVideoDanmakuItem[],
  partId: string,
): VideoDanmakuEntry[] {
  const usedIds = new Set<string>();
  const entries: VideoDanmakuEntry[] = [];
  for (const [index, item] of items.entries()) {
    const content = item.content.trim();
    if (!content) continue;
    const upstreamId = item.id.trim() || String(index);
    let id = `${partId}:${upstreamId}`;
    if (usedIds.has(id)) id = `${id}:${index}`;
    usedIds.add(id);
    entries.push({
      id,
      progressMs: Number.isFinite(item.progress) ? Math.max(0, Math.trunc(item.progress)) : 0,
      mode: acfunDanmakuMode(item.mode),
      color: acfunDanmakuColor(item.color),
      content,
      pool: 0,
    });
  }
  return entries.sort((left, right) => left.progressMs - right.progressMs);
}
