import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { useRef, type ReactNode } from "react";
import { Flame } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn, formatOnline, normalizeImageUrl, SITE_LABELS } from "@/lib/utils";
import { MOTION_CHANGE_EVENT } from "@/shared/motion/preference";
import { prefersReducedMotion } from "@/shared/motion/tokens";
import type { SiteId } from "@/shared/types/live";
import { SiteLogo } from "../SiteLogo";

const OVERFLOW_TOLERANCE_PX = 1;
const OVERFLOW_EDGE_PAUSE_SECONDS = 1.2;
const OVERFLOW_PIXELS_PER_SECOND = 28;

export function roomIdentityOverflowDistance(contentWidth: number, viewportWidth: number): number {
  if (!Number.isFinite(contentWidth) || !Number.isFinite(viewportWidth)) return 0;
  const overflow = contentWidth - viewportWidth;
  return overflow > OVERFLOW_TOLERANCE_PX ? Math.ceil(overflow) : 0;
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

/** One unbroken HUD identity line that pans only when fixed controls leave too little room. */
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

  useGSAP(
    () => {
      const viewport = viewportRef.current;
      const track = trackRef.current;
      if (!viewport || !track) return;

      let resizeFrame: number | null = null;
      let tween: gsap.core.Tween | null = null;
      const measure = () => {
        resizeFrame = null;
        tween?.kill();
        tween = null;
        gsap.set(track, { x: 0 });

        const distance = roomIdentityOverflowDistance(track.scrollWidth, viewport.clientWidth);
        viewport.dataset.overflowing = distance > 0 ? "true" : "false";
        if (distance === 0 || prefersReducedMotion()) {
          gsap.set(track, { clearProps: "transform,willChange" });
          return;
        }

        tween = gsap.to(track, {
          x: -distance,
          delay: OVERFLOW_EDGE_PAUSE_SECONDS,
          duration: Math.min(16, Math.max(2.4, distance / OVERFLOW_PIXELS_PER_SECOND)),
          ease: "none",
          repeat: -1,
          repeatDelay: OVERFLOW_EDGE_PAUSE_SECONDS,
          yoyo: true,
          overwrite: "auto",
          willChange: "transform",
        });
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
      window.addEventListener(MOTION_CHANGE_EVENT, scheduleMeasure);

      return () => {
        if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
        observer?.disconnect();
        if (!observer) window.removeEventListener("resize", scheduleMeasure);
        window.removeEventListener(MOTION_CHANGE_EVENT, scheduleMeasure);
        tween?.kill();
      };
    },
    {
      dependencies: [
        avatarUrl,
        compact,
        density,
        displayTitle,
        displayUserName,
        onlineLabel,
        siteId,
        trimmedRoomId,
      ],
      scope: viewportRef,
      revertOnUpdate: true,
    },
  );

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
