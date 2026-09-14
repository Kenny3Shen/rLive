import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  SeasonEpisode,
  VideoArchive,
  VideoArchivePage,
  VideoItem,
  VideoSeasonEpisode,
} from "@/shared/types/video";

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
 * 把 PGC 分集转成播放列表项。分集自带 `ep_id`，换集与续播都以它定位。
 */
export function playlistItemFromPgcEpisode(episode: SeasonEpisode): PlaylistItem {
  return {
    id: `${episode.bvid}_${episode.cid}`,
    bvid: episode.bvid,
    cid: episode.cid,
    epId: episode.ep_id,
    aid: episode.aid,
    title: episode.long_title || episode.title,
    index: episode.title,
    duration: episode.duration,
    cover: episode.cover,
  };
}

/**
 * 当前视频自身的选集里，当前项的下一项。
 *
 * 「选集」是稿件/剧集自带的顺序，与来源队列（推荐、搜索、UP 投稿）无关：
 * PGC 走分集表，UGC 优先多 P 分 P，其次合集分集。控制条的「播放下一个」
 * 只沿它走，因此按钮在视频没有选集或已在最后一集时都不出现。
 */
export function nextSelectionItem(input: {
  /** PGC 的 ep_id；UGC 为 null。 */
  epId: string | null;
  bvid: string | null;
  cid: number;
  /** PGC 分集表（`epId` 存在时由调用方给出）。 */
  episodes?: readonly SeasonEpisode[] | null;
  /** UGC 稿件详情：多 P 分 P 与合集都从这里取。 */
  archive?: VideoArchive | null;
}): PlaylistItem | null {
  if (input.epId) {
    const items = (input.episodes ?? []).map(playlistItemFromPgcEpisode);
    const index = items.findIndex((item) => item.epId === input.epId);
    return index < 0 ? null : (items[index + 1] ?? null);
  }

  const archive = input.archive;
  if (!archive) return null;

  if (archive.pages.length > 0) {
    const items = archive.pages.map((page) =>
      playlistItemFromArchivePage(archive.bvid, archive.aid, page),
    );
    const index = items.findIndex((item) => item.cid === input.cid);
    return index < 0 ? null : (items[index + 1] ?? null);
  }

  const episodes = archive.ugc_season?.episodes ?? [];
  const index = episodes.findIndex((episode) => episode.bvid === input.bvid);
  const next = index < 0 ? undefined : episodes[index + 1];
  return next ? playlistItemFromSeasonEpisode(next, index + 1) : null;
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
 * 循环播放优先于两种连播：开着它是「就看这一集」的显式意图，不该被连播带走。
 * 队列没有下一集时退到相关连播（自动连播开关），再没有就停住（进度已在
 * `ended` 里记满）。
 */
export function videoEndedAction(
  loopPlayback: boolean,
  autoPlayNext: boolean,
  hasNext: boolean,
  autoPlayRelated: boolean,
): "loop" | "next" | "related" | "stop" {
  if (loopPlayback) return "loop";
  if (autoPlayNext && hasNext) return "next";
  return autoPlayRelated ? "related" : "stop";
}

/** 取当前项沿播放方向的相邻项：step=1 是「下一个」，-1 是「上一个」。 */
function adjacentItem(
  state: Pick<PlaylistState, "items" | "currentId">,
  step: 1 | -1,
): PlaylistItem | null {
  const { items, currentId } = state;
  if (items.length === 0 || !currentId) return null;

  const currentIndex = items.findIndex((item) => item.id === currentId);
  if (currentIndex === -1) return null;

  const nextIndex = currentIndex + step;
  if (nextIndex < 0 || nextIndex >= items.length) return null;

  return items[nextIndex] ?? null;
}

/**
 * 队列来源 UP 标记：UP 投稿抽屉连播时记录队列来自哪位 UP 主，播放页据此
 * 展示来源信息。推荐 / 搜索 / 合集等普通来源为 null。
 */
export type PlaylistUploader = { mid: string; name: string };

/** 推荐/热门/相关流只供手动换片；选集、合集、搜索与 UP 投稿队列可自动连播。 */
export type PlaylistKind = "feed" | "sequence";

type PlaylistState = {
  /** 当前播放列表。空数组表示无列表（单视频播放）。 */
  items: PlaylistItem[];
  /** 当前播放项的 id。 */
  currentId: string | null;
  /** 临时队列类型，不持久化。 */
  kind: PlaylistKind;
  /** 是否自动播放下一集（持久化到本地）。 */
  autoPlayNext: boolean;
  /** 是否循环播放当前视频（持久化到本地）。优先于两种连播。 */
  loopPlayback: boolean;
  /**
   * 队列走完后是否自动连播当前视频的相关视频（持久化到本地）。连播目标是相关
   * 视频接口的第一个；本轮列表随之换成相关流队列。PGC 剧集不适用（无相关视频
   * 列表，也没有可定位的 bvid）。
   *
   * 默认开启：来源流播完接着看相关视频在引入开关前就是既有行为，这个开关是给
   * 它一个显式出口与固定节拍，而不是把它变成要用户自己去找的选配。
   */
  autoPlayRelated: boolean;
  /** 队列来源 UP 标记（不持久化，重开应用即失效）。普通来源与清空队列时为 null。 */
  uploader: PlaylistUploader | null;
};

type PlaylistActions = {
  /** 设置队列及其连播语义；未传 UP 来源时清除旧标记。 */
  setPlaylist: (
    items: PlaylistItem[],
    startId: string,
    kind: PlaylistKind,
    uploader?: PlaylistUploader | null,
  ) => void;
  /** 清空播放列表。 */
  clearPlaylist: () => void;
  /** 切换当前播放项。 */
  setCurrentItem: (id: string) => void;
  /** 切换自动播放下一集。 */
  toggleAutoPlayNext: () => void;
  /** 切换循环播放。 */
  toggleLoopPlayback: () => void;
  /** 切换队列走完后自动连播相关视频。 */
  toggleAutoPlayRelated: () => void;
  /** 获取下一个播放项（如果有）。 */
  getNextItem: () => PlaylistItem | null;
  /** 获取可自动连播的下一项；推荐流的邻项不作为下一集。 */
  getNextAutoPlayItem: () => PlaylistItem | null;
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
      kind: "sequence",
      autoPlayNext: true,
      loopPlayback: false,
      autoPlayRelated: true,
      uploader: null,

      setPlaylist: (items, startId, kind, uploader) =>
        set({
          items,
          currentId: startId,
          kind,
          uploader: uploader ?? null,
        }),

      clearPlaylist: () =>
        set({
          items: [],
          currentId: null,
          kind: "sequence",
          uploader: null,
        }),

      setCurrentItem: (id) =>
        set({
          currentId: id,
        }),

      toggleAutoPlayNext: () =>
        set((state) => ({
          autoPlayNext: !state.autoPlayNext,
        })),

      toggleLoopPlayback: () =>
        set((state) => ({
          loopPlayback: !state.loopPlayback,
        })),

      toggleAutoPlayRelated: () =>
        set((state) => ({
          autoPlayRelated: !state.autoPlayRelated,
        })),

      getNextItem: () => adjacentItem(get(), 1),

      getNextAutoPlayItem: () => {
        const state = get();
        return state.kind === "feed" ? null : adjacentItem(state, 1);
      },

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
        autoPlayRelated: state.autoPlayRelated,
      }),
    },
  ),
);
