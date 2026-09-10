import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

type PlayerStageLoadingProps = {
  /**
   * 画面内 HUD 同一位置的悬浮返回箭头。不提供则只渲染加载指示
   * （路由模块还没就绪时没有可用的返回目标）。
   */
  onBack?: () => void;
  backLabel?: string;
  label?: string;
  className?: string;
};

/**
 * 沉浸播放页的加载舞台：黑底铺满 + 居中加载指示，返回口是画面内 HUD 同一位置、
 * 同一画法的悬浮箭头。
 *
 * 播放页的流内顶栏已全部迁入画面内 HUD，加载态因此不能再借用应用外壳的画法
 * （sidebar 底色 + 下边框的「加载中」条）：那样的条会在首次进入时先闪出来，
 * 等播放器挂载后又被顶掉，看起来像外壳混进了播放页。这里刻意与
 * `PlayerPane` 的「正在解析线路…」保持同一视觉，使加载与播放之间没有跳变。
 */
export function PlayerStageLoading({
  onBack,
  backLabel = "返回上一页",
  label = "正在加载…",
  className,
}: PlayerStageLoadingProps) {
  return (
    <div className={cn("relative flex h-full min-h-0 flex-col bg-black", className)}>
      {onBack && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          // 这里不在播放器皮肤内，`--media-*` 令牌会落到应用前景色（浅色主题下是深色），
          // 黑舞台上的返回箭头必须自带白字与白色悬停底。
          className="absolute top-3 left-3 z-10 shrink-0 text-white/90 hover:bg-white/15 hover:text-white max-md:size-11 max-md:touch-manipulation"
          aria-label={backLabel}
          onClick={onBack}
        >
          <ChevronLeft data-icon="inline-start" aria-hidden />
        </Button>
      )}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
        <Spinner className="size-8 text-primary" aria-label={label} />
        <p className="text-sm">{label}</p>
      </div>
    </div>
  );
}
