import { useEffect, useState, type ReactNode } from "react";
import { Car, Cast, ChevronLeft, Ellipsis, Timer, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import {
  glassOptionClass,
  glassOptionSelectedClass,
  glassPanelClass,
  glassSeparatorClass,
  glassTitleClass,
} from "@/shared/components/player/glassSurface";
import {
  PLAYER_CONTROL_BUTTON_CLASS,
  PLAYER_CONTROL_ICON_CLASS,
  PLAYER_OVERLAY_CONTROL_BUTTON_CLASS,
} from "@/shared/components/player/PlayerControls";
import { ToolActiveDot } from "@/shared/components/player/ToolActiveDot";
import {
  RoomIdentityLine,
  roomIdentityOverflowDistance,
} from "@/shared/components/player/RoomIdentityLine";
import { usePortraitOrientation } from "@/shared/hooks/usePlayerViewport";
import type { SiteId } from "@/shared/types/live";
import { cn, formatOnline } from "@/lib/utils";
import type { AutoDanmakuSendController } from "./danmaku/useAutoDanmakuSend";
import { AutoDanmakuSendMenu, SleepTimerMenu } from "./RoomToolMenus";
import { CastMenu } from "./CastMenu";
import type { SleepTimerController } from "./useSleepTimer";

export { roomIdentityOverflowDistance };

/** HUD 溢出菜单中的房间级条目（复制链接、关注等）。 */
export type PlayerHudRoomAction = {
  id: string;
  label: string;
  icon: LucideIcon;
  pressed?: boolean;
  disabled?: boolean;
  /**
   * 该操作要通过永远不会绘制在全屏层内的应用 chrome 应答（对话框、toast、另一条
   * 路由），因此播放器必须先退出全屏再移交。播放器开关作用于画面本身，
   * 不设置此项。
   */
  exitsFullscreen?: boolean;
  onSelect: () => void;
};

export type PlayerFullscreenHudProps = {
  siteId?: SiteId;
  roomId?: string;
  roomTitle?: string;
  roomUserName?: string;
  roomUserAvatar?: string;
  /** 平台人气/观众数；站点未上报时隐藏。 */
  roomOnline?: number;
  /** 由页面提供的房间级操作（复制链接、关注）。 */
  roomActions?: readonly PlayerHudRoomAction[];
  /** 已为移动端房间操作抽屉发布的播放器开关。 */
  playerActions?: readonly PlayerHudRoomAction[];
  /** 从溢出菜单暴露的房间级自动弹幕发送器。 */
  autoSend?: AutoDanmakuSendController;
  /** 从溢出菜单暴露的房间级倒计时。 */
  sleepTimer?: SleepTimerController;
  /** DLNA 投屏入口；提供时在全屏 HUD 的工具磁贴中出现。 */
  cast?: {
    url: string | null;
    headers: Record<string, string>;
    title: string;
    device: string | null;
    onDeviceChange: (deviceName: string | null) => void;
  };
  /**
   * 房间页自己的控件（录制），直接摆在溢出菜单左侧。
   *
   * 只有网页全屏能用：这些控件的 popover 默认 portal 到 `<body>`，
   * 而原生全屏的 stage 位于 top layer，会把它们整个压在下面。
   */
  toolsSlot?: ReactNode;
  /** 紧凑视口（竖屏手机或较矮的横屏）。 */
  compact?: boolean;
  /** Portal 目标 —— `:fullscreen` 祖先拥有 top layer。 */
  portalContainer?: HTMLElement | React.RefObject<HTMLElement | null> | null;
  /** 告诉舞台有菜单打开，空闲计时器不能把它淡出。 */
  onOverlayInteractionChange?: (open: boolean) => void;
  /** 应答存在于舞台之外的操作之前先退出全屏。 */
  onExitFullscreen?: () => void | Promise<void>;
  /** 左上角返回箭头：退出当前全屏层回到窗口化布局；不提供则不渲染。 */
  onBack?: () => void;
  /** 返回箭头的无障碍标签，由调用方按当前全屏形态给出。 */
  backLabel?: string;
};

/** 只有平台真的上报了数值时，热度才值得占一行。 */
export function playerHudOnlineLabel(online: number | undefined): string | null {
  if (online === undefined || !Number.isFinite(online) || online < 0) return null;
  return formatOnline(online);
}

/**
 * HUD 是否有东西可画。仅全屏还不够：没有解析出的标题、主播和菜单条目的房间
 * 会在画面顶部渲染一条空的遮罩带。
 *
 * `fullscreen` 指「舞台已经吃掉了 `RoomTopBar`」，两种方式都算：原生全屏把它盖在
 * top layer 之下，桌面网页全屏直接把它卸载。两者都需要 HUD 把房间身份与工具补回画面内。
 */
export function showPlayerFullscreenHud({
  fullscreen,
  hasRoomIdentity,
  hasActions,
}: {
  fullscreen: boolean;
  hasRoomIdentity: boolean;
  hasActions: boolean;
}): boolean {
  return fullscreen && (hasRoomIdentity || hasActions);
}

/**
 * 全屏顶部 chrome，普通直播视频网站的画法：最左侧返回箭头（可选）退出全屏，
 * 其后是房间标题与主播身份，右侧溢出菜单，覆盖一段向下渐隐入画面的遮罩。
 * 它是播放器舞台内底部控制条的兄弟节点，并共享其命令式可见性状态，
 * 因此两层一起随空闲计时器淡出。
 */
export function PlayerFullscreenHud({
  siteId,
  roomId,
  roomTitle,
  roomUserName,
  roomUserAvatar,
  roomOnline,
  roomActions = [],
  playerActions = [],
  autoSend,
  sleepTimer,
  cast,
  toolsSlot,
  compact = false,
  portalContainer,
  onOverlayInteractionChange,
  onExitFullscreen,
  onBack,
  backLabel,
}: PlayerFullscreenHudProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [autoSendExpanded, setAutoSendExpanded] = useState(false);
  const [sleepTimerExpanded, setSleepTimerExpanded] = useState(false);
  const [castExpanded, setCastExpanded] = useState(false);
  const portrait = usePortraitOrientation();

  useEffect(() => {
    onOverlayInteractionChange?.(menuOpen);
  }, [menuOpen, onOverlayInteractionChange]);

  useEffect(
    () => () => {
      onOverlayInteractionChange?.(false);
    },
    [onOverlayInteractionChange],
  );

  const hasMenu =
    roomActions.length > 0 ||
    playerActions.length > 0 ||
    autoSend !== undefined ||
    sleepTimer !== undefined;

  function runAction(action: PlayerHudRoomAction) {
    setMenuOpen(false);
    if (action.exitsFullscreen) {
      // 此操作引发的对话框或 toast 绘制在应用层，会被全屏舞台完全遮盖。
      // 先退出全屏再执行操作，使其反馈真正出现在屏幕上。
      void Promise.resolve(onExitFullscreen?.()).then(() => action.onSelect());
      return;
    }
    action.onSelect();
  }

  const menuBody = (
    <>
      {roomActions.length > 0 && (
        <div className="grid grid-cols-4 gap-1.5 max-md:gap-2">
          {roomActions.map((action) => (
            <HudActionTile key={action.id} action={action} onRun={runAction} />
          ))}
        </div>
      )}
      {roomActions.length > 0 && (playerActions.length > 0 || autoSend || sleepTimer) && (
        <Separator className={cn("my-2", glassSeparatorClass())} />
      )}
      {(playerActions.length > 0 || autoSend || sleepTimer) && (
        <div className="grid grid-cols-4 gap-1.5 max-md:gap-2">
          {playerActions.map((action) => (
            <HudActionTile key={action.id} action={action} onRun={runAction} />
          ))}
          {autoSend && (
            <RoomToolTile
              icon={Car}
              label={autoSend.enabled ? "发送中" : "自动发送"}
              pressed={autoSendExpanded || autoSend.enabled}
              active={autoSend.enabled}
              onClick={() => {
                setAutoSendExpanded((expanded) => !expanded);
                setSleepTimerExpanded(false);
                setCastExpanded(false);
              }}
            />
          )}
          {sleepTimer && (
            <RoomToolTile
              icon={Timer}
              label={sleepTimer.active ? "定时中" : "定时关闭"}
              pressed={sleepTimerExpanded || sleepTimer.active}
              active={sleepTimer.active}
              onClick={() => {
                setSleepTimerExpanded((expanded) => !expanded);
                setAutoSendExpanded(false);
                setCastExpanded(false);
              }}
            />
          )}
          {cast && (
            <RoomToolTile
              icon={Cast}
              label={cast.device ? "投屏中" : "投屏"}
              pressed={castExpanded || cast.device != null}
              active={cast.device != null}
              disabled={cast.url == null}
              onClick={() => {
                setCastExpanded((expanded) => !expanded);
                setAutoSendExpanded(false);
                setSleepTimerExpanded(false);
              }}
            />
          )}
        </div>
      )}
      {autoSend && autoSendExpanded && (
        <RoomToolPanel>
          <AutoDanmakuSendMenu
            autoSend={autoSend}
            variant="overlay"
            idPrefix="fullscreen-auto-danmaku"
          />
        </RoomToolPanel>
      )}
      {sleepTimer && sleepTimerExpanded && (
        <RoomToolPanel>
          <SleepTimerMenu timer={sleepTimer} showTrigger={false} variant="overlay" showHeader />
        </RoomToolPanel>
      )}
      {cast && castExpanded && (
        <RoomToolPanel>
          <CastMenu
            castUrl={cast.url}
            headers={cast.headers}
            title={cast.title}
            variant="overlay"
            onCastingDeviceChange={cast.onDeviceChange}
          />
        </RoomToolPanel>
      )}
    </>
  );

  const menuTriggerProps = {
    variant: "ghost",
    size: "icon-sm",
    "aria-label": "更多房间操作",
    className: cn(
      PLAYER_CONTROL_BUTTON_CLASS,
      PLAYER_CONTROL_ICON_CLASS,
      PLAYER_OVERLAY_CONTROL_BUTTON_CLASS,
    ),
  } as const;

  return (
    <div
      data-slot="player-fullscreen-hud"
      data-compact={compact ? "true" : "false"}
      className={cn(
        "player-scrim-overlay-top flex min-w-0 items-center gap-2 bg-transparent pr-[max(0.375rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] text-white",
        compact ? "pt-[max(0.375rem,env(safe-area-inset-top))] pb-3" : "pt-2.5 pb-6",
      )}
    >
      {onBack && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={backLabel ?? "退出全屏"}
          className={cn(
            PLAYER_CONTROL_BUTTON_CLASS,
            PLAYER_CONTROL_ICON_CLASS,
            PLAYER_OVERLAY_CONTROL_BUTTON_CLASS,
            "shrink-0",
          )}
          onClick={onBack}
        >
          <ChevronLeft data-icon="inline-start" aria-hidden />
        </Button>
      )}

      <RoomIdentityLine
        siteId={siteId}
        roomId={roomId}
        title={roomTitle}
        userName={roomUserName}
        userAvatar={roomUserAvatar}
        online={roomOnline}
        compact={compact}
        className="flex-1"
      />

      {toolsSlot}

      {hasMenu &&
        (compact ? (
          <>
            <Button
              {...menuTriggerProps}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <Ellipsis data-icon="inline-start" aria-hidden />
            </Button>
            <Drawer open={menuOpen} onOpenChange={setMenuOpen}>
              <DrawerContent
                side={portrait ? "bottom" : "right"}
                container={portalContainer}
                glass
                className={cn("space-y-2", glassPanelClass({ overlay: true }))}
              >
                <DrawerTitle className={cn("px-1 pb-1", glassTitleClass({ overlay: true }))}>
                  房间操作
                </DrawerTitle>
                {menuBody}
              </DrawerContent>
            </Drawer>
          </>
        ) : (
          <Popover open={menuOpen} onOpenChange={setMenuOpen}>
            <PopoverTrigger render={<Button {...menuTriggerProps} />}>
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
                房间操作
              </PopoverTitle>
              {menuBody}
            </PopoverContent>
          </Popover>
        ))}
    </div>
  );
}

/** 图标在上文字在下的磁贴，与移动端房间操作抽屉一致。 */
function HudActionTile({
  action,
  onRun,
}: {
  action: PlayerHudRoomAction;
  onRun: (action: PlayerHudRoomAction) => void;
}) {
  const Icon = action.icon;
  return (
    <Button
      type="button"
      variant="ghost"
      className={cn(
        "h-auto min-w-0 flex-col gap-1.5 py-2.5 text-xs font-normal touch-manipulation max-md:py-3",
        glassOptionClass(),
        action.pressed && glassOptionSelectedClass(),
      )}
      disabled={action.disabled}
      aria-pressed={action.pressed}
      onClick={() => onRun(action)}
    >
      <Icon className="size-5" aria-hidden />
      <span className="max-w-full truncate">{action.label}</span>
    </Button>
  );
}

function RoomToolTile({
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

function RoomToolPanel({ children }: { children: ReactNode }) {
  return (
    <div className={cn("mt-2 min-w-0 rounded-lg p-3", glassPanelClass({ overlay: true }))}>
      {children}
    </div>
  );
}
