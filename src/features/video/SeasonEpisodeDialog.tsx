import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogCloseButton,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/shared/components/ErrorState";
import { cn } from "@/lib/utils";
import type { PgcItem } from "@/shared/types/video";
import { videoGetSeason } from "./videoApi";
import { formatVideoDuration } from "./VideoCard";
import { videoPlayPath } from "./videoRoute";

/**
 * 番剧 / 影视的分集选择。
 *
 * 列表卡片不能直接播：索引接口只给首集 `ep_id`，排行榜接口连它都不给，两种情况都要
 * 先经 `video_get_season` 拿分集表。做成对话框而不是独立路由，是因为它只承载一次
 * 「选哪一集」的决定，选完立刻进播放页 —— 一条自己的历史记录只会让返回键多走一步。
 */

export function SeasonEpisodeDialog({
  item,
  onOpenChange,
}: {
  item: PgcItem | null;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  // `season_id` 与 `ep_id` 上游都接受，优先前者：排行榜条目只有 season_id。
  const seasonQuery = useQuery({
    queryKey: ["video_season", item?.season_id ?? "", item?.ep_id ?? ""],
    enabled: item !== null,
    queryFn: () =>
      videoGetSeason({
        seasonId: item?.season_id || undefined,
        epId: item?.season_id ? undefined : (item?.ep_id ?? undefined),
      }),
    staleTime: 5 * 60_000,
  });
  const season = seasonQuery.data;

  return (
    <Dialog open={item !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="truncate">{season?.title || item?.title || "剧集"}</DialogTitle>
          {/* 简介可能很长，限高两行：这个对话框的主体是分集列表，不是简介。 */}
          <DialogDescription className="line-clamp-2">
            {season?.evaluate || "选择要播放的剧集。"}
          </DialogDescription>
        </DialogHeader>

        {seasonQuery.isPending && (
          <div className="flex flex-col gap-2" aria-hidden>
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-11 w-full rounded-lg" />
            ))}
          </div>
        )}

        {seasonQuery.isError && (
          <ErrorState
            error={seasonQuery.error}
            title="剧集列表加载失败"
            onRetry={() => void seasonQuery.refetch()}
          />
        )}

        {season && season.episodes.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            这部剧集暂时没有可播放的分集，可能受版权或地区限制。
          </p>
        )}

        {season && season.episodes.length > 0 && (
          <ul className="-mx-1 flex max-h-[min(60vh,26rem)] flex-col gap-1 overflow-y-auto px-1">
            {season.episodes.map((episode) => (
              <li key={episode.ep_id}>
                <button
                  type="button"
                  data-motion-press
                  onClick={() => {
                    onOpenChange(false);
                    navigate(
                      videoPlayPath({
                        bvid: episode.bvid,
                        cid: episode.cid,
                        epId: episode.ep_id,
                        title: episode.long_title || episode.title || season.title,
                      }),
                    );
                  }}
                  className={cn(
                    // 粗指针下命中区 44px；细指针下 40px 已足够，两档都不低于设计系统。
                    "flex w-full min-h-10 items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors focus-ring",
                    "[@media(pointer:coarse)]:min-h-11",
                    "hover:bg-muted/70",
                  )}
                >
                  <span className="w-10 shrink-0 text-center text-xs font-medium tabular-nums text-muted-foreground">
                    {episode.title || "?"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                    {episode.long_title || episode.title || season.title}
                  </span>
                  {episode.badge && (
                    <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                      {episode.badge}
                    </span>
                  )}
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground/85">
                    {formatVideoDuration(episode.duration)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <DialogCloseButton />
      </DialogContent>
    </Dialog>
  );
}
