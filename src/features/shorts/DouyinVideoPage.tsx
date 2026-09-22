import { useId, useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ArrowLeft, ArrowRight, Play, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { ErrorState } from "@/shared/components/ErrorState";
import { DouyinVideoPlayer } from "./DouyinVideoPlayer";
import { douyinVideoFeed } from "./douyinVideoApi";
import { DOUYIN_FEED_MAX_BATCHES, mergeDouyinFeed, nextDouyinFeedBatch } from "./douyinFeed";

/** 默认关闭、仅本次进入生效的灰度入口；不新增账号存储或平行播放器。 */
export function DouyinVideoPage() {
  const [input, setInput] = useState("");
  const [request, setRequest] = useState<{ input: string; revision: number } | null>(null);
  const [feedEnabled, setFeedEnabled] = useState(false);
  const [feedRevision, setFeedRevision] = useState(0);
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
      <FieldGroup>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="douyin-cookie-feed">Cookie 推荐流（灰度）</FieldLabel>
            <FieldDescription id="douyin-feed-help">
              默认关闭，仅本次进入生效。开启后使用本机保存的抖音登录 Cookie
              请求推荐；不保证个性化效果，不绕过访问验证。关闭可恢复单作品播放。
            </FieldDescription>
          </FieldContent>
          <Switch
            id="douyin-cookie-feed"
            checked={feedEnabled}
            aria-describedby="douyin-feed-help"
            onCheckedChange={(enabled) => {
              setRequest(null);
              setFeedEnabled(enabled);
            }}
          />
        </Field>
      </FieldGroup>
      <Link
        to="/settings?section=account"
        className={buttonVariants({ variant: "link", size: "sm", className: "self-start" })}
      >
        前往设置管理抖音账号
      </Link>
      {feedEnabled ? (
        <DouyinRecommendation
          key={feedRevision}
          onRefresh={() => setFeedRevision((value) => value + 1)}
        />
      ) : (
        <>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const trimmed = input.trim();
              if (trimmed)
                setRequest((previous) => ({
                  input: trimmed,
                  revision: (previous?.revision ?? 0) + 1,
                }));
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
                  支持公开视频作品，不支持图集和直播。访问验证或作品不可见时无法播放；暂不提供评论、点赞与观看历史。
                </FieldDescription>
              </Field>
              <Field orientation="horizontal">
                <Button type="submit" disabled={!input.trim()}>
                  <Play data-icon="inline-start" />
                  打开作品
                </Button>
              </Field>
            </FieldGroup>
          </form>
          {request && <DouyinVideoPlayer key={request.revision} input={request.input} />}
        </>
      )}
    </section>
  );
}

function DouyinRecommendation({ onRefresh }: { onRefresh: () => void }) {
  const ownerId = useId();
  const [index, setIndex] = useState(0);
  const query = useInfiniteQuery({
    queryKey: ["douyin_video_feed", "douyin", ownerId],
    initialPageParam: 1,
    queryFn: async ({ signal }) => {
      const page = await douyinVideoFeed();
      // invoke 不可撤回，但关闭/刷新后的迟到元数据不可重新发布到查询。
      signal.throwIfAborted();
      return page;
    },
    getNextPageParam: nextDouyinFeedBatch,
    retry: false,
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const items = useMemo(() => mergeDouyinFeed(query.data?.pages ?? []), [query.data]);
  const current = items[index];
  return (
    <div className="flex flex-col gap-4" data-slot="douyin-recommendation">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-medium">登录 Cookie 推荐</h2>
        <Button variant="outline" size="sm" onClick={onRefresh}>
          <RefreshCw data-icon="inline-start" />
          刷新推荐
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        推荐包含横竖屏视频；只请求一批，后续由你手动加载。图集、广告和不支持的媒体会跳过。
      </p>
      {query.isFetching && (
        <p role="status" className="flex items-center gap-2 text-sm">
          <Spinner />
          正在加载推荐
        </p>
      )}
      {query.isError && (
        <ErrorState
          error={query.error}
          title="推荐加载失败"
          onRetry={
            query.isFetchNextPageError
              ? () => {
                  void query.fetchNextPage({ cancelRefetch: false });
                }
              : onRefresh
          }
        />
      )}
      {current && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              disabled={index === 0}
              onClick={() => setIndex((value) => value - 1)}
            >
              <ArrowLeft data-icon="inline-start" />
              上一条
            </Button>
            <p role="status" className="text-sm text-muted-foreground">
              {index + 1} / {items.length} 条已加载
            </p>
            <Button
              variant="outline"
              disabled={index >= items.length - 1}
              onClick={() => setIndex((value) => value + 1)}
            >
              下一条
              <ArrowRight data-icon="inline-end" />
            </Button>
          </div>
          <DouyinVideoPlayer key={current.id} input={current.id} requireLogin />
        </>
      )}
      {query.isSuccess && !items.length && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>暂无可播放推荐</EmptyTitle>
            <EmptyDescription>
              本批没有支持的公开视频，可能只有图集或受限作品。可稍后刷新，或关闭推荐流使用作品链接。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {query.hasNextPage ? (
        <Button
          variant="outline"
          disabled={query.isFetching}
          onClick={() => {
            void query.fetchNextPage({ cancelRefetch: false });
          }}
        >
          加载更多推荐
        </Button>
      ) : (
        query.data &&
        items.length > 0 && (
          <p role="status" className="text-sm text-muted-foreground">
            {query.data.pages.length >= DOUYIN_FEED_MAX_BATCHES
              ? "已达到本轮 20 批上限，请刷新开始新一轮。"
              : "本轮暂无更多新作品（上游结束或重复批次），可稍后刷新。"}
          </p>
        )
      )}
    </div>
  );
}
