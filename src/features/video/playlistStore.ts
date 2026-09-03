import { create } from "zustand";
import { persist } from "zustand/middleware";

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

type PlaylistState = {
  /** 当前播放列表。空数组表示无列表（单视频播放）。 */
  items: PlaylistItem[];
  /** 当前播放项的 id。 */
  currentId: string | null;
  /** 播放顺序：true 为倒序，false 为正序。 */
  reversed: boolean;
  /** 是否自动播放下一集（持久化到本地）。 */
  autoPlayNext: boolean;
};

type PlaylistActions = {
  /** 设置播放列表并开始播放指定项。 */
  setPlaylist: (items: PlaylistItem[], startId: string) => void;
  /** 清空播放列表。 */
  clearPlaylist: () => void;
  /** 切换当前播放项。 */
  setCurrentItem: (id: string) => void;
  /** 切换播放顺序。 */
  toggleReversed: () => void;
  /** 切换自动播放下一集。 */
  toggleAutoPlayNext: () => void;
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

      setPlaylist: (items, startId) =>
        set({
          items,
          currentId: startId,
        }),

      clearPlaylist: () =>
        set({
          items: [],
          currentId: null,
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

      getNextItem: () => {
        const { items, currentId, reversed } = get();
        if (items.length === 0 || !currentId) return null;

        const currentIndex = items.findIndex((item) => item.id === currentId);
        if (currentIndex === -1) return null;

        const nextIndex = reversed ? currentIndex - 1 : currentIndex + 1;
        if (nextIndex < 0 || nextIndex >= items.length) return null;

        return items[nextIndex] ?? null;
      },

      getPreviousItem: () => {
        const { items, currentId, reversed } = get();
        if (items.length === 0 || !currentId) return null;

        const currentIndex = items.findIndex((item) => item.id === currentId);
        if (currentIndex === -1) return null;

        const prevIndex = reversed ? currentIndex + 1 : currentIndex - 1;
        if (prevIndex < 0 || prevIndex >= items.length) return null;

        return items[prevIndex] ?? null;
      },

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
        reversed: state.reversed,
      }),
    },
  ),
);
