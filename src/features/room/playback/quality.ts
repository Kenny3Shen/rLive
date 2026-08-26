import type { QualityLevel } from "@/shared/types/player";

/** 把画质偏好映射到画质列表。列表顺序假定按优劣排列。 */
export function pickDefaultQualityIndex(length: number, level: QualityLevel = "high"): number {
  if (length <= 0) return 0;
  if (level === "high") return 0;
  if (level === "low") return length - 1;
  return Math.floor(length / 2);
}

export function parseQualityLevel(value: unknown): QualityLevel {
  if (value === "mid" || value === "low" || value === "high") return value;
  return "high";
}
