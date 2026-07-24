import type { QualityLevel } from "@/shared/types/player";

/**
 * Map a Simple Live–style quality preference onto a qualities list.
 * List order is assumed best-first (Bilibili / simple_live_core convention).
 */
export function pickDefaultQualityIndex(
  length: number,
  level: QualityLevel = "high",
): number {
  if (length <= 0) return 0;
  if (level === "high") return 0;
  if (level === "low") return length - 1;
  return Math.floor(length / 2);
}

export function parseQualityLevel(value: unknown): QualityLevel {
  if (value === "mid" || value === "low" || value === "high") return value;
  return "high";
}
