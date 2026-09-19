import type { VideoDimension } from "./types/video";

/** 列表下发的实际显示宽高比。rotate 是非零即交换的标志；非法尺寸不猜画幅。 */
export function videoDimensionAspect(dimension: VideoDimension | null | undefined): number | null {
  if (!dimension) return null;
  const { width, height, rotate } = dimension;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return rotate === 0 ? width / height : height / width;
}

/** UGC 封面遵循实际画幅；尺寸未知或 PGC 调用方不传时保持原来的 16:9。 */
export function videoCoverAspect(dimension: VideoDimension | null | undefined): number {
  return videoDimensionAspect(dimension) ?? 16 / 9;
}
