import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Flame } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn, formatOnline, normalizeImageUrl, SITE_LABELS } from "@/lib/utils";
import { prefersReducedMotion } from "@/shared/motion/tokens";
import type { SiteId } from "@/shared/types/live";
import { SiteLogo } from "../SiteLogo";

const OVERFLOW_TOLERANCE_PX = 1;
const OVERFLOW_EDGE_PAUSE_SECONDS = 1.2;
const OVERFLOW_PIXELS_PER_SECOND = 28;
const MARQUEE_MIN_TRAVEL_SECONDS = 2.4;
const MARQUEE_MAX_TRAVEL_SECONDS = 16;

export function roomIdentityOverflowDistance(contentWidth: number, viewportWidth: number): number {
  if (!Number.isFinite(contentWidth) || !Number.isFinite(viewportWidth)) return 0;
  const overflow = contentWidth - viewportWidth;
  return overflow > OVERFLOW_TOLERANCE_PX ? Math.ceil(overflow) : 0;
}

/**
 * 溢出行平移的一个完整往返周期，供 Web Animations 无限循环播放。
 *
 * 两条端点停顿（往返各一次）编码进关键帧本身：起始停顿承担 GSAP 时代的
 * `delay`，往返之间的停顿对应 `repeatDelay`。因此一个周期 =
 * 2 ×（单程 + 停顿），单程时长按像素速度推导并锥制，曲线全程线性（匀速）。
 */
export function roomIdentityMarqueeCycle(distance: number): {
  cycleMs: number;
  keyframes: Keyframe[];
} {
  const travelMs =
    Math.min(
      MARQUEE_MAX_TRAVEL_SECONDS,
      Math.max(MARQUEE_MIN_TRAVEL_SECONDS, distance / OVERFLOW_PIXELS_PER_SECOND),
    ) * 1000;
  const pauseMs = OVERFLOW_EDGE_PAUSE_SECONDS * 1000;
  const cycleMs = 2 * (travelMs + pauseMs);
  const shift = `translate3d(${-distance}px, 0, 0)`;
  const rest = "translate3d(0, 0, 0)";
  return {
    cycleMs,
    keyframes: [
      { transform: rest, offset: 0 },
      { transform: rest, offset: pauseMs / cycleMs },
      { transform: shift, offset: (pauseMs + travelMs) / cycleMs },
      { transform: shift, offset: (2 * pauseMs + travelMs) / cycleMs },
      { transform: rest, offset: 1 },
    ],
  };
}

type RoomIdentityLineProps = {
  siteId?: SiteId;
  roomId?: string;
  title?: string;
  userName?: string;
  userAvatar?: string;
  online?: number;
  density?: "fullscreen" | "tile";
  compact?: boolean;
  className?: string;
};

