import type { ReactNode, RefObject } from "react";
import { CalendarDays } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
import { CARD_GRID_CLASS } from "@/shared/components/cardGrid";
import { CARD_SURFACE_CLASS, CARD_SURFACE_HOVER_CLASS } from "@/shared/components/cardSurface";
import { cn, normalizeVideoCoverUrl } from "@/lib/utils";

export const MEDIA_CARD_CLASS = cn(
  "group flex w-full min-w-0 flex-col overflow-hidden rounded-xl text-left",
  CARD_SURFACE_CLASS,
  CARD_SURFACE_HOVER_CLASS,
);

export const MEDIA_CARD_COVER_METRIC_CLASS =
  "inline-flex items-center gap-1.5 text-[11px] font-medium text-white tabular-nums text-shadow-cover";

export const MEDIA_CARD_BADGE_CLASS =
  "absolute inline-flex items-center gap-0.5 rounded-md bg-black/65 px-1.5 py-0.5 text-[11px] font-medium text-white backdrop-blur-sm";

const COVER_IMAGE_CLASS =
  "absolute inset-0 h-full w-full object-cover transition-transform duration-200 ease-[var(--motion-ease-out)] motion-reduced:transition-none";

export function MediaCardCover({
  cover,
  overlay,
  previewMount,
  previewLoading,
  className,
}: {
  cover: string;
  overlay?: ReactNode;
  previewMount?: RefObject<HTMLDivElement | null>;
  previewLoading?: boolean;
  className?: string;
}) {
  const normalized = normalizeVideoCoverUrl(cover);
  return (
    <div
      data-slot="media-card-cover"
      className={cn("relative aspect-video w-full overflow-hidden bg-muted", className)}
    >
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

export function MediaCardMetrics({ stats, duration }: { stats?: ReactNode; duration?: ReactNode }) {
  if (!stats && !duration) return null;
  return (
    <div className="absolute inset-x-2 bottom-2 flex items-center justify-between gap-2">
      {stats ? (
        <span className={cn(MEDIA_CARD_COVER_METRIC_CLASS, "min-w-0 gap-2")}>{stats}</span>
      ) : (
        <span />
      )}
      {duration ? (
        <span className={cn(MEDIA_CARD_COVER_METRIC_CLASS, "shrink-0")}>{duration}</span>
      ) : null}
    </div>
  );
}

export function MediaCardText({
  title,
  author,
  date,
  className,
  children,
}: {
  title: string;
  author?: string | null;
  date?: string | null;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={cn("flex min-w-0 flex-1 flex-col gap-0.5", className ?? "px-2 pt-2 pb-2.5")}>
      <p className="line-clamp-2 min-h-[2lh] text-[13px] font-medium leading-snug text-foreground">
        {title}
      </p>
      <p className="flex min-h-4 min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground/85">
        {date && (
          <>
            <span className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap">
              <CalendarDays className="size-3" aria-hidden />
              {date}
            </span>
            {author && (
              <span aria-hidden className="shrink-0 text-border">
                |
              </span>
            )}
          </>
        )}
        {author && <span className="min-w-0 truncate">{author}</span>}
      </p>
      {children}
    </div>
  );
}

export function MediaCardSkeletonGrid({ count = 12 }: { count?: number }) {
  return (
    <div className={CARD_GRID_CLASS} aria-hidden>
      {Array.from({ length: count }, (_, index) => (
        <div
          key={index}
          className={cn("flex flex-col overflow-hidden rounded-xl", CARD_SURFACE_CLASS)}
        >
          <Skeleton className="aspect-video w-full rounded-none" />
          <div className="flex flex-col gap-0.5 px-2 pt-2 pb-2.5">
            <Skeleton className="h-[2lh] w-4/5 text-[13px] leading-snug" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}
