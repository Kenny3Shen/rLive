import { useEffect, useState, type ReactNode } from "react";
import { Ellipsis, Flame, type LucideIcon } from "lucide-react";
import { ANDROID_BACK_EVENT } from "@/app/androidBackNavigation";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { SiteLogo } from "@/shared/components/SiteLogo";
import {
  glassMutedTextClass,
  glassOptionClass,
  glassOptionSelectedClass,
  glassPanelClass,
  glassSeparatorClass,
} from "@/shared/components/player/glassSurface";
import {
  PLAYER_CONTROL_BUTTON_CLASS,
  PLAYER_CONTROL_ICON_CLASS,
  PLAYER_OVERLAY_CONTROL_BUTTON_CLASS,
} from "@/shared/components/player/PlayerControls";
import { usePortraitOrientation } from "@/shared/hooks/usePlayerViewport";
import type { SiteId } from "@/shared/types/live";
import { cn, formatOnline, normalizeImageUrl, SITE_LABELS } from "@/lib/utils";

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
  compact = false,
  portalContainer,
  onOverlayInteractionChange,
  onExitFullscreen,
}: PlayerFullscreenHudProps) {
  const [menuOpen, setMenuOpen] = useState(false);
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

  const title = roomTitle?.trim() || "直播间";
  const userName = roomUserName?.trim() || "";
  const platformName = siteId ? (SITE_LABELS[siteId] ?? siteId) : "";
  const trimmedRoomId = roomId?.trim() || "";
  const onlineLabel = playerHudOnlineLabel(roomOnline);
  const avatarUrl = normalizeImageUrl(roomUserAvatar);
  const avatarLabel = userName ? `${userName} 的头像` : "主播头像";
  const hasMenu = roomActions.length > 0 || playerActions.length > 0;

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
      {roomActions.length > 0 && playerActions.length > 0 && (
        <Separator className={cn("my-2", glassSeparatorClass({ overlay: true }))} />
      )}
      {playerActions.length > 0 && (
        <div className="grid grid-cols-4 gap-1.5 max-md:gap-2">
          {playerActions.map((action) => (
            <HudActionTile key={action.id} action={action} onRun={runAction} />
          ))}
        </div>
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
        "player-scrim-overlay-top flex min-w-0 items-start gap-2 bg-transparent pr-[max(0.375rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] text-white",
        compact ? "pt-[max(0.375rem,env(safe-area-inset-top))] pb-3" : "pt-2.5 pb-6",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p
          className={cn(
            "min-w-0 truncate font-semibold tracking-tight [text-shadow:0_1px_3px_rgb(0_0_0_/_0.75)]",
            compact ? "text-sm" : "text-base",
          )}
          title={title}
        >
          {title}
        </p>
        <div className="flex min-w-0 items-center gap-2 text-white/80">
          {(avatarUrl || userName) && (
            <Avatar
              size="sm"
              className={cn("shrink-0 ring-1 ring-white/25", compact ? "size-5" : "size-6")}
              aria-label={avatarLabel}
            >
              <AvatarImage src={avatarUrl} alt={avatarLabel} referrerPolicy="no-referrer" />
              <AvatarFallback
                aria-label={`${avatarLabel}（加载失败）`}
                className="bg-white/18 text-[0.625rem] font-medium text-white"
              >
                {Array.from(userName)[0] ?? "?"}
              </AvatarFallback>
            </Avatar>
          )}
          <span
            className={cn(
              "min-w-0 truncate font-medium [text-shadow:0_1px_2px_rgb(0_0_0_/_0.7)]",
              compact ? "text-xs" : "text-sm",
            )}
            title={userName || undefined}
          >
            {userName || "未知主播"}
          </span>
          {siteId && trimmedRoomId && (
            <HudMetaItem
              compact={compact}
              title={`${platformName}房间号：${trimmedRoomId}`}
              icon={<SiteLogo siteId={siteId} className={compact ? "size-3" : "size-3.5"} />}
            >
              {trimmedRoomId}
            </HudMetaItem>
          )}
          {onlineLabel && (
            <HudMetaItem
              compact={compact}
              title={`当前热度：${onlineLabel}`}
              icon={
                <Flame aria-hidden className={cn("text-accent", compact ? "size-3" : "size-3.5")} />
              }
            >
              <span className="sr-only">当前热度 </span>
              {onlineLabel}
            </HudMetaItem>
          )}
        </div>
      </div>

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
                <DrawerTitle
                  className={cn(
                    "px-1 pb-1 text-xs font-medium",
                    glassMutedTextClass({ overlay: true }),
                  )}
                >
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
              className={cn("w-64 gap-0 p-1.5", glassPanelClass({ overlay: true }))}
            >
              <PopoverTitle
                className={cn(
                  "px-2 py-1 text-xs font-medium",
                  glassMutedTextClass({ overlay: true }),
                )}
              >
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
        "h-auto flex-col gap-1.5 py-2.5 text-xs font-normal touch-manipulation max-md:py-3",
        glassOptionClass({ overlay: true }),
        action.pressed && glassOptionSelectedClass({ overlay: true }),
      )}
      disabled={action.disabled}
      aria-pressed={action.pressed}
      onClick={() => onRun(action)}
    >
      <Icon className="size-5" aria-hidden />
      {action.label}
    </Button>
  );
}

/** Separated meta pair (platform room id, heat) in the host line. */
function HudMetaItem({
  compact,
  title,
  icon,
  children,
}: {
  compact: boolean;
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1 border-l border-white/20 pl-2 tabular-nums [text-shadow:0_1px_2px_rgb(0_0_0_/_0.7)]",
        compact ? "text-[0.6875rem]" : "text-xs",
      )}
      title={title}
    >
      {icon}
      {children}
    </span>
  );
}