/** 一条不间断的 HUD 身份行，仅在固定控件空间不足时平移。 */
export function RoomIdentityLine({
  siteId,
  roomId,
  title,
  userName,
  userAvatar,
  online,
  density = "fullscreen",
  compact = false,
  className,
}: RoomIdentityLineProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const displayTitle = title?.trim() || "直播间";
  const displayUserName = userName?.trim() || "未知主播";
  const trimmedRoomId = roomId?.trim() || "";
  const platformName = siteId ? (SITE_LABELS[siteId] ?? siteId) : "";
  const avatarUrl = normalizeImageUrl(userAvatar);
  const onlineLabel =
    online !== undefined && Number.isFinite(online) && online >= 0 ? formatOnline(online) : null;
  const tile = density === "tile";

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (!viewport || !track) return;

    let resizeFrame: number | null = null;
    let marquee: Animation | null = null;
    const stopMarquee = () => {
      marquee?.cancel();
      marquee = null;
    };
    const measure = () => {
      resizeFrame = null;
      stopMarquee();
      track.style.transform = "";

      const distance = roomIdentityOverflowDistance(track.scrollWidth, viewport.clientWidth);
      viewport.dataset.overflowing = distance > 0 ? "true" : "false";
      if (distance === 0 || prefersReducedMotion()) {
        track.style.willChange = "";
        return;
      }

      track.style.willChange = "transform";
      const { cycleMs, keyframes } = roomIdentityMarqueeCycle(distance);
      marquee = track.animate(keyframes, { duration: cycleMs, iterations: Infinity });
    };

    const scheduleMeasure = () => {
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(measure);
    };

    scheduleMeasure();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMeasure);
    observer?.observe(viewport);
    observer?.observe(track);
    if (!observer) window.addEventListener("resize", scheduleMeasure);

    return () => {
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      observer?.disconnect();
      if (!observer) window.removeEventListener("resize", scheduleMeasure);
      stopMarquee();
      track.style.transform = "";
      track.style.willChange = "";
    };
  }, [
    avatarUrl,
    compact,
    density,
    displayTitle,
    displayUserName,
    onlineLabel,
    siteId,
    trimmedRoomId,
  ]);

  const avatarLabel = `${displayUserName} 的头像`;

  return (
    <div
      ref={viewportRef}
      data-room-identity-line
      data-overflowing="false"
      className={cn("min-w-0 overflow-hidden", className)}
    >
      <div
        ref={trackRef}
        className={cn(
          "flex w-max items-center whitespace-nowrap text-white/80",
          tile ? "gap-1.5" : "gap-2",
        )}
      >
        <strong
          className={cn(
            "shrink-0 font-semibold text-white [text-shadow:0_1px_3px_rgb(0_0_0_/_0.75)]",
            tile ? "text-xs" : compact ? "text-sm" : "text-base",
          )}
          title={displayTitle}
        >
          {displayTitle}
        </strong>

        <Avatar
          size="sm"
          className={cn("shrink-0 ring-1 ring-white/25", tile || compact ? "size-5" : "size-6")}
          aria-label={avatarLabel}
        >
          <AvatarImage src={avatarUrl} alt={avatarLabel} referrerPolicy="no-referrer" />
          <AvatarFallback
            aria-label={`${avatarLabel}（加载失败）`}
            className="bg-white/18 text-[0.625rem] font-medium text-white"
          >
            {Array.from(displayUserName)[0] ?? "?"}
          </AvatarFallback>
        </Avatar>

        <span
          className={cn(
            "shrink-0 font-medium [text-shadow:0_1px_2px_rgb(0_0_0_/_0.7)]",
            tile ? "text-[0.6875rem]" : compact ? "text-xs" : "text-sm",
          )}
          title={displayUserName}
        >
          {displayUserName}
        </span>

        {siteId && trimmedRoomId && (
          <MetaItem
            tile={tile}
            compact={compact}
            title={`${platformName}房间号：${trimmedRoomId}`}
            icon={<SiteLogo siteId={siteId} className={tile || compact ? "size-3" : "size-3.5"} />}
          >
            {trimmedRoomId}
          </MetaItem>
        )}

        {onlineLabel && (
          <MetaItem
            tile={tile}
            compact={compact}
            title={`当前热度：${onlineLabel}`}
            icon={
              <Flame
                aria-hidden
                className={cn("text-accent", tile || compact ? "size-3" : "size-3.5")}
              />
            }
          >
            <span className="sr-only">当前热度 </span>
            {onlineLabel}
          </MetaItem>
        )}
      </div>
    </div>
  );
}

function MetaItem({
  tile,
  compact,
  title,
  icon,
  children,
}: {
  tile: boolean;
  compact: boolean;
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1 border-l border-white/20 tabular-nums [text-shadow:0_1px_2px_rgb(0_0_0_/_0.7)]",
        tile ? "pl-1.5 text-[0.625rem]" : compact ? "pl-2 text-[0.6875rem]" : "pl-2 text-xs",
      )}
      title={title}
    >
      {icon}
      {children}
    </span>
  );
}
