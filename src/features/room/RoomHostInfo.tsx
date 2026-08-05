import { Flame, Heart } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SiteLogo } from "@/shared/components/SiteLogo";
import type { LiveRoomDetail } from "@/shared/types/live";
import { cn, formatOnline, normalizeImageUrl, SITE_LABELS } from "@/lib/utils";

type RoomHostInfoProps = {
  detail: LiveRoomDetail;
  isFollowed?: boolean;
  followBusy?: boolean;
  onToggleFollow?: () => void;
};

/** Compact, always-visible identity for the room host above the side tabs. */
export function RoomHostInfo({
  detail,
  isFollowed = false,
  followBusy = false,
  onToggleFollow,
}: RoomHostInfoProps) {
  const userName = detail.user_name.trim() || "未知主播";
  const platformName = SITE_LABELS[detail.site_id] ?? detail.site_id;
  const roomId = detail.room_id.trim() || "未知房间";
  const onlineLabel =
    Number.isFinite(detail.online) && detail.online >= 0 ? formatOnline(detail.online) : "—";
  const avatarLabel = `${userName} 的头像`;

  return (
    <section
      data-slot="room-host-info"
      className="shrink-0 border-b border-border px-2.5 py-2"
      aria-label={`主播信息：${userName}，${platformName}房间 ${roomId}，当前热度 ${onlineLabel}`}
    >
      <div className="overflow-hidden rounded-xl border border-border-subtle bg-card/75 px-2.5 py-2 shadow-sm">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="shrink-0">
            <Avatar size="lg" className="size-11 ring-1 ring-border/80" aria-label={avatarLabel}>
              <AvatarImage
                src={normalizeImageUrl(detail.user_avatar)}
                alt={avatarLabel}
                referrerPolicy="no-referrer"
              />
              <AvatarFallback aria-label={`${avatarLabel}（加载失败）`} className="font-medium">
                {Array.from(userName)[0] ?? "?"}
              </AvatarFallback>
            </Avatar>
          </div>

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold leading-5 tracking-tight" title={userName}>
              {userName}
            </p>
            <dl className="mt-1.5 flex min-w-0 items-center text-xs leading-4">
              <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                <dt className="sr-only">房间号</dt>
                <dd
                  className="flex min-w-0 items-center gap-1.5"
                  title={`${platformName}房间号：${roomId}`}
                >
                  <SiteLogo siteId={detail.site_id} className="size-3.5" />
                  <span className="truncate tabular-nums">{roomId}</span>
                </dd>
              </div>
              <div
                className="ml-2.5 flex shrink-0 items-center gap-1 border-l border-border-subtle pl-2.5 text-foreground"
                title={`当前热度：${onlineLabel}`}
              >
                <dt className="sr-only">当前热度</dt>
                <Flame aria-hidden="true" className="size-3.5 text-accent" />
                <dd className="font-semibold tabular-nums">{onlineLabel}</dd>
              </div>
            </dl>
          </div>

          {onToggleFollow && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant={isFollowed ? "secondary" : "ghost"}
                    size="icon-sm"
                    className={cn(
                      "ml-1 self-center",
                      isFollowed && "text-primary hover:text-primary",
                    )}
                    disabled={followBusy}
                    onClick={onToggleFollow}
                    aria-label={isFollowed ? "取消关注" : "关注"}
                    aria-pressed={isFollowed}
                  >
                    <Heart className={cn(isFollowed && "fill-current")} />
                  </Button>
                }
              />
              <TooltipContent>{isFollowed ? "取消关注" : "关注"}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </section>
  );
}
