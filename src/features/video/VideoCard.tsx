import { memo } from "react";
import type { RefObject } from "react";
import { useNavigate } from "react-router-dom";
import { MessageSquare, Play } from "lucide-react";
import { preloadRouteModule } from "@/app/routeModules";
import { Spinner } from "@/components/ui/spinner";
import { formatOnline, normalizeVideoCoverUrl, cn } from "@/lib/utils";
import type { PgcItem, VideoItem } from "@/shared/types/video";
import { useVideoCardPreview } from "./videoCardPreview";
import { videoPlayPath } from "./videoRoute";

/**
 * 视频卡片。
 *
 * 与直播的 `RoomCard` 同一套画法（同样的圆角、封面比例、渐变与角标位置），但承载的
 * 事实不同：VOD 展示时长、播放量、弹幕数与 UP 主，直播展示热度与开播状态。因此是
 * 一个并列的组件而不是给 `RoomCard` 加分支 —— 那个组件还挂着关注、多画面、长按抽屉
 * 等一整套直播专属动作，VOD 一个都用不上。
 */

/** `H:MM:SS` / `M:SS`。与录制回放的时长格式一致。 */
export function formatVideoDuration(totalSeconds: number): string {
  const seconds = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  }
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

const CARD_CLASS =
  "group flex w-full flex-col overflow-hidden rounded-xl bg-transparent text-left focus-ring";
const COVER_CLASS =
  "relative aspect-video w-full overflow-hidden rounded-xl bg-muted shadow-md shadow-black/30 ring-1 ring-border-subtle";
const COVER_IMAGE_CLASS =
  "h-full w-full object-cover transition-transform duration-200 ease-[var(--motion-ease-out)] motion-reduced:transition-none";
const BADGE_CLASS =
  "absolute inline-flex items-center gap-0.5 rounded-md bg-black/65 px-1.5 py-0.5 text-[11px] font-medium text-white backdrop-blur-sm";

/**
 * 卡片封面。`overlay` 里放角标，它们自己带绝对定位，因此堆在渐变之上。
 * `previewMount` / `previewLoading` 由 UGC 卡片传入（悬停预览，见
 * `videoCardPreview.ts`）；PGC 卡片不悬停预览（要先选集才能取流），不传。
 */
function CoverImage({
  cover,
  overlay,
  previewMount,
  previewLoading,
}: {
  cover: string;
  overlay?: React.ReactNode;
  previewMount?: RefObject<HTMLDivElement | null>;
  previewLoading?: boolean;
}) {
  const normalized = normalizeVideoCoverUrl(cover);
  return (
    <div className={COVER_CLASS}>
      {normalized ? (
        <img
          src={normalized}
          alt=""
          loading="lazy"
          decoding="async"
          className={COVER_IMAGE_CLASS}
          referrerPolicy="no-referrer"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
          暂无封面
        </div>
      )}
      {/* 预览盖在封面之上、渐变与角标之下（与直播卡同序）；挂载点不接收
          指针事件，悬停与点击始终落在卡片按钮上。 */}
      {previewMount && (
        <div ref={previewMount} aria-hidden className="pointer-events-none absolute inset-0" />
      )}
      {previewLoading && (
        <span className="pointer-events-none absolute left-2 top-2 inline-flex rounded-md bg-black/65 p-1 text-white backdrop-blur-sm">
          <Spinner className="size-3" />
        </span>
      )}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/55 via-transparent to-transparent opacity-80" />
      {overlay}
    </div>
  );
}

