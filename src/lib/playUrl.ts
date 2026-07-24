/** Use stable, human-readable labels rather than exposing CDN host names. */
export function lineLabel(url: string, index: number): string {
  const transport = /\.m3u8(?:[?#]|$)|(?:[/?&=_-])hls(?:[/?&=_-]|$)/i.test(url) ? "HLS" : "FLV";
  return `线路${index + 1}（${transport}）`;
}

export function clampIndex(i: number, len: number): number {
  if (len <= 0) return 0;
  return Math.max(0, Math.min(i, len - 1));
}
