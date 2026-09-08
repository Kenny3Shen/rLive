import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { VideoArchivePage, VideoItem, VideoSeasonEpisode } from "@/shared/types/video";

/**
 * 播放列表项：统一 UGC 分 P、PGC 分集与合集的抽象。
 */
export type PlaylistItem = {
  /** 唯一标识：用 `${bvid}_${cid}` 组合避免重复。 */
  id: string;
  bvid: string;
  cid: number;
  /** PGC 必填，UGC 为 null。 */
  epId: string | null;
  aid: string;
  title: string;
  /** 集号或分 P 序号的展示文本。 */
  index: string;
  duration: number;
  cover?: string;
};

/**
 * 把 UGC 合集分集转成播放列表项。合集自带 cid，可直接取流。
 */
export function playlistItemFromSeasonEpisode(
  episode: VideoSeasonEpisode,
  index: number,
): PlaylistItem {
  return {
    id: `${episode.bvid}_${episode.cid}`,
    bvid: episode.bvid,
    cid: episode.cid,
    epId: null,
    aid: episode.aid,
    title: episode.title,
    index: String(index + 1),
    duration: episode.duration,
    cover: episode.cover,
  };
}

/**
 * 搜索/投稿列表跨页去重：同一 bvid 只保留首次出现。
 *
 * 后端按单页去重，翻页接口会把同一稿件再次返回；这两类列表的网格 key
 * 与播放列表快照都以 bvid 为身份，重复条目会造成 key 冲突。
 */
export function dedupeVideoItems(items: readonly VideoItem[]): VideoItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (!item.bvid || seen.has(item.bvid)) return false;
    seen.add(item.bvid);
    return true;
  });
}

/**
 * 把搜索/UP 主投稿列表的条目转成播放列表项。
 *
 * 这两个接口不给 cid（搜索条目尤其如此），cid 填 0：播放链接只带 bvid，
 * 播放页用稿件详情补齐，与单卡点开是同一条链路。序号用列表中的位置。
 */
export function playlistItemFromVideoItem(item: VideoItem, index: number): PlaylistItem {
  return {
    id: `${item.bvid}_${item.cid ?? 0}`,
    bvid: item.bvid,
    cid: item.cid ?? 0,
    epId: null,
    aid: item.aid,
    title: item.title,
    index: String(index + 1),
    duration: item.duration,
    cover: item.cover,
  };
}

/**
 * 当前稿件是否在播放列表里（id 与 `playlistItemFromVideoItem`、VideoCard 的
 * `playListId` 同构：链接没带 cid 时列表项的 cid 本来就是 0）。
 *
 * 播放页进入单 P 且无合集的稿件时没有结构化列表可装：列表不含当前稿件
 * 说明它是上一个播放会话的残留（旧搜索/投稿/合集快照），应清空，否则
 * 「下一个」与自动连播会跳回之前看过的视频。
 */
export function playlistContainsCurrentItem(
  items: readonly PlaylistItem[],
  bvid: string | null,
  cid: number,
): boolean {
  const currentId = `${bvid ?? ""}_${cid}`;
  return items.some((item) => item.id === currentId);
}

/**
 * 把稿件分 P 转成播放列表项。同一稿件的所有 P 共享 bvid 与 aid，cid 区分每一 P。
 */
export function playlistItemFromArchivePage(
  bvid: string,
  aid: string,
  page: VideoArchivePage,
): PlaylistItem {
  return {
    id: `${bvid}_${page.cid}`,
    bvid,
    cid: page.cid,
    epId: null,
    aid,
    title: page.part || `P${page.page}`,
    index: `P${page.page}`,
    duration: page.duration,
  };
}

/**
 * 一集播完后做什么。
 *
 * 循环播放优先于自动连播：开着它是「就看这一集」的显式意图，不该被连播带走。
 * 没有下一集时连播退化成停住（进度已在 `ended` 里记满）。
 */
export function videoEndedAction(
  loopPlayback: boolean,
  autoPlayNext: boolean,
  hasNext: boolean,
): "loop" | "next" | "stop" {
  if (loopPlayback) return "loop";
  return autoPlayNext && hasNext ? "next" : "stop";
}

/** 上滑前进、下滑后退；短滑与斜向拖动不切片。识别起步方向时可传更小的阈值。 */
export function videoSwipeDirection(
  deltaX: number,
  deltaY: number,
  minDistance = 48,
): 1 | -1 | null {
  if (Math.abs(deltaY) < minDistance || Math.abs(deltaY) <= Math.abs(deltaX) * 1.25) return null;
  return deltaY < 0 ? 1 : -1;
}

export type VideoWheelGesture = {
  lastTime: number;
  distance: number;
  committed: boolean;
};

