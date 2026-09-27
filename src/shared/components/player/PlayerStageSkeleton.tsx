import type { CSSProperties, ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * 沉浸播放页加载骨架的公共积木。
 *
 * 这些页面原先的加载态是一块纯黑加居中转圈：用户看不出「在等的是什么形状的
 * 东西」，而数据到达后整套 chrome（顶栏、控制条、侧栏）会一次性长出来，布局
 * 跳动。骨架把目标布局先画出来，只有内容替换，几何不跳。
 *
 * **画面区刻意保持纯黑**：视频本来就在那里，提前铺一块灰反而像「画面加载失败」；
 * 真实的起播过程也是一块黑底加控制条。骨架只画视频周围那些「本来就有东西」的
 * 位置。
 *
 * 住在 `shared/components/player/` 是因为调用点分属 room / shorts / app 三层。
 *
 * **刻意不 import `PlayerControls`**：`Shell` 的沉浸路由占位要用它，而外壳在首屏
 * 关键路径上，播放器控制条会拖进整层 Video.js 原生 UI。这里只用 `styles.css`
 * 里全局可用的 `--media-*` 令牌与 `size-media-control` 工具类；返回按钮由调用方
 * 以 `back` 插槽传入（各页本来就持有 `PLAYER_HUD_BUTTON_CLASS` 那套配方）。
 */

/**
 * 黑舞台上的骨架块。
 *
 * 必须覆盖 `Skeleton` 默认的 `bg-muted`：这几处表面是媒体皮肤的黑底，而
 * `bg-muted` 是主题色 —— 浅色主题下它是接近白色的浅灰，铺在黑底上亮得像内容
 * 已经加载出来了。10% 的白与 `--media-muted`（15%）同一档观感。
 *
 * 主题表面（侧栏、底栏）的骨架**不要**用它，直接用 `Skeleton` 的默认底色。
 */
export function StageSkeletonBlock({
  className,
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return <Skeleton aria-hidden className={cn("bg-white/10", className)} style={style} />;
}

/**
 * 画面内 HUD 的身份行占位：标题 + 主播/频道名 + 右端溢出菜单。
 *
 * 返回箭头不在这里 —— 它由调用方以 `back` 插槽传进来（加载态的返回必须是**真**
 * 按钮，否则用户被困在加载态里）。
 */
export function PlayerHudSkeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn("flex min-w-0 flex-1 items-center gap-2", className)}>
      <StageSkeletonBlock className="h-4 w-32 shrink-0" />
      <StageSkeletonBlock className="h-3 w-20 shrink-0" />
      <StageSkeletonBlock className="ml-auto size-media-control shrink-0 rounded-media-control" />
    </div>
  );
}

/**
 * 底部控制条的加载占位。
 *
 * 几何照抄 `ControlsSurface`：同一条 `--media-controls-gradient` 渐变压暗、
 * 同一档内边距与安全区，因此加载态与播放态是**同一条**渐变、同一个高度。
 * 左端与右端的按钮数按真实控制条给（左：播放/刷新/音量/仅音频；右：设置/
 * 弹幕/字幕/画中画/全屏），中间留空给各页自己的中央槽位（弹幕输入框）。
 *
 * 按钮画成圆点而不是方块：控制条的按钮本来就是圆的
 * （`--media-control-radius` 是 99px），方块更像「内容没加载出来」。
 */
export function PlayerControlsSkeleton({
  className,
  leading = 3,
  trailing = 4,
}: {
  className?: string;
  /** 左端按钮数。 */
  leading?: number;
  /** 右端按钮数。 */
  trailing?: number;
}) {
  return (
    <div
      data-slot="player-controls-skeleton"
      aria-hidden
      className={cn("media-skin pointer-events-none absolute inset-x-0 bottom-0 z-20", className)}
    >
      <div className="absolute inset-x-0 bottom-0 z-0 h-[calc(100%+var(--media-spacing)*8)] bg-(image:--media-controls-gradient)" />
      <div className="relative z-10 flex w-full min-w-0 flex-col gap-0.5 px-1 pt-1">
        <div className="flex w-full min-w-0 items-center justify-between gap-2 px-2 py-1 pb-[max(0.25rem,env(safe-area-inset-bottom))]">
          <div className="flex shrink-0 items-center gap-1">
            {Array.from({ length: leading }, (_, index) => (
              <StageSkeletonBlock key={index} className="size-media-control rounded-media-control" />
            ))}
          </div>
          <div className="min-w-0 flex-1" />
          <div className="flex shrink-0 items-center gap-1">
            {Array.from({ length: trailing }, (_, index) => (
              <StageSkeletonBlock key={index} className="size-media-control rounded-media-control" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

type PlayerStageSkeletonProps = {
  /** 读屏播报的加载文案。骨架对辅助技术是装饰，文案只能挂在这里。 */
  label?: string;
  /** HUD 左端的返回按钮。沉浸页必须传，否则加载态里没有出口。 */
  back?: ReactNode;
  /** 顶栏其余部分；默认是身份行骨架。 */
  hud?: ReactNode;
  /** 底栏；默认是控制条骨架。传 `null` 表示这一页的底栏由调用方自己画。 */
  controls?: ReactNode;
  /** 舞台内的其他层（如竖屏流的信息浮层骨架）。 */
  children?: ReactNode;
  className?: string;
};

/**
 * 沉浸播放页的加载骨架：纯黑画面 + 画面内 HUD 骨架 + 底部控制条骨架。
 *
 * 这四处（直播间、两条竖屏流、沉浸路由占位）从前是一块纯黑加居中转圈，用户看不出
 * 「在等的是什么形状的东西」；骨架把这一页的布局先画出来，数据到达时只有内容替换。
 */
export function PlayerStageSkeleton({
  label = "正在加载…",
  back,
  hud,
  controls,
  children,
  className,
}: PlayerStageSkeletonProps) {
  return (
    <div
      data-slot="player-stage-skeleton"
      className={cn(
        // `--media-scale-unit` 与 `.r-live-player-skin` 同一档（0.9rem）：不设时
        // 会回退到 token 默认的 16px，骨架里的 `size-media-control` 会大一圈，
        // 加载完成时 HUD 与控制条会缩一下。短视频视口另有自己的 1.2rem。
        "media-skin relative flex h-full min-h-0 flex-col overflow-hidden bg-black [--media-scale-unit:0.9rem]",
        className,
      )}
    >
      <span role="status" className="sr-only">
        {label}
      </span>
      <div className="player-scrim-overlay-top absolute inset-x-0 top-0 z-30 flex min-w-0 items-center gap-2 pr-[max(0.375rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] pt-[max(0.625rem,var(--player-safe-area-top,0px))] pb-6 text-white">
        {back}
        {hud ?? <PlayerHudSkeleton />}
      </div>
      {children}
      {controls === undefined ? <PlayerControlsSkeleton /> : controls}
    </div>
  );
}
