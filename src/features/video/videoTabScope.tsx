import { createContext, createElement, useContext, type ReactNode } from "react";
import type { VideoTab } from "./videoRoute";

const VideoTabScopeContext = createContext<VideoTab | null>(null);

/** 并排保活的视频面板使用固定页签，避免所有面板都跟随当前 URL 重渲染同一份内容。 */
export function VideoTabScope({ value, children }: { value: VideoTab; children: ReactNode }) {
  return createElement(VideoTabScopeContext.Provider, { value }, children);
}

export function useVideoTabScope(): VideoTab | null {
  return useContext(VideoTabScopeContext);
}
