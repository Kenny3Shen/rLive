import { BookOpenText, Eye, MessageSquareText, Play } from "lucide-react";
import { Link } from "react-router-dom";
import { CARD_GRID_CLASS } from "@/shared/components/cardGrid";
import {
  MEDIA_CARD_CLASS,
  MediaCardCover,
  MediaCardMetrics,
  MediaCardSkeletonGrid,
  MediaCardText,
} from "@/shared/components/MediaCard";
import { formatOnline } from "@/lib/utils";
import { formatRelativeTime, formatVideoDuration } from "@/features/video/videoHistory";
import { acfunArticlePath, acfunVideoPath } from "./acfunRoute";
import type { AcfunArticleItem, AcfunVideoItem } from "./acfunTypes";

function relativeDateText(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  return formatRelativeTime(timestamp < 10_000_000_000 ? timestamp : Math.floor(timestamp / 1000));
}

export function AcfunVideoCard({ item }: { item: AcfunVideoItem }) {
  return (
    <Link to={acfunVideoPath(item.id)} data-motion-press className={MEDIA_CARD_CLASS}>
      <MediaCardCover
        cover={item.cover}
        overlay={
          <MediaCardMetrics
            stats={
              <>
                <span className="inline-flex min-w-0 items-center gap-0.5">
                  <Play className="size-3 shrink-0" aria-hidden />
                  <span className="min-w-0 truncate">{formatOnline(item.play_count)}</span>
                </span>
                <span className="inline-flex min-w-0 items-center gap-0.5">
                  <MessageSquareText className="size-3 shrink-0" aria-hidden />
                  <span className="min-w-0 truncate">{formatOnline(item.danmaku_count)}</span>
                </span>
              </>
            }
            duration={formatVideoDuration(item.duration_sec)}
          />
        }
      />
      <MediaCardText
        title={item.title}
        author={item.author}
        date={relativeDateText(item.published_at)}
      />
    </Link>
  );
}

export function AcfunArticleCard({ item }: { item: AcfunArticleItem }) {
  return (
    <Link to={acfunArticlePath(item.id)} data-motion-press className={MEDIA_CARD_CLASS}>
      <MediaCardCover
        cover={item.cover ?? ""}
        overlay={
          <MediaCardMetrics
            stats={
              <span className="inline-flex min-w-0 items-center gap-0.5">
                <Eye className="size-3 shrink-0" aria-hidden />
                <span className="min-w-0 truncate">{formatOnline(item.view_count)}</span>
              </span>
            }
          />
        }
      />
      <MediaCardText
        title={item.title}
        author={item.author}
        date={relativeDateText(item.published_at)}
      />
    </Link>
  );
}

export function AcfunCardGrid({
  kind,
  items,
}: {
  kind: "video" | "article";
  items: readonly (AcfunVideoItem | AcfunArticleItem)[];
}) {
  if (kind === "video") {
    return (
      <div className={CARD_GRID_CLASS}>
        {(items as readonly AcfunVideoItem[]).map((item) => (
          <AcfunVideoCard key={item.id} item={item} />
        ))}
      </div>
    );
  }
  return (
    <div className={CARD_GRID_CLASS}>
      {(items as readonly AcfunArticleItem[]).map((item) => (
        <AcfunArticleCard key={item.id} item={item} />
      ))}
    </div>
  );
}

export function AcfunGridSkeleton() {
  return <MediaCardSkeletonGrid />;
}

export function AcfunEmptyVisual({ kind }: { kind: "video" | "article" }) {
  const Icon = kind === "video" ? Play : BookOpenText;
  return <Icon aria-hidden />;
}
