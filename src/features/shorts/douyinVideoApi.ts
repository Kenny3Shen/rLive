import { invokeCmd } from "@/shared/api/tauri";

/** 抖音作品独立于 B 站 bvid/cid；ID 全程用字符串，签名与选流只在 Rust。 */
export type DouyinVideoPlayback = {
  item: {
    id: string;
    title: string;
    author: string;
    cover: string;
    width: number;
    height: number;
    duration: number;
    share_url: string;
  };
  play_url: string;
  session_id: string;
};

export function douyinVideoResolve(input: string): Promise<DouyinVideoPlayback> {
  return invokeCmd("douyin_video_resolve", { input });
}

export function douyinVideoStop(info: DouyinVideoPlayback): Promise<void> {
  return invokeCmd("douyin_video_stop", { sessionId: info.session_id });
}
