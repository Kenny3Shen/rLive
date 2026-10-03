import { invokeCmd } from "@/shared/api/tauri";

/** 抖音作品独立于 B 站 bvid/cid；ID 全程用字符串，签名与选流只在 Rust。 */
export type DouyinVideoItem = {
  id: string;
  title: string;
  author: string;
  cover: string;
  width: number;
  height: number;
  duration: number;
};

export type DouyinVideoFeedPage = {
  items: DouyinVideoItem[];
  has_more: boolean;
};

export type DouyinVideoPlayback = {
  item: DouyinVideoItem;
  play_url: string;
  session_id: string;
};

export function douyinVideoFeed(): Promise<DouyinVideoFeedPage> {
  // 仅进入抖音推荐页后请求，不传 Cookie 或伪分页游标。
  return invokeCmd("douyin_video_feed");
}

/** 取推荐条目的播放地址。只接受推荐流下发的字符串作品 ID，登录 Cookie 是硬前提。 */
export function douyinVideoResolve(input: string): Promise<DouyinVideoPlayback> {
  return invokeCmd("douyin_video_resolve", { input });
}

export function douyinVideoStop(info: DouyinVideoPlayback): Promise<void> {
  return invokeCmd("douyin_video_stop", { sessionId: info.session_id });
}
