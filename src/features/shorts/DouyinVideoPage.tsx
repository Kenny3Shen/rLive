import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ArrowLeft, Play } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState } from "@/shared/components/ErrorState";
import { PendingPlaybackRequests } from "./pendingPlaybackRequests";
import { douyinVideoResolve, douyinVideoStop, type DouyinVideoPlayback } from "./douyinVideoApi";

/**
 * 实验入口只消费单作品，不伪装成 B 站条目，也不复制三槽/Feed/弹幕实现。
 * MP4 直接走原生媒体，请求头与 Range 交给既有 Rust stream_proxy。
 */
export function DouyinVideoPage() {
  const [input, setInput] = useState("");
  const [request, setRequest] = useState<{ input: string; revision: number } | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const ownerId = useId();
  const videoRef = useRef<HTMLVideoElement>(null);
  const release = (info: DouyinVideoPlayback) => {
    void douyinVideoStop(info).catch(() => undefined);
  };
  const pending = useMemo(
    () => new PendingPlaybackRequests<DouyinVideoPlayback>(release),
    // 每次显式打开/重试是新的所有权范围。
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [request],
  );
  useEffect(() => () => pending.clear(), [pending]);
  const query = useQuery({
    queryKey: ["douyin_video", ownerId, request],
    enabled: request !== null,
    queryFn: ({ signal }) => pending.acquire(signal, () => douyinVideoResolve(request!.input)),
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
      // 自动播放受浏览器策略限制时保留原生播放按钮，不把它当成取流失败。
      void media.play().catch(() => undefined);
    }
    return () => {
      media?.pause();
      media?.removeAttribute("src");
      media?.load();
      currentLease.current = null;
      // StrictMode 重新运行 setup 时不误停重新接管的同一会话。
      queueMicrotask(() => {
        // oxlint-disable-next-line react-hooks/exhaustive-deps
        if (currentLease.current !== info) release(info);
      });
    };
    // release 只使用模块级 API，无渲染闭包。
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [info, pending]);

  const open = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setMediaError(null);
    setRequest((previous) => ({ input: trimmed, revision: (previous?.revision ?? 0) + 1 }));
  };

  return (
    <section
      className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-5"
      data-slot="douyin-video-page"
    >
      <header className="flex flex-wrap items-center gap-3">
        <Link to="/shorts" className={buttonVariants({ variant: "ghost", size: "sm" })}>
          <ArrowLeft data-icon="inline-start" />B 站短视频
        </Link>
        <h1 className="text-lg font-semibold">抖音作品</h1>
        <Badge variant="secondary">实验性</Badge>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          open(input);
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="douyin-video-input">作品链接或分享文字</FieldLabel>
            <Input
              id="douyin-video-input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="粘贴抖音作品链接、分享文字或作品 ID"
              autoComplete="off"
              maxLength={4096}
              required
              aria-describedby="douyin-video-help"
            />
            <FieldDescription id="douyin-video-help">
              支持公开视频作品，不支持图集和直播。访问验证或作品不可见时无法播放；暂不提供推荐流、评论、点赞与观看历史。
            </FieldDescription>
          </Field>
          <Field orientation="horizontal">
            <Button type="submit" disabled={!input.trim() || query.isFetching}>
              {query.isFetching ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <Play data-icon="inline-start" />
              )}
              {query.isFetching ? "正在解析" : "打开作品"}
            </Button>
          </Field>
        </FieldGroup>
      </form>
      {query.isError && (
        <ErrorState
          error={query.error}
          title="作品解析失败"
          onRetry={() => request && open(request.input)}
        />
      )}
      {mediaError && (
        <ErrorState
          error={mediaError}
          title="作品播放失败"
          onRetry={() => request && open(request.input)}
        />
      )}
      {info && (
        <div className="flex flex-col gap-3">
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
        </div>
      )}
    </section>
  );
}
