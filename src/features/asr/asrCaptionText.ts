import { useSyncExternalStore } from "react";

/** 字幕叠加层显示的文本内容：随每个识别窗 / 翻译批次变化。 */
export type AsrCaptionText = {
  /** 已定稿的可见行。 */
  caption: string | null;
  /** 在途假设文本，每个窗口替换。 */
  partial: string | null;
  translatedCaption: string | null;
  translationNotice: string | null;
};

/**
 * 字幕文本的外部 store。
 *
 * 识别窗约 0.5–2s 一次，每次都改写在途假设；这些文本若放在 `useAsrCaptions` 的
 * state 里，宿主（直播间、点播、IPTV、多画面的整页播放器）会随每个窗口整页重渲染。
 * 文本只有 `AsrCaptionOverlay` 读取，因此由它单独订阅，宿主只持有低频的开关与状态。
 */
export type AsrCaptionTextStore = {
  get: () => AsrCaptionText;
  update: (
    patch: Partial<AsrCaptionText> | ((current: AsrCaptionText) => Partial<AsrCaptionText>),
  ) => void;
  subscribe: (listener: () => void) => () => void;
};

const EMPTY_TEXT: AsrCaptionText = {
  caption: null,
  partial: null,
  translatedCaption: null,
  translationNotice: null,
};

export function createAsrCaptionTextStore(): AsrCaptionTextStore {
  let snapshot = EMPTY_TEXT;
  const listeners = new Set<() => void>();
  return {
    get: () => snapshot,
    update: (patch) => {
      const changes = typeof patch === "function" ? patch(snapshot) : patch;
      let next: AsrCaptionText | null = null;
      for (const key of Object.keys(changes) as (keyof AsrCaptionText)[]) {
        const value = changes[key];
        if (value === undefined || Object.is(value, snapshot[key])) continue;
        next ??= { ...snapshot };
        next[key] = value;
      }
      // 内容不变时不通知：每个窗口都会写一次「无在途假设」。
      if (!next) return;
      snapshot = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function useAsrCaptionText(store: AsrCaptionTextStore): AsrCaptionText {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
