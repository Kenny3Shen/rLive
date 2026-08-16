import { useEffect, useState, type ReactNode } from "react";
import { Car, Ellipsis, Timer, type LucideIcon } from "lucide-react";
import { ANDROID_BACK_EVENT } from "@/app/androidBackNavigation";
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
import {
  RoomIdentityLine,
  roomIdentityOverflowDistance,
} from "@/shared/components/player/RoomIdentityLine";
import { usePortraitOrientation } from "@/shared/hooks/usePlayerViewport";
import type { SiteId } from "@/shared/types/live";
import { cn, formatOnline } from "@/lib/utils";
import type { AutoDanmakuSendController } from "./danmaku/useAutoDanmakuSend";
import { AutoDanmakuSendMenu, SleepTimerMenu } from "./RoomToolMenus";
import type { SleepTimerController } from "./useSleepTimer";

export { roomIdentityOverflowDistance };

/** A room-level entry in the HUD overflow menu (copy link, follow, …). */
export type PlayerHudRoomAction = {
  id: string;
  label: string;
  icon: LucideIcon;
  pressed?: boolean;
  disabled?: boolean;
  /**
   * The action answers through app chrome that never paints inside the
   * fullscreen layer (a dialog, a toast, another route), so the player must
   * leave fullscreen before handing over. Player toggles act on the picture
   * itself and leave this unset.
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
  /** Platform popularity/viewer count; hidden when the site reports nothing. */
  roomOnline?: number;
  /** Room-level actions (copy link, follow) contributed by the page. */
  roomActions?: readonly PlayerHudRoomAction[];
  /** Player toggles already published for the mobile room-actions sheet. */
  playerActions?: readonly PlayerHudRoomAction[];
  /** Room-scoped automatic danmaku sender exposed from the overflow menu. */
  autoSend?: AutoDanmakuSendController;
  /** Room-scoped countdown exposed from the overflow menu. */
  sleepTimer?: SleepTimerController;
  /** Compact viewport (portrait phone or short landscape). */
  compact?: boolean;
  /** Portal target — a `:fullscreen` ancestor owns the top layer. */
  portalContainer?: HTMLElement | React.RefObject<HTMLElement | null> | null;
  /** Tell the stage a menu is open so the idle timer cannot fade it out. */
  onOverlayInteractionChange?: (open: boolean) => void;
  /** Leave fullscreen before an action whose answer lives outside the stage. */
  onExitFullscreen?: () => void | Promise<void>;
};

/** Heat is only worth a line when the platform actually reports a count. */
export function playerHudOnlineLabel(online: number | undefined): string | null {
  if (online === undefined || !Number.isFinite(online) || online < 0) return null;
  return formatOnline(online);
}

/**
 * Whether the HUD has anything to draw. Fullscreen alone is not enough: a room
 * without a resolved title, host or menu entry would render an empty scrim band
 * across the top of the picture.
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
 * Fullscreen top chrome, the way ordinary live-video sites draw it: the room
 * title and host identity on the left, an overflow menu on the right, over a
 * scrim that fades down into the picture. It is a sibling of the bottom control
 * bar inside the player stage and shares its imperative visibility state, so
 * both layers fade together on the idle timer.
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
  compact = false,
  portalContainer,
  onOverlayInteractionChange,
  onExitFullscreen,
}: PlayerFullscreenHudProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [autoSendExpanded, setAutoSendExpanded] = useState(false);
  const [sleepTimerExpanded, setSleepTimerExpanded] = useState(false);
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

  useEffect(() => {
    if (!menuOpen) return;
    // One Back press closes the menu instead of leaving fullscreen or the room.
    const closeOnAndroidBack = (event: Event) => {
      event.preventDefault();
      setMenuOpen(false);
    };
    window.addEventListener(ANDROID_BACK_EVENT, closeOnAndroidBack);
    return () => window.removeEventListener(ANDROID_BACK_EVENT, closeOnAndroidBack);
  }, [menuOpen]);

  const hasMenu =
    roomActions.length > 0 ||
    playerActions.length > 0 ||
    autoSend !== undefined ||
    sleepTimer !== undefined;

  function runAction(action: PlayerHudRoomAction) {
    setMenuOpen(false);
    if (action.exitsFullscreen) {
      // A dialog or toast raised by this action paints in the app layer, which
      // the fullscreen stage covers entirely. Leave fullscreen first, then run
      // the action so its feedback is actually on screen.
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
        <Separator className={cn("my-2", glassSeparatorClass({ overlay: true }))} />
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
              onClick={() => {
                setAutoSendExpanded((expanded) => !expanded);
                setSleepTimerExpanded(false);
              }}
            />
          )}
          {sleepTimer && (
            <RoomToolTile
              icon={Timer}
              label={sleepTimer.active ? "定时中" : "定时关闭"}
              pressed={sleepTimerExpanded || sleepTimer.active}
              onClick={() => {
                setSleepTimerExpanded((expanded) => !expanded);
                setAutoSendExpanded(false);
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

/** Icon-over-label tile, matching the room actions sheet on mobile. */
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
        glassOptionClass({ overlay: true }),
        action.pressed && glassOptionSelectedClass({ overlay: true }),
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
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  pressed?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      className={cn(
        "h-auto min-w-0 flex-col gap-1.5 py-2.5 text-xs font-normal touch-manipulation max-md:py-3",
        glassOptionClass({ overlay: true }),
        pressed && glassOptionSelectedClass({ overlay: true }),
      )}
      aria-pressed={pressed}
      onClick={onClick}
    >
      <Icon className="size-5" aria-hidden />
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
