import type { VideoDimension } from "./types/video";

/** 列表下发的实际显示宽高比。rotate 是非零即交换的标志；非法尺寸不猜画幅。 */
export function videoDimensionAspect(dimension: VideoDimension | null | undefined): number | null {
  if (!dimension) return null;
  const { width, height, rotate } = dimension;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return rotate === 0 ? width / height : height / width;
}