export const VideoCard = memo(function VideoCard({ item }: { item: VideoItem }) {
  const navigate = useNavigate();
  // 列表接口通常直接给 cid；缺失的条目点进去也取不到流，因此不给它一个会失败的链接。
  const playable = typeof item.cid === "number" && item.cid > 0;
  const playPath = playable
    ? videoPlayPath({ bvid: item.bvid, cid: item.cid!, title: item.title, aid: item.aid })
    : null;
  const preview = useVideoCardPreview({ bvid: item.bvid, cid: item.cid });

  return (
    <button
      type="button"
      data-motion-press
      // 锚点带上 cid：推荐流会重复出现同一个 bvid（轮换批次），只用 bvid 的
      // 话返回时的锚点查找会命中第一张同名卡，把滚动恢复到错误位置。
      data-page-scroll-anchor={`video:${item.bvid}:${item.cid ?? ""}`}
      disabled={!playable}
      aria-label={`${item.title}，UP 主 ${item.author}，时长 ${formatVideoDuration(item.duration)}`}
      onPointerEnter={(event) => {
        if (playPath) preloadRouteModule(playPath);
        preview.onPointerEnter(event);
      }}
      onPointerLeave={preview.stop}
      onFocus={() => playPath && preloadRouteModule(playPath)}
      onClick={() => playPath && navigate(playPath)}
      className={cn(CARD_CLASS, !playable && "cursor-not-allowed opacity-60")}
    >
      <CoverImage
        cover={item.cover}
        previewMount={preview.mountRef}
        previewLoading={preview.phase === "loading"}
        overlay={
          <>
            {/* 推荐理由是平台给的运营文案（如「百万播放」），放左上与右下的时长
                分开，两者都靠边而不互相挤。 */}
            {item.rcmd_reason && (
              <span
                data-mobile-static-backdrop
                className={cn(BADGE_CLASS, "left-2 top-2 max-w-[70%] truncate")}
              >
                {item.rcmd_reason}
              </span>
            )}
            <span
              data-mobile-static-backdrop
              className={cn(BADGE_CLASS, "bottom-2 right-2 tabular-nums")}
            >
              {formatVideoDuration(item.duration)}
            </span>
          </>
        }
      />
      <div className="flex flex-1 flex-col gap-0.5 px-0.5 pt-2.5 pb-1">
        <p className="line-clamp-2 text-[13px] font-medium leading-snug text-foreground">
          {item.title}
        </p>
        {/* 副行始终占位，保证网格里两行标题与一行标题的卡片高度一致。 */}
        <p className="min-h-4 truncate text-xs text-muted-foreground">{item.author}</p>
        <p className="flex min-h-4 items-center gap-2 text-[11px] text-muted-foreground/85">
          <span className="inline-flex items-center gap-0.5">
            <Play className="size-3" aria-hidden />
            {formatOnline(item.view)}
          </span>
          <span className="inline-flex items-center gap-0.5">
            <MessageSquare className="size-3" aria-hidden />
            {formatOnline(item.danmaku)}
          </span>
        </p>
      </div>
    </button>
  );
});

/**
 * 番剧 / 影视卡片。
 *
 * 点它不能直接播：索引接口给的 `ep_id` 只是首集，而排行榜接口连 `ep_id` 都不给。
 * 两种情况都要先经 `video_get_season` 拿到分集表，因此这里只上报「被选中」，
 * 由页面负责展开剧集列表。
 */
export const PgcCard = memo(function PgcCard({
  item,
  onSelect,
}: {
  item: PgcItem;
  onSelect: (item: PgcItem) => void;
}) {
  return (
    <button
      type="button"
      data-motion-press
      data-page-scroll-anchor={`pgc:${item.season_id}`}
      aria-label={`${item.title}${item.index_show ? `，${item.index_show}` : ""}`}
      onClick={() => onSelect(item)}
      className={CARD_CLASS}
    >
      <CoverImage
        cover={item.cover}
        overlay={
          item.badge ? (
            <span data-mobile-static-backdrop className={cn(BADGE_CLASS, "left-2 top-2")}>
              {item.badge}
            </span>
          ) : null
        }
      />
      <div className="flex flex-1 flex-col gap-0.5 px-0.5 pt-2.5 pb-1">
        <p className="line-clamp-2 text-[13px] font-medium leading-snug text-foreground">
          {item.title}
        </p>
        <p className="min-h-4 truncate text-xs text-muted-foreground">{item.index_show ?? ""}</p>
      </div>
    </button>
  );
});
