import { Flame } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { SiteLogo } from "@/shared/components/SiteLogo";
import type { LiveRoomDetail } from "@/shared/types/live";
import { formatOnline, normalizeImageUrl, SITE_LABELS } from "@/lib/utils";

type RoomHostInfoProps = {
  detail: LiveRoomDetail;
};

/** Compact, always-visible identity for the room host above the side tabs. */
export function RoomHostInfo({ detail }: RoomHostInfoProps) {
  const userName = detail.user_name.trim() || "未知主播";
  const platformName = SITE_LABELS[detail.site_id] ?? detail.site_id;
  const onlineLabel = formatOnline(detail.online);
  const avatarLabel = `${userName} 的头像`;

  return (
    <section className="shrink-0 border-b border-border px-3 py-3" aria-label="主播信息">
      <div className="flex min-w-0 items-center gap-3">
        <Avatar size="lg" className="size-12" aria-label={avatarLabel}>
          <AvatarImage
            src={normalizeImageUrl(detail.user_avatar)}
            alt={avatarLabel}
            referrerPolicy="no-referrer"
          />
          <AvatarFallback aria-label={`${avatarLabel}（加载失败）`}>
            {Array.from(userName)[0] ?? "?"}
          </AvatarFallback>
        </Avatar>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold leading-5" title={userName}>
            {userName}
          </p>
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
            <Badge
              variant="outline"
              className="max-w-full"
              aria-label={`所属平台：${platformName}`}
              title={`所属平台：${platformName}`}
            >
              <span data-icon="inline-start" className="flex shrink-0">
                <SiteLogo siteId={detail.site_id} className="size-3.5" />
              </span>
              <span className="truncate">{platformName}</span>
            </Badge>
            <Badge
              variant="secondary"
              aria-label={`当前热度：${onlineLabel}`}
              title={`当前热度：${onlineLabel}`}
            >
              <Flame data-icon="inline-start" aria-hidden />
              <span>热度 {onlineLabel}</span>
            </Badge>
          </div>
        </div>
      </div>
    </section>
  );
}
