import { type ReactNode } from "react";
import { Ellipsis, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import {
  glassOptionClass,
  glassOptionSelectedClass,
  glassPanelClass,
  glassTitleClass,
} from "@/shared/components/player/glassSurface";
import {
  PLAYER_CONTROL_BUTTON_CLASS,
  PLAYER_CONTROL_ICON_CLASS,
  PLAYER_OVERLAY_CONTROL_BUTTON_CLASS,
} from "@/shared/components/player/PlayerControls";
import { ToolActiveDot } from "@/shared/components/player/ToolActiveDot";
import { usePortraitOrientation } from "@/shared/hooks/usePlayerViewport";
import { cn } from "@/lib/utils";

/**
 * 全屏 HUD 右上角的 `⋮` 溢出菜单外壳：直播间与视频播放页共用同一形态。
 *
 * 紧凑视口走抽屉（竖屏从下、横屏从右），常规视口走 Popover —— 全屏下画面就是
 * 视口，磁贴网格在手机上必须有足够的落点面积。菜单内容由调用方给出。
 */
export function PlayerHudOverflowMenu({
  label,
  title,
  open,
  onOpenChange,
  compact = false,
  portalContainer,
  children,
}: {
  /** 触发按钮的无障碍标签，例如「更多房间操作」。 */
  label: string;
  /** 菜单标题，例如「房间操作」。 */
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  compact?: boolean;
  /** Portal 目标 —— `:fullscreen` 祖先拥有 top layer。 */
  portalContainer?: HTMLElement | React.RefObject<HTMLElement | null> | null;
  children: ReactNode;
}) {
  const portrait = usePortraitOrientation();
  const triggerProps = {
    variant: "ghost",
    size: "icon-sm",
    "aria-label": label,
    className: cn(
      PLAYER_CONTROL_BUTTON_CLASS,
      PLAYER_CONTROL_ICON_CLASS,
      PLAYER_OVERLAY_CONTROL_BUTTON_CLASS,
    ),
  } as const;

  if (compact) {
    return (
      <>
        <Button {...triggerProps} aria-expanded={open} onClick={() => onOpenChange(!open)}>
          <Ellipsis data-icon="inline-start" aria-hidden />
        </Button>
        <Drawer open={open} onOpenChange={onOpenChange}>
          <DrawerContent
            side={portrait ? "bottom" : "right"}
            container={portalContainer}
            glass
            className={cn("space-y-2", glassPanelClass({ overlay: true }))}
          >
            <DrawerTitle className={cn("px-1 pb-1", glassTitleClass({ overlay: true }))}>
              {title}
            </DrawerTitle>
            {children}
          </DrawerContent>
        </Drawer>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={<Button {...triggerProps} />}>
        <Ellipsis data-icon="inline-start" aria-hidden />
      </PopoverTrigger>
      <PopoverContent
        container={portalContainer}
        side="bottom"
        align="end"
        collisionPadding={{ top: 12, right: 12, bottom: 24, left: 12 }}
        sticky
        glass
        className={cn(
          "max-h-[calc(100dvh-5rem)] w-[min(32rem,calc(100vw-1.5rem))] max-w-[calc(100vw-1.5rem)] overflow-y-auto gap-0 p-1.5",
          glassPanelClass({ overlay: true }),
        )}
      >
        <PopoverTitle className={cn("px-2 py-1", glassTitleClass({ overlay: true }))}>
          {title}
        </PopoverTitle>
        {children}
      </PopoverContent>
    </Popover>
  );
}

/**
 * 图标在上、文字在下的磁贴，与移动端房间操作抽屉一致。
 *
 * `pressed` 是选中态（展开中或开关已开），`active` 额外点一个角标，
 * 用于「还在后台生效」的工具（投屏中、定时中）。
 */
export function PlayerToolTile({
  icon: Icon,
  label,
  pressed,
  active,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  pressed?: boolean;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      disabled={disabled}
      className={cn(
        "h-auto min-w-0 flex-col gap-1.5 py-2.5 text-xs font-normal touch-manipulation max-md:py-3",
        glassOptionClass(),
        pressed && glassOptionSelectedClass(),
      )}
      aria-pressed={pressed}
      onClick={onClick}
    >
      <span className="relative inline-flex">
        <Icon className="size-5" aria-hidden />
        {active && <ToolActiveDot />}
      </span>
      <span className="max-w-full truncate">{label}</span>
    </Button>
  );
}

/** 磁贴下方展开的二级面板（投屏设备列表、定时选项等）。 */
export function PlayerToolPanel({ children }: { children: ReactNode }) {
  return (
    <div className={cn("mt-2 min-w-0 rounded-lg p-3", glassPanelClass({ overlay: true }))}>
      {children}
    </div>
  );
}
