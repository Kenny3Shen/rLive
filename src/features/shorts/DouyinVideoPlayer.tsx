import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState } from "@/shared/components/ErrorState";
import { PendingPlaybackRequests } from "./pendingPlaybackRequests";
import { douyinVideoResolve, douyinVideoStop, type DouyinVideoPlayback } from "./douyinVideoApi";

function release(info: DouyinVideoPlayback) {
  void douyinVideoStop(info).catch(() => undefined);
}

/** 单作品与推荐流共用一个原生播放器；代理所有权不进入 Feed 缓存。 */
export function DouyinVideoPlayer({
  input,
  requireLogin = false,
}: {
  input: string;
  requireLogin?: boolean;
}) {
  const [revision, setRevision] = useState(0);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const ownerId = useId();
  const videoRef = useRef<HTMLVideoElement>(null);
  const pending = useMemo(
    () => new PendingPlaybackRequests<DouyinVideoPlayback>(release),
    // 每次换片/重试是新的所有权范围；迟到的 invoke 结果仍由旧范围释放。
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [input, requireLogin, revision],
  );
  useEffect(() => () => pending.clear(), [pending]);
  const query = useQuery({
    queryKey: ["douyin_video", "douyin", ownerId, input, requireLogin, revision],
    queryFn: ({ signal }) => pending.acquire(signal, () => douyinVideoResolve(input, requireLogin)),
    retry: false,
    gcTime: 0,
    staleTime: Infinity,
    structuralSharing: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const info = query.data;
  const currentLease = useRef<DouyinVideoPlayback | null>(null);
  useEffect(() => {
    if (!info) return;
    pending.claim(info);
    currentLease.current = info;
    const media = videoRef.current;
    if (media) {
      media.src = info.play_url;
      media.load();
      // 自动播放被拦截时保留原生播放按钮，不算取流失败。
      void media.play().catch(() => undefined);
    }
    return () => {
      media?.pause();
      media?.removeAttribute("src");
      media?.load();
      currentLease.current = null;
      queueMicrotask(() => {
        // StrictMode 重新接管同一会话时不误停。
        // oxlint-disable-next-line react-hooks/exhaustive-deps
        if (currentLease.current !== info) release(info);
      });
    };
  }, [info, pending]);

  const retry = () => {
    setMediaError(null);
    setRevision((value) => value + 1);
  };
  return (
    <div className="flex flex-col gap-3" data-slot="douyin-video-player">
      {query.isFetching && (
        <p role="status" className="flex items-center gap-2 text-sm">
          <Spinner />
          正在解析作品
        </p>
      )}
      {query.isError && <ErrorState error={query.error} title="作品解析失败" onRetry={retry} />}
      {mediaError && <ErrorState error={mediaError} title="作品播放失败" onRetry={retry} />}
      {info && (
        <>
          <video
            ref={videoRef}
            key={info.session_id}
            controls
            playsInline
            loop
            preload="metadata"
            aria-label={info.item.title || "抖音视频作品"}
            className="max-h-[65dvh] w-full rounded-lg bg-black object-contain"
            onError={() => setMediaError("媒体地址可能已过期或当前设备无法解码，请重试重新取流。")}
          />
          <h2 className="text-base font-medium break-words">{info.item.title || "未命名作品"}</h2>
          <p className="text-sm text-muted-foreground">{info.item.author || "未知作者"}</p>
        </>
      )}
    </div>
  );
}
