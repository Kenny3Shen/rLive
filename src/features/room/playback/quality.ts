import type { QualityLevel } from "@/shared/types/player";

/** 把画质偏好映射到画质列表。列表顺序假定按优劣排列。 */
export function pickDefaultQualityIndex(length: number, level: QualityLevel = "high"): number {
  if (length <= 0) return 0;
  if (level === "high") return 0;
  if (level === "low") return length - 1;
  return Math.floor(length / 2);
}

/**
 * 最低视频清晰度。Twitch 会在列表末尾附带 `audio only` 档，
 * 节能画质仍要保留画面，因此从后向前跳过纯音频档。
 */
export function lowestVideoQualityIndex(qualities: readonly { quality: string }[]): number | null {
  for (let index = qualities.length - 1; index >= 0; index -= 1) {
    if (!/audio[ _-]?only/i.test(qualities[index]?.quality ?? "")) return index;
  }
  return null;
}
