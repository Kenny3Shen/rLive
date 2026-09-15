import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { videoGetStoryboard } from "@/features/video/videoApi";
import { proxyImageUrl } from "@/shared/api/imageProxy";
import type { VideoStoryboard } from "@/shared/types/video";

/**
 * B 站视频快照（videoshot）雪碧图的**直接**取格。
 *
 * 刻意不复用 `storyboardVtt.ts`：那份把快照转成 WebVTT，是为了喂给 Video.js 的
 * TimeSlider —— 由播放器自己解析 cue、自己画预览。短视频的进度条是自绘的
 * （见 `ShortsSeekBar`），需要的是「给我一个秒数，告诉我该显示哪张图的哪一格」，
 * 中间绕一趟 VTT 文本再让别人解析没有意义。
 *
 * 两边共用的只有雪碧图的排布规则，那部分逻辑很短，重复它比把 VTT 生成器改成
 * 双用途更清楚。
 */

/** 雪碧图里的一格：图片地址 + 在图内的偏移与尺寸。 */
export type ShortsStoryboardTile = {
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 整张雪碧图的尺寸，CSS `background-size` 要用。 */
  sheetWidth: number;
  sheetHeight: number;
};

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
 * 某个秒数对应的缩略图格。
 *
 * 时间表是升序的采样点，取「最后一个不晚于目标时间的采样」—— 用线性扫描而不是
 * 二分：一条短视频的采样点通常只有几十到一百多个，二分省下的时间不值得多一份
 * 边界逻辑。
 *
 * 没有快照、图片列表为空、或算出的图片下标越界时返回 null，调用方据此只显示
 * 时间气泡不显示图。
 */
export function shortsStoryboardTile(
  storyboard: VideoStoryboard | null | undefined,
  seconds: number,
  sheetUrls: readonly string[],
): ShortsStoryboardTile | null {
  if (!storyboard) return null;
  const { img_x_len, img_y_len, img_x_size, img_y_size, index } = storyboard;
  if (!index || index.length === 0 || sheetUrls.length === 0) return null;

  const cols = img_x_len > 0 ? img_x_len : 10;
  const rows = img_y_len > 0 ? img_y_len : 10;
  const width = img_x_size > 0 ? img_x_size : 160;
  const height = img_y_size > 0 ? img_y_size : 90;
  const perSheet = cols * rows;
  if (perSheet <= 0) return null;

  const times = tileTimes(index);
  if (times.length === 0) return null;

  const target = Math.max(0, seconds);
  let slot = 0;
  for (let i = 0; i < times.length; i++) {
    if (times[i] <= target) slot = i;
    else break;
  }

  const sheetIndex = Math.floor(slot / perSheet);
  const url = sheetUrls[sheetIndex];
  if (!url) return null;

  const posInSheet = slot % perSheet;
  return {
    url,
    x: (posInSheet % cols) * width,
    y: Math.floor(posInSheet / cols) * height,
    width,
    height,
    sheetWidth: cols * width,
    sheetHeight: rows * height,
  };
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
 * **首次拖动才请求**（`armed`）：绝大多数条目不会被拖进度，换片时预取等于给每一条
 * 都白付一次 videoshot 请求。代价是第一次拖动的前几百毫秒只有时间气泡没有图 ——
 * 这比给整条流加一次请求划算。
 *
 * `armed` 一旦为真就不再回落：同一条视频里第二次拖动应该立刻有图。
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
  return { storyboard, sheetUrls };
}

/** 「是否已经拖过一次」的闩锁，供 `useShortsStoryboard` 的 `enabled` 用。 */
export function useArmedOnce(active: boolean): boolean {
  const [armed, setArmed] = useState(false);
  if (active && !armed) setArmed(true);
  return armed;
}
