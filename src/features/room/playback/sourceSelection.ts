import { playbackSourcePriority } from "@/lib/playUrl";
import type { PlayUrl } from "@/shared/types/live";

export type PlaybackSourceProbe = {
  source_id: string;
  index: number;
  available: boolean;
  status: number | null;
  ttfb_ms: number | null;
  content_type: string | null;
  sampled_bytes: number;
  error_code: string | null;
};

export type PlaybackLineDiagnostic =
  | { state: "testing" }
  | { state: "untested" }
  | { state: "available"; ttfbMs: number | null }
  | { state: "unavailable"; errorCode: string | null };

function probeBySourceIndex(
  probes: readonly PlaybackSourceProbe[],
): Map<number, PlaybackSourceProbe> {
  return new Map(probes.map((probe) => [probe.index, probe]));
}

/** 稳定排序：已知健康的线路、未测试的线路，然后是已知失败的。 */
export function rankPlaybackSourceIndices(
  sources: readonly PlayUrl[],
  probes: readonly PlaybackSourceProbe[],
): number[] {
  const byIndex = probeBySourceIndex(probes);
  return sources
    .map((source, index) => {
      const probe = byIndex.get(index);
      const priority = playbackSourcePriority(source, index);
      const availabilityRank = probe ? (probe.available ? 0 : 2) : 1;
      const latency = probe?.available && probe.ttfb_ms != null ? Math.max(0, probe.ttfb_ms) : 0;
      return { index, availabilityRank, latency, priority };
    })
    .sort(
      (left, right) =>
        left.availabilityRank - right.availabilityRank ||
        left.latency - right.latency ||
        left.priority - right.priority ||
        left.index - right.index,
    )
    .map(({ index }) => index);
}

export function lineDiagnostics(
  sources: readonly PlayUrl[],
  probes: readonly PlaybackSourceProbe[],
  testing: boolean,
): PlaybackLineDiagnostic[] {
  const byIndex = probeBySourceIndex(probes);
  return sources.map((_, index) => {
    const probe = byIndex.get(index);
    if (!probe) {
      return testing ? { state: "testing" } : { state: "untested" };
    }
    return probe.available
      ? { state: "available", ttfbMs: probe.ttfb_ms }
      : { state: "unavailable", errorCode: probe.error_code };
  });
}

/** 不要仅因为后台探测更快就打断健康的播放。 */
export function shouldAdoptProbeWinner(input: {
  currentIndex: number;
  winnerIndex: number;
  hasPlayed: boolean;
  probes: readonly PlaybackSourceProbe[];
  sources: readonly PlayUrl[];
}): boolean {
  if (input.winnerIndex === input.currentIndex) return false;
  const byIndex = probeBySourceIndex(input.probes);
  const current = input.sources[input.currentIndex];
  const winner = input.sources[input.winnerIndex];
  if (!current || !winner) return false;
  const currentProbe = byIndex.get(input.currentIndex);
  const winnerProbe = byIndex.get(input.winnerIndex);
  if (!winnerProbe?.available) return false;
  return !input.hasPlayed || currentProbe?.available === false;
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
