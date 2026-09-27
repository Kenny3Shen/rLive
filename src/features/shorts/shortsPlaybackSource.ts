import type { QueryClient } from "@tanstack/react-query";
import { videoGetPlayInfo, videoStopPlay } from "@/features/video/videoApi";
import { VIDEO_HISTORY_QUERY_KEY, videoHistoryAdd } from "@/features/video/videoHistory";
import type { VideoItem, VideoPlayInfo } from "@/shared/types/video";
import {
  douyinVideoResolve,
  douyinVideoStop,
  type DouyinVideoItem,
  type DouyinVideoPlayback,
} from "./douyinVideoApi";
import { shortsItemKey } from "./shortsFeed";

/** 平台只提供身份、取流与元数据；槽位、预热及会话所有权共用同一实现。 */
export interface ShortsPlaybackSource<Item, Info> {
  readonly id: string;
  readonly kind: "dash" | "native";
  key(item: Item): string;
  canPlay(item: Item): boolean;
  load(item: Item): Promise<Info>;
  stop(info: Info): Promise<void>;
  sessionId(info: Info): string;
  url(info: Info): string;
  duration(info: Info): number;
  /** 可选的平台历史；节流与活动槽位门控仍由共用 hook 负责。 */
  reportProgress?(
    item: Item,
    info: Info | null,
    position: number,
    now: number,
    queryClient: QueryClient,
  ): void;
}

/** 模块级常量保证引用稳定：角色提升不会使播放器重新附着。 */
export const BILIBILI_SHORTS_SOURCE: ShortsPlaybackSource<VideoItem, VideoPlayInfo> = {
  id: "bilibili",
  kind: "dash",
  key: shortsItemKey,
  canPlay: (item) => item.bvid !== "" && (item.cid ?? 0) > 0,
  load: (item) =>
    videoGetPlayInfo({
      bvid: item.bvid,
      cid: item.cid ?? 0,
      ep_id: null,
      qn: null,
      audio_only: false,
      // 回滑与重进会重复请求同一条的分片，让代理沿用现有磁盘缓存。
      media_cache: true,
    }),
  stop: (info) => videoStopPlay(info.session_ids),
  sessionId: (info) => info.session_ids.mpd,
  url: (info) => info.mpd_url,
  duration: (info) => info.duration,
  reportProgress: (item, info, position, now, queryClient) => {
    void videoHistoryAdd({
      kind: "ugc",
      oid: item.bvid,
      title: item.title,
      cover: item.cover,
      author: item.author,
      part_title: "",
      bvid: item.bvid,
      cid: item.cid ?? 0,
      ep_id: "",
      aid: item.aid,
      progress: position,
      duration: info?.duration ?? 0,
      watched_at: now,
    })
      .then(() => queryClient.invalidateQueries({ queryKey: VIDEO_HISTORY_QUERY_KEY }))
      .catch(() => undefined);
  },
};

/** 抖音推荐只用原生媒体与 Rust 代理，不伪造 B 站身份，也不上报 B 站历史。 */
export const DOUYIN_SHORTS_SOURCE: ShortsPlaybackSource<DouyinVideoItem, DouyinVideoPlayback> = {
  id: "douyin",
  kind: "native",
  key: (item) => `douyin:${item.id}`,
  canPlay: (item) => item.id.trim() !== "",
  load: (item) => douyinVideoResolve(item.id, true),
  stop: douyinVideoStop,
  sessionId: (info) => info.session_id,
  url: (info) => info.play_url,
  duration: (info) => info.item.duration,
};
