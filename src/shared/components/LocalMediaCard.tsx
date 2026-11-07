import { useState, type ComponentProps, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { CARD_SURFACE_CLASS, CARD_SURFACE_HOVER_CLASS } from "./cardSurface";

// 与直播、VOD 历史卡共用 16:9 缩略图尺寸：窄容器 5rem，宽容器 6rem。
// 封面右侧依次显示标题、作者与底部信息，最右侧仅放居中的删除按钮。
const LOCAL_MEDIA_CARD_LAYOUT_CLASS =
  "pointer-events-none relative z-10 grid min-w-0 grid-cols-[5rem_minmax(0,1fr)_auto] items-center gap-3 p-3 @min-[36rem]/local-media-card:grid-cols-[6rem_minmax(0,1fr)_auto]";
const LOCAL_MEDIA_COVER_PLACEMENT_CLASS = "col-start-1 row-start-1 aspect-video rounded-xl";
const LOCAL_MEDIA_HEADER_CLASS = "flex min-w-0 flex-col items-stretch gap-1 px-0";
const LOCAL_MEDIA_DETAILS_CLASS =
  "col-start-2 row-start-1 flex min-w-0 flex-col gap-2 self-stretch";
const LOCAL_MEDIA_INFO_CLASS = "mt-auto flex min-w-0 flex-col gap-1.5 px-0";
const LOCAL_MEDIA_CARD_ACTIONS_CLASS =
  "pointer-events-auto col-start-3 row-start-1 flex items-center justify-self-end self-center";

/** 本地媒体库只共享展示层；任务状态和文件操作仍由各业务页负责。 */
export function LocalMediaCard({
  kind,
  title,
  subtitle,
  status,
  artwork,
  duration,
  metadata,
  progress,
  actions,
  playbackTrigger,
}: {
  kind: "recording" | "download";
  title: string;
  subtitle: ReactNode;
  status: ReactNode;
  artwork: ReactNode;
  duration?: string;
  metadata: ReactNode;
  progress?: ReactNode;
  actions: ReactNode;
  playbackTrigger?: ReactNode;
}) {
  return (
    <Card
      data-local-media-card={kind}
      className={cn(
        "@container/local-media-card relative min-w-0 gap-0 py-0 transition-[background-color,box-shadow,opacity] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
        CARD_SURFACE_CLASS,
        CARD_SURFACE_HOVER_CLASS,
        playbackTrigger && "motion-card",
      )}
    >
      {playbackTrigger}
      <div className={LOCAL_MEDIA_CARD_LAYOUT_CLASS}>
        <div
          className={cn(
            "relative overflow-hidden bg-muted ring-1 ring-border-subtle",
            LOCAL_MEDIA_COVER_PLACEMENT_CLASS,
          )}
        >
          {artwork}
          {duration && (
            <span className="absolute right-1.5 bottom-1.5 rounded-md bg-black/75 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white">
              {duration}
            </span>
          )}
        </div>
        <div data-local-media-details className={LOCAL_MEDIA_DETAILS_CLASS}>
          <CardHeader className={LOCAL_MEDIA_HEADER_CLASS}>
            <CardTitle className="line-clamp-2 min-w-0" title={title}>
              <h3 className="text-[13px] leading-snug">{title}</h3>
            </CardTitle>
            <CardDescription
              className="min-w-0"
              title={typeof subtitle === "string" ? subtitle : undefined}
            >
              <span className="block truncate text-[11px]">{subtitle}</span>
            </CardDescription>
          </CardHeader>
          <CardContent data-local-media-info className={LOCAL_MEDIA_INFO_CLASS}>
            {progress}
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
              {metadata}
              <div data-local-media-status className="shrink-0">
                {status}
              </div>
            </div>
          </CardContent>
        </div>
        <div
          data-local-media-actions
          className={LOCAL_MEDIA_CARD_ACTIONS_CLASS}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {actions}
        </div>
      </div>
    </Card>
  );
}

export function LocalMediaArtwork({
  sources,
  icon: Icon,
}: {
  sources: readonly (string | null | undefined)[];
  icon: LucideIcon;
}) {
  const [failed, setFailed] = useState<string[]>([]);
  const artwork = sources.find(
    (source): source is string =>
      typeof source === "string" && source.length > 0 && !failed.includes(source),
  );
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-muted text-muted-foreground">
      <Icon className="size-7" aria-hidden />
      {artwork && (
        <img
          key={artwork}
          src={artwork}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed((current) => [...current, artwork])}
          className="absolute inset-0 size-full object-cover"
        />
      )}
    </div>
  );
}

export function LocalMediaCardStat({
  icon: Icon,
  children,
  label,
}: {
  icon: LucideIcon;
  children: ReactNode;
  label?: string;
}) {
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground"
      title={label}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{children}</span>
    </span>
  );
}

export function LocalMediaCardProgress({
  value,
  label,
  description,
}: {
  value: number;
  label: string;
  description?: string;
}) {
  const percent = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  return (
    <div className="flex min-w-0 items-center gap-2" data-local-media-progress>
      <div
        className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        aria-label={label}
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300 motion-reduced:transition-none"
          style={{ width: `${percent}%` }}
        />
      </div>
      {description && (
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {description}
        </span>
      )}
    </div>
  );
}

export function LocalMediaCardAction({
  label,
  icon: Icon,
  onClick,
  busy = false,
  disabled = false,
  variant = "ghost",
}: {
  label: string;
  icon: LucideIcon;
  onClick?: () => void;
  busy?: boolean;
  disabled?: boolean;
  variant?: ComponentProps<typeof Button>["variant"];
}) {
  const content = busy ? (
    <Spinner data-icon="inline-start" aria-hidden />
  ) : (
    <Icon data-icon="inline-start" aria-hidden />
  );
  const button = (
    <Button
      type="button"
      variant={variant}
      size="icon"
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.();
      }}
    >
      {content}
    </Button>
  );
  return (
    <Tooltip>
      <TooltipTrigger render={button}>{content}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function LocalMediaCardSkeleton() {
  return (
    <Card aria-hidden className={cn("@container/local-media-card gap-0 py-0", CARD_SURFACE_CLASS)}>
      <div className={LOCAL_MEDIA_CARD_LAYOUT_CLASS}>
        <Skeleton className={LOCAL_MEDIA_COVER_PLACEMENT_CLASS} />
        <div className={LOCAL_MEDIA_DETAILS_CLASS}>
          <div className={LOCAL_MEDIA_HEADER_CLASS}>
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
          <div className={LOCAL_MEDIA_INFO_CLASS}>
            <Skeleton className="h-1.5 w-full" />
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-5 w-12" />
            </div>
          </div>
        </div>
        <div className={LOCAL_MEDIA_CARD_ACTIONS_CLASS}>
          <Skeleton className="size-8 [@media(pointer:coarse)]:size-11" />
        </div>
      </div>
    </Card>
  );
}
