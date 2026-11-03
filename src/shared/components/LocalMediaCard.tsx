import { useState, type ComponentProps, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { CARD_SURFACE_CLASS, CARD_SURFACE_HOVER_CLASS } from "./cardSurface";

const LOCAL_MEDIA_CARD_LAYOUT_CLASS =
  "pointer-events-none relative z-10 grid min-w-0 grid-cols-[7rem_minmax(0,1fr)_auto] items-start gap-3 p-3 @min-[36rem]/local-media-card:grid-cols-[11rem_minmax(0,1fr)_auto] @min-[36rem]/local-media-card:gap-4 @min-[36rem]/local-media-card:p-4";
const LOCAL_MEDIA_CARD_ACTIONS_CLASS =
  "pointer-events-auto flex flex-col items-end gap-1 @min-[36rem]/local-media-card:flex-row @min-[36rem]/local-media-card:items-start";

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
        <div className="relative aspect-video overflow-hidden rounded-lg bg-muted ring-1 ring-border-subtle">
          {artwork}
          {duration && (
            <span className="absolute right-1.5 bottom-1.5 rounded-md bg-black/75 px-1.5 py-0.5 text-sm font-medium tabular-nums text-white">
              {duration}
            </span>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-2.5">
          <CardHeader className="flex min-w-0 flex-col gap-1 px-0">
            <div className="flex min-w-0 flex-col items-start gap-1.5 @min-[36rem]/local-media-card:flex-row @min-[36rem]/local-media-card:justify-between @min-[36rem]/local-media-card:gap-3">
              <CardTitle className="line-clamp-2 min-w-0" title={title}>
                <h3>{title}</h3>
              </CardTitle>
              <div className="shrink-0">{status}</div>
            </div>
            <CardDescription
              className="truncate"
              title={typeof subtitle === "string" ? subtitle : undefined}
            >
              {subtitle}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex min-w-0 flex-col gap-2 px-0">
            <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5">{metadata}</div>
            {progress}
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
      className="inline-flex min-w-0 items-center gap-1.5 text-sm tabular-nums text-muted-foreground"
      title={label}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
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
        <span className="shrink-0 text-sm tabular-nums text-muted-foreground">{description}</span>
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
        <Skeleton className="aspect-video rounded-lg" />
        <div className="flex min-w-0 flex-col gap-3">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-2/3" />
        </div>
        <div className={LOCAL_MEDIA_CARD_ACTIONS_CLASS}>
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="size-8 [@media(pointer:coarse)]:size-11" />
          ))}
        </div>
      </div>
    </Card>
  );
}
