import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent, RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { invokeCmd } from "@/shared/api/tauri";
import type { LivePlayQuality, LiveRoomDetail, PlayUrl, SiteId } from "@/shared/types/live";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import {
  ROOM_CARD_PREVIEW_DELAY_MS,
  isRoomCardPreviewPointer,
  startRoomCardPreview,
  supportsRoomCardPreview,
  type RoomCardPreviewHandle,
  type RoomCardPreviewPhase,
} from "./roomCardPreview";

export type RoomCardPreview = {
  /** 挂载点须位于封面容器内、渐变遮罩之下,并且自身不接收指针事件。 */
  mountRef: RefObject<HTMLDivElement | null>;
  phase: RoomCardPreviewPhase;
  onPointerEnter: (event: PointerEvent<HTMLElement>) => void;
  stop: () => void;
};

/**
 * 悬停一段时间后在卡片封面上播放静音预览。取流走房间播放器同一套
 * `site_get_room_detail` / `site_get_play_qualities` / `site_get_play_urls` 查询缓存,
 * 因此预览暖过的房间点进去可以省掉一轮请求。
 */
export function useRoomCardPreview(target: { siteId: SiteId; roomId: string }): RoomCardPreview {
  const { siteId, roomId } = target;
  const queryClient = useQueryClient();
  const enabled = useSettingsStore((state) => state.roomCardPreviewEnabled);
  // 指针能力与无障碍偏好在一次会话内不变,每张卡片只探测一次。
  const supported = useMemo(() => supportsRoomCardPreview(), []);
  const [phase, setPhase] = useState<RoomCardPreviewPhase>("idle");
  const mountRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<RoomCardPreviewHandle | null>(null);
  const dwellTimerRef = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (dwellTimerRef.current !== null) {
      window.clearTimeout(dwellTimerRef.current);
      dwellTimerRef.current = null;
    }
    handleRef.current?.stop();
    handleRef.current = null;
  }, []);

  const onPointerEnter = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (!enabled || !supported) return;
      if (!isRoomCardPreviewPointer(event.pointerType)) return;
      stop();
      dwellTimerRef.current = window.setTimeout(() => {
        dwellTimerRef.current = null;
        const mount = mountRef.current;
        if (!mount) return;
        handleRef.current = startRoomCardPreview({
          mount,
          onPhase: setPhase,
          fetchDetail: () =>
            queryClient.fetchQuery({
              queryKey: ["room_detail", siteId, roomId],
              queryFn: () =>
                invokeCmd<LiveRoomDetail>("site_get_room_detail", { siteId, roomId }),
              staleTime: 60_000,
            }),
          fetchQualities: (detail) =>
            queryClient.fetchQuery({
              queryKey: ["play_qualities", siteId, roomId, detail.room_id],
              staleTime: 0,
              gcTime: 30_000,
              queryFn: () =>
                invokeCmd<LivePlayQuality[]>("site_get_play_qualities", { siteId, detail }),
            }),
          fetchLines: (detail, quality) =>
            queryClient.fetchQuery({
              queryKey: ["play_urls", siteId, roomId, quality.quality, quality.data],
              staleTime: 0,
              gcTime: 15_000,
              queryFn: () =>
                invokeCmd<PlayUrl[]>("site_get_play_urls", { siteId, detail, quality }),
            }),
        });
      }, ROOM_CARD_PREVIEW_DELAY_MS);
    },
    [enabled, queryClient, roomId, siteId, stop, supported],
  );

  // 关掉开关或卡片被虚拟化移除时立刻释放本机代理会话。
  useEffect(() => {
    if (!enabled) stop();
    return stop;
  }, [enabled, stop]);

  return { mountRef, phase, onPointerEnter, stop };
}
