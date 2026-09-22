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
  share_url: string;
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
  // 只能从用户显式开启后挂载的推荐组件调用，不传 Cookie 或伪分页游标。
  return invokeCmd("douyin_video_feed", { consent: true });
}

export function douyinVideoResolve(
  input: string,
  requireLogin = false,
): Promise<DouyinVideoPlayback> {
  return invokeCmd("douyin_video_resolve", { input, requireLogin });
}

export function douyinVideoStop(info: DouyinVideoPlayback): Promise<void> {
  return invokeCmd("douyin_video_stop", { sessionId: info.session_id });
}