/** 向下滚轮前进、向上后退；小增量累积，一次惯性滚动只换一条。 */
export function videoWheelDirection(
  gesture: VideoWheelGesture,
  deltaY: number,
  time: number,
): 1 | -1 | null {
  // ponytail: 以 180ms 静默划分滚轮手势；设备误判时再接入平台手势阶段。
  if (time - gesture.lastTime > 180) {
    gesture.distance = 0;
    gesture.committed = false;
  }
  gesture.lastTime = time;
  if (gesture.committed) return null;
  gesture.distance += deltaY;
  const direction = videoSwipeDirection(0, -gesture.distance);
  gesture.committed = direction !== null;
  return direction;
}

/** 取当前项沿播放方向的相邻项：step=1 是「下一个」，倒序播放时方向翻转。 */
function adjacentItem(
  state: Pick<PlaylistState, "items" | "currentId" | "reversed">,
  step: 1 | -1,
): PlaylistItem | null {
  const { items, currentId, reversed } = state;
  if (items.length === 0 || !currentId) return null;

  const currentIndex = items.findIndex((item) => item.id === currentId);
  if (currentIndex === -1) return null;

  const nextIndex = currentIndex + (reversed ? -step : step);
  if (nextIndex < 0 || nextIndex >= items.length) return null;

  return items[nextIndex] ?? null;
}

/**
 * 队列来源 UP 标记：UP 投稿抽屉连播时记录队列来自哪位 UP 主，播放页据此
 * 展示来源信息。推荐 / 搜索 / 合集等普通来源为 null。
 */
export type PlaylistUploader = { mid: string; name: string };

type PlaylistState = {
  /** 当前播放列表。空数组表示无列表（单视频播放）。 */
  items: PlaylistItem[];
  /** 当前播放项的 id。 */
  currentId: string | null;
  /** 播放顺序：true 为倒序，false 为正序。 */
  reversed: boolean;
  /** 是否自动播放下一集（持久化到本地）。 */
  autoPlayNext: boolean;
  /** 是否循环播放当前视频（持久化到本地）。优先于自动播放下一集。 */
  loopPlayback: boolean;
  /** 队列来源 UP 标记（不持久化，重开应用即失效）。普通来源与清空队列时为 null。 */
  uploader: PlaylistUploader | null;
};

type PlaylistActions = {
  /**
   * 设置播放列表并开始播放指定项。第三参标记队列来自某位 UP 主；
   * 不传（普通来源）会清掉上一来源的标记，避免遗留。
   */
  setPlaylist: (items: PlaylistItem[], startId: string, uploader?: PlaylistUploader | null) => void;
  /** 清空播放列表。 */
  clearPlaylist: () => void;
  /** 切换当前播放项。 */
  setCurrentItem: (id: string) => void;
  /** 切换播放顺序。 */
  toggleReversed: () => void;
  /** 切换自动播放下一集。 */
  toggleAutoPlayNext: () => void;
  /** 切换循环播放。 */
  toggleLoopPlayback: () => void;
  /** 获取下一个播放项（如果有）。 */
  getNextItem: () => PlaylistItem | null;
  /** 获取上一个播放项（如果有）。 */
  getPreviousItem: () => PlaylistItem | null;
  /** 获取当前播放项在列表中的位置（1-based）。 */
  getCurrentPosition: () => { current: number; total: number } | null;
};

export const usePlaylistStore = create<PlaylistState & PlaylistActions>()(
  persist(
    (set, get) => ({
      items: [],
      currentId: null,
      reversed: false,
      autoPlayNext: true,
      loopPlayback: false,
      uploader: null,

      setPlaylist: (items, startId, uploader) =>
        set({
          items,
          currentId: startId,
          uploader: uploader ?? null,
        }),

      clearPlaylist: () =>
        set({
          items: [],
          currentId: null,
          uploader: null,
        }),

      setCurrentItem: (id) =>
        set({
          currentId: id,
        }),

      toggleReversed: () =>
        set((state) => ({
          reversed: !state.reversed,
        })),

      toggleAutoPlayNext: () =>
        set((state) => ({
          autoPlayNext: !state.autoPlayNext,
        })),

      toggleLoopPlayback: () =>
        set((state) => ({
          loopPlayback: !state.loopPlayback,
        })),

      getNextItem: () => adjacentItem(get(), 1),

      getPreviousItem: () => adjacentItem(get(), -1),

      getCurrentPosition: () => {
        const { items, currentId } = get();
        if (items.length === 0 || !currentId) return null;

        const currentIndex = items.findIndex((item) => item.id === currentId);
        if (currentIndex === -1) return null;

        return {
          current: currentIndex + 1,
          total: items.length,
        };
      },
    }),
    {
      name: "video-playlist",
      // 只持久化用户偏好，不持久化临时列表状态
      partialize: (state) => ({
        autoPlayNext: state.autoPlayNext,
        loopPlayback: state.loopPlayback,
        reversed: state.reversed,
      }),
    },
  ),
);
