import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ThumbnailImage } from "@videojs/core";
import { videoGetStoryboard } from "@/features/video/videoApi";
import { proxyImageUrl } from "@/shared/api/imageProxy";
import type { VideoStoryboard } from "@/shared/types/video";

/**
 * B 站视频快照（videoshot）雪碧图。
 *
 * 输出的是 `ThumbnailImage[]`，直接喂给 Video.js 的
 * `Slider.Thumbnail.Root`（`thumbnails` 属性）：它按 `startTime` 找当前采样、按
 * `coords` 裁雪碧图、按 `width` / `height` 定容器尺寸。
 *
 * 与 `storyboardVtt.ts` 仍然是两份：那份生成 WebVTT 文本挂到媒体元素的
 * `<track>` 上，由播放器自己解析 cue。短视频的进度条没有 `<track>`，把数组直接
 * 交给原语更短，也省掉一次文本解析。两边共用的只有雪碧图的排布规则。
 */

/**
 * 快照元数据里的时间表。
 *
 * B 站规范里第 0 项恒为 0，第 1 项是第 0 张图对应的时间（也是 0）。首两项都为 0 时
 * 从第 1 项起算，与 `storyboardToVtt` 同一处理。
 */
function tileTimes(index: readonly number[]): readonly number[] {
  return index.length > 1 && index[0] === 0 && index[1] === 0 ? index.slice(1) : index;
}

/**
 * 雪碧图地址归一：协议相对补 https，再改写到本机图片代理。
 *
 * 代理是必须的而不是优化：videoshot CDN 对带非 bilibili Referer 的请求回 403，
 * 而 WebView 无法为 `<img>` / CSS 背景去掉 Referer —— 只有代理能补上平台请求头。
 * 代理未就绪时回退直连，最坏退化为无缩略图。
 */
export function shortsStoryboardSheetUrls(
  storyboard: VideoStoryboard | null | undefined,
): string[] {
  if (!storyboard?.images) return [];
  return storyboard.images.map((raw) => {
    if (!raw) return "";
    const absolute = raw.startsWith("//") ? `https:${raw}` : raw;
    return proxyImageUrl(absolute) ?? absolute;
  });
}

/**
 * 短视频的缩略图轨。
 *
 * **首次交互（悬停或拖动）才请求**（`enabled`）：绝大多数条目不会被查看进度，换片时
 * 预取等于给每一条都白付一次 videoshot 请求。代价是第一次交互的前几百毫秒只有时间
 * 没有图 —— 这比给整条流加一次请求划算。
 *
 * 一旦为真就不再回落：同一条视频里第二次交互应该立刻有图。
 */
export function useShortsStoryboard({
  bvid,
  cid,
  enabled,
}: {
  bvid: string;
  cid: number;
  enabled: boolean;
}) {
  const query = useQuery({
    queryKey: ["shorts_storyboard", bvid, cid],
    enabled: enabled && bvid !== "" && cid > 0,
    queryFn: () => videoGetStoryboard({ bvid, cid, ep_id: null }),
    // 快照是稿件的静态产物，同一条视频不会变。
    staleTime: Infinity,
  });
  const storyboard = query.data ?? null;
  // 地址归一只跟数据有关，不该每次拖动重算（一次拖动会渲染几十帧）。
  const sheetUrls = useMemo(() => shortsStoryboardSheetUrls(storyboard), [storyboard]);
  // 整表映射同理：拖动期间每秒重渲染数次，取格交给原语后这里不应再进热路径。
  const thumbnails = useMemo(
    () => shortsStoryboardThumbnails(storyboard, sheetUrls),
    [storyboard, sheetUrls],
  );
  return { storyboard, sheetUrls, thumbnails };
}

/**
 * 快照元数据 → Video.js 缩略图轨（`ThumbnailImage[]`）。
 *
 * 取格逻辑由原语承担：它按 `startTime` 找当前采样、按 `coords` 裁雪碧图、按
 * `width` / `height` 定容器尺寸。这里因此一次性地铺出整表，而不是「给一个秒数取一格」。
 */
export function shortsStoryboardThumbnails(
  storyboard: VideoStoryboard | null | undefined,
  sheetUrls: readonly string[],
): ThumbnailImage[] {
  if (!storyboard || sheetUrls.length === 0) return [];
  const { img_x_len, img_y_len, img_x_size, img_y_size, index } = storyboard;
  if (!index || index.length === 0) return [];

  const cols = img_x_len > 0 ? img_x_len : 10;
  const rows = img_y_len > 0 ? img_y_len : 10;
  const width = img_x_size > 0 ? img_x_size : 160;
  const height = img_y_size > 0 ? img_y_size : 90;
  const perSheet = cols * rows;
  if (perSheet <= 0) return [];

  const times = tileTimes(index);
  if (times.length === 0) return [];

  const thumbnails: ThumbnailImage[] = [];
  for (let slot = 0; slot < times.length; slot += 1) {
    const url = sheetUrls[Math.floor(slot / perSheet)];
    // 采样表比图片列表长（上游数据不一致）时末尾几格没有对应的图：整段丢掉，
    // 好过让气泡在末尾显示一次加载失败。
    if (!url) break;
    const posInSheet = slot % perSheet;
    thumbnails.push({
      url,
      startTime: Math.max(0, times[slot] ?? 0),
      width,
      height,
      coords: {
        x: (posInSheet % cols) * width,
        y: Math.floor(posInSheet / cols) * height,
      },
    });
  }
  return thumbnails;
}
