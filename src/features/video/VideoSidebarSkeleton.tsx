import { Skeleton } from "@/components/ui/skeleton";
import { CARD_SURFACE_CLASS } from "@/shared/components/cardSurface";
import {
  VIDEO_DETAILS_INFO_CARD_CLASS,
  VIDEO_DETAILS_SIDEBAR_STACK_CLASS,
} from "@/shared/components/videoDetailsSidebar";
import { cn } from "@/lib/utils";

/**
 * UP 主信息卡骨架。
 *
 * 几何与真卡逐项对齐：40px 头像、20px 名称行、16px 元信息行、24px 标题行和
 * 16px 统计行。数据到达时只替换内容，相关视频列表不会再次下移。
 */
export function UpCardSkeleton() {
  return (
    <section data-slot="video-up-card-skeleton" aria-hidden className="shrink-0">
      <div className={VIDEO_DETAILS_INFO_CARD_CLASS}>
        <div className="flex min-w-0 items-start gap-2.5 pr-16">
          <Skeleton className="size-10 shrink-0 rounded-full ring-1 ring-border/80" />
          <div className="min-w-0 flex-1">
            <Skeleton className="h-5 w-32" />
            <div className="mt-0.5 flex items-center gap-2">
              <Skeleton className="h-4 w-14" />
              <Skeleton className="h-4 w-12" />
            </div>
          </div>
        </div>
        <Skeleton className="mt-1.5 h-6 w-4/5" />
        <div className="mt-0.5 flex items-center gap-x-2">
          <Skeleton className="h-4 w-12" />
          <Skeleton className="h-4 w-10" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-14" />
        </div>
      </div>
    </section>
  );
}

/**
 * 行式相关视频骨架列表。
 *
 * 相关查询 pending 与桌面首帧前共用同一段 markup，卡片底色、封面比例和右侧三行
 * 文本不能各维护一份。默认三条与 RelatedPanel 的既有首屏数量一致。
 */
export function RelatedVideoSkeletonList({ count = 3 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <div
          key={index}
          aria-hidden
          className={cn("flex items-start gap-2.5 rounded-xl p-1.5", CARD_SURFACE_CLASS)}
        >
          <Skeleton className="aspect-video w-2/5 shrink-0 rounded-md ring-1 ring-border-subtle" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 py-0.5">
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3 w-3/5" />
            <Skeleton className="h-3 w-2/5" />
          </div>
        </div>
      ))}
    </>
  );
}

/**
 * 普通点播页媒体首帧前的详情栏骨架。
 *
 * 仅用于桌面端普通 VOD 的媒体首帧前或惰性侧栏模块加载时。只占位详情信息，不往
 * 黑舞台铺大灰块；本模块不导入查询或完整 VideoSidebar，因此不会提前发起 archive /
 * related 请求。页签条、UP 卡、相关视频行沿用成品的边框、内缩与断点宽度，首帧到达
 * 时只替换内容，不会从空白黑栏突然长出整片界面。
 */
export function VideoSidebarSkeleton() {
  return (
    <div
      data-slot="video-sidebar-skeleton"
      aria-hidden
      className="flex h-full min-h-0 flex-col overflow-hidden"
    >
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-border/80 px-4">
        <Skeleton className="h-4 w-14" />
        <Skeleton className="h-4 w-8" />
        <Skeleton className="h-4 w-8" />
        <Skeleton className="h-4 w-8" />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className={VIDEO_DETAILS_SIDEBAR_STACK_CLASS}>
          <UpCardSkeleton />
          <div className="flex flex-col gap-2">
            <RelatedVideoSkeletonList count={3} />
          </div>
        </div>
      </div>
    </div>
  );
}
