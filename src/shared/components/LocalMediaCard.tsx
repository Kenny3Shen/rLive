import { useState, type ComponentProps, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { CARD_SURFACE_CLASS, CARD_SURFACE_HOVER_CLASS } from "./cardSurface";

// 窄容器把封面压到 5rem：标题独占完整正文列，状态与作者同一行；画质、大小、进度
// 另起一行横跨封面+正文两列，不再堆在封面对面的窄列里。宽容器用 grid 定位恢复
// 「标题+状态并排 / 作者次行」与原有封面尺寸。
const LOCAL_MEDIA_CARD_LAYOUT_CLASS =
  "pointer-events-none relative z-10 grid min-w-0 grid-cols-[5rem_minmax(0,1fr)_auto] items-start gap-3 p-3 @min-[36rem]/local-media-card:grid-cols-[11rem_minmax(0,1fr)_auto] @min-[36rem]/local-media-card:gap-4 @min-[36rem]/local-media-card:p-4";
const LOCAL_MEDIA_COVER_PLACEMENT_CLASS =
  "col-start-1 row-start-1 aspect-video rounded-lg @min-[36rem]/local-media-card:row-span-2";
const LOCAL_MEDIA_HEADER_CLASS =
  "col-start-2 row-start-1 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 gap-y-1 px-0";
const LOCAL_MEDIA_META_CLASS =
  "col-span-2 col-start-1 row-start-2 flex min-w-0 flex-col gap-2 px-0 @min-[36rem]/local-media-card:col-span-1 @min-[36rem]/local-media-card:col-start-2";
const LOCAL_MEDIA_CARD_ACTIONS_CLASS =
  "pointer-events-auto col-start-3 row-span-2 row-start-1 flex flex-col items-end gap-1 @min-[36rem]/local-media-card:flex-row @min-[36rem]/local-media-card:items-start";

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
            <span className="absolute right-1.5 bottom-1.5 rounded-md bg-black/75 px-1.5 py-0.5 text-sm font-medium tabular-nums text-white">
              {duration}
            </span>
          )}
        </div>
        <CardHeader className={LOCAL_MEDIA_HEADER_CLASS}>
          {/* 窄屏标题独占整列、状态与作者同行；宽屏标题+状态并排、作者次行。
              grid 只靠容器响应改变标题跨列与状态所在行，状态节点始终只有一份。
              字号挂在原生 h3 上做容器响应，避免覆盖 Card 基础组件的字体规则。 */}
          <CardTitle
            className="col-span-2 col-start-1 row-start-1 line-clamp-2 min-w-0 @min-[36rem]/local-media-card:col-span-1"
            title={title}
          >
            <h3 className="text-sm leading-snug @min-[36rem]/local-media-card:text-base">
              {title}
            </h3>
          </CardTitle>
          <div className="col-start-2 row-start-2 shrink-0 justify-self-end @min-[36rem]/local-media-card:row-start-1">
            {status}
          </div>
          <CardDescription
            className="col-start-1 row-start-2 min-w-0 truncate @min-[36rem]/local-media-card:col-span-2"
            title={typeof subtitle === "string" ? subtitle : undefined}
          >
            {subtitle}
          </CardDescription>
        </CardHeader>
        <CardContent className={LOCAL_MEDIA_META_CLASS}>
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5">{metadata}</div>
          {progress}
        </CardContent>
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

export function LocalMediaCardSkeleton({ actionCount = 2 }: { actionCount?: number }) {
  return (
    <Card aria-hidden className={cn("@container/local-media-card gap-0 py-0", CARD_SURFACE_CLASS)}>
      <div className={LOCAL_MEDIA_CARD_LAYOUT_CLASS}>
        <Skeleton className={LOCAL_MEDIA_COVER_PLACEMENT_CLASS} />
        <div className={LOCAL_MEDIA_HEADER_CLASS}>
          {/* 窄屏标题独占整列，状态与作者同行；宽屏标题+状态并排、作者次行。 */}
          <Skeleton className="col-span-2 col-start-1 row-start-1 h-4 @min-[36rem]/local-media-card:col-span-1" />
          <Skeleton className="col-start-2 row-start-2 h-5 w-12 shrink-0 justify-self-end @min-[36rem]/local-media-card:row-start-1" />
          <Skeleton className="col-start-1 row-start-2 h-4 w-1/2" />
        </div>
        <div className={LOCAL_MEDIA_META_CLASS}>
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-24" />
          </div>
          <Skeleton className="h-1.5 w-full" />
        </div>
        {/* 按真实条目的操作数量占位：下载窄屏两枚、录制宽屏三枚，
            不再用固定三枚纵向按钮把窄屏卡片撑到约 140px。 */}
        <div className={LOCAL_MEDIA_CARD_ACTIONS_CLASS}>
          {Array.from({ length: actionCount }).map((_, index) => (
            <Skeleton key={index} className="size-8 [@media(pointer:coarse)]:size-11" />
          ))}
        </div>
      </div>
    </Card>
  );
}
