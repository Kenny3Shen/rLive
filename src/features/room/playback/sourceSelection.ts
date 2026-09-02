import { playbackSourcePriority } from "@/lib/playUrl";
import type { PlayUrl } from "@/shared/types/live";

/** 稳定排序：按适配器给出的线路优先级，同优先级保持原始顺序。 */
export function rankPlaybackSourceIndices(sources: readonly PlayUrl[]): number[] {
  return sources
    .map((source, index) => ({ index, priority: playbackSourcePriority(source, index) }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(({ index }) => index);
}

export function nextRankedLineIndex(input: {
  currentIndex: number;
  rankedIndices: readonly number[];
  exhaustedIndices: ReadonlySet<number>;
}): number | null {
  return (
    input.rankedIndices.find(
      (index) => index !== input.currentIndex && !input.exhaustedIndices.has(index),
    ) ?? null
  );
}
