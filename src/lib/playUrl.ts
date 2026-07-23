/** Prefer short host for line label; fall back to 线路 n (1-based). */
export function lineLabel(url: string, index: number): string {
  try {
    const host = new URL(url).hostname;
    if (host) return host.replace(/^www\./, "");
  } catch {
    /* ignore */
  }
  return `线路${index + 1}`;
}

export function clampIndex(i: number, len: number): number {
  if (len <= 0) return 0;
  return Math.max(0, Math.min(i, len - 1));
}
