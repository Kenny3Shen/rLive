/**
 * B 站视频快照（videoshot）元数据 → WebVTT 缩略图轨（storyboard）。
 *
 * 遵循 Video.js 缩略图轨道规范：
 * - kind="metadata"
 * - label="thumbnails"
 * - 每个 cue 格式为 `start --> end\n<image_url>#xywh=<x>,<y>,<w>,<h>`
 */

import type { VideoStoryboard } from "@/shared/types/video";
import { proxyImageUrl } from "@/shared/api/imageProxy";

function vttTimestamp(seconds: number): string {
  const total = Math.max(0, seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const millis = Math.round((total - Math.floor(total)) * 1000);
  return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

export function storyboardToVtt(
  storyboard: VideoStoryboard | null | undefined,
  videoDuration?: number | null,
): string {
  if (!storyboard) return "";
  const { img_x_len, img_y_len, img_x_size, img_y_size, images, index } = storyboard;

  if (!images || images.length === 0 || !index || index.length === 0) {
    return "";
  }

  const cols = img_x_len > 0 ? img_x_len : 10;
  const rows = img_y_len > 0 ? img_y_len : 10;
  const perSheet = cols * rows;
  const w = img_x_size > 0 ? img_x_size : 160;
  const h = img_y_size > 0 ? img_y_size : 90;

  // B 站快照 index 规范中第 0 项恒为 0，第 1 项为第 0 张图对应的时间（0 秒）。
  // 若首两项均为 0，则从第 1 项起算；否则按完整数组处理。
  const times = index.length > 1 && index[0] === 0 && index[1] === 0 ? index.slice(1) : index;

  if (times.length === 0) return "";

  // 雪碧图按张解析一次：协议相对 URL 补 https，再改写到本机图片代理。
  // B 站 videoshot CDN 对带非 bilibili Referer 的请求回 403，而 WebView 无法
  // 为 <img> 去掉 Referer —— 只有代理能补上平台请求头；它同时回
  // `Access-Control-Allow-Origin: *`，满足缩略图 img 从媒体元素继承的
  // `crossOrigin="anonymous"`。代理未就绪时回退直连，最坏退化为无缩略图。
  const sheetUrls = images.map((raw) => {
    if (!raw) return "";
    const absolute = raw.startsWith("//") ? `https:${raw}` : raw;
    return proxyImageUrl(absolute) ?? absolute;
  });

  const cues: string[] = [];

  for (let i = 0; i < times.length; i++) {
    const sheetIndex = Math.floor(i / perSheet);
    if (sheetIndex >= images.length) break;
    const imageUrl = sheetUrls[sheetIndex];
    if (!imageUrl) continue;

    const start = times[i];
    let end: number;
    if (i + 1 < times.length) {
      end = times[i + 1];
    } else if (typeof videoDuration === "number" && videoDuration > start) {
      end = videoDuration;
    } else {
      // 最后一帧推算：取上一帧步进或默认 10 秒
      const prevInterval = i > 0 ? start - times[i - 1] : 10;
      end = start + Math.max(1, prevInterval);
    }

    // WebVTT 要求 cue 的 end 必须严格大于 start
    if (end <= start) {
      end = start + 1;
    }

    const posInSheet = i % perSheet;
    const col = posInSheet % cols;
    const row = Math.floor(posInSheet / cols);
    const x = col * w;
    const y = row * h;

    const cueTime = `${vttTimestamp(start)} --> ${vttTimestamp(end)}`;
    const cuePayload = `${imageUrl}#xywh=${x},${y},${w},${h}`;
    cues.push(`${cueTime}\n${cuePayload}`);
  }

  if (cues.length === 0) return "";
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}
