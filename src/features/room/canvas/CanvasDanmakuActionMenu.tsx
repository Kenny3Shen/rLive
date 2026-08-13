import { memo, type PointerEvent as ReactPointerEvent } from "react";
import { Copy, SendHorizontal, Star, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  glassOptionClass,
  glassPanelClass,
  glassSeparatorClass,
} from "@/shared/components/player/glassSurface";
import type { DanmakuEvent, SiteId } from "@/shared/types/live";
import { useDanmakuActions } from "../danmaku/useDanmakuActions";
import { cn } from "@/lib/utils";

/**
 * Comment under the pointer on the video canvas. Canvas danmaku have no DOM
 * node, so the renderer hands over the box it actually drew (element-relative
 * CSS pixels, border padding included) and this menu anchors itself to it.
 */
export type CanvasDanmakuHoverTarget = {
  hoverKey: string;
  /** Raw comment body, without the aggregation suffix. */
  content: string;
  user: string;
  eventKind: DanmakuEvent["kind"];
  left: number;
  top: number;
  width: number;
  height: number;
};

/**
 * Horizontal room the pill needs on either side of its anchor. The menu is
 * centered with a CSS `clamp`, so this only has to be a safe upper bound for
 * three icon buttons rather than a measured width.
 *
 * The large variant is wider because its buttons are, and the clamp has to keep
 * the whole pill on screen at either size.
 */
const MENU_HALF_WIDTH_PX = 92;
const MENU_HALF_WIDTH_LARGE_PX = 116;
/**
 * Marks the menu so the canvas can recognise it as a `pointerleave` destination.
 * Declared here, where the attribute is actually applied, so the canvas imports
 * it in the same direction as the component itself.
 */
export const CANVAS_DANMAKU_MENU_ATTR = "data-canvas-danmaku-menu";
/**
 * Visual distance between the comment and the pill.
 *
 * This gap is bridged by transparent padding rather than left as empty space:
 * the pointer has to cross it to reach the buttons, and an unbridged gap fires
 * `pointerleave` on the canvas before `pointerenter` on the pill, which released
 * the freeze and took the menu away before it could be clicked.
 */
const MENU_GAP_PX = 6;
/** Below this the pill would clip the top edge, so it flips under the comment. */
const MENU_FLIP_THRESHOLD_PX = 56;

type CanvasDanmakuActionMenuProps = {
  target: CanvasDanmakuHoverTarget;
  siteId?: SiteId;
  roomId?: string;
  roomTitle?: string;
  roomUserName?: string;
  /**
   * Larger touch/aim targets. Set for touch selection and for a fullscreen
   * stage, where the picture is a whole big display away from the user and the
   * compact desktop pill is hard to hit.
   */
  large?: boolean;
  /** Touch selection keeps the menu until dismissed, so it offers a close affordance. */
  onDismiss?: () => void;
  onPointerEnter?: () => void;
  /** Receives the event so the caller can tell where the pointer is going. */
  onPointerLeave?: (event: ReactPointerEvent<HTMLElement>) => void;
};

export const CanvasDanmakuActionMenu = memo(function CanvasDanmakuActionMenu({
  target,
  siteId,
  roomId,
  roomTitle,
  roomUserName,
  large = false,
  onDismiss,
  onPointerEnter,
  onPointerLeave,
}: CanvasDanmakuActionMenuProps) {
  const message = target.content.trim();
  const actions = useDanmakuActions({
    message,
    eventKind: target.eventKind,
    siteId,
    roomId,
    roomTitle,
    roomUserName,
  });
  const flipBelow = target.top < MENU_FLIP_THRESHOLD_PX;
  const anchorX = target.left + target.width / 2;
  const halfWidth = large ? MENU_HALF_WIDTH_LARGE_PX : MENU_HALF_WIDTH_PX;
  const buttonSize = large ? "icon-lg" : "icon-sm";

  return (
    <div
      // The player stage treats bare pointer presses as video gestures. Mark
      // this as chrome and swallow the press so acting on a comment cannot also
      // toggle playback or fullscreen. `pointermove` still bubbles, keeping the
      // controls awake while the pointer rests here.
      data-player-hud
      // Lets the canvas recognise this element as the pointer's destination on
      // its own `pointerleave`, which fires before this element's `pointerenter`.
      {...{ [CANVAS_DANMAKU_MENU_ATTR]: "" }}
      role="group"
      aria-label={`${target.user || "匿名"} 的弹幕操作`}
      className={cn(
        "pointer-events-auto absolute z-10 flex -translate-x-1/2 flex-col items-center",
        // Padding on the comment-facing edge rather than a positioning offset:
        // it renders as the same visual gap but stays inside the element's hit
        // area, so the pointer never crosses dead space on its way to a button.
        flipBelow ? "translate-y-0 pt-1.5" : "-translate-y-full pb-1.5",
        large ? "gap-1.5" : "gap-1",
      )}
      style={{
        left: `clamp(${halfWidth}px, ${anchorX}px, calc(100% - ${halfWidth}px))`,
        top: flipBelow ? target.top + target.height : Math.max(0, target.top),
        // Widen the bridge to the full gap the pill was previously offset by, so
        // a diagonal approach lands on padding too.
        paddingLeft: MENU_GAP_PX,
        paddingRight: MENU_GAP_PX,
      }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {flipBelow && actions.statusMessage && (
        <CanvasDanmakuActionStatus message={actions.statusMessage} failed={actions.failed} />
      )}
      <div
        className={cn(
          "flex items-center rounded-full",
          large ? "gap-1 p-1.5" : "gap-0.5 p-1",
          glassPanelClass({ overlay: true }),
        )}
      >
        <Button
          type="button"
          variant="ghost"
          size={buttonSize}
          className={cn("rounded-full", glassOptionClass({ overlay: true }))}
          aria-label="复制弹幕"
          title="复制弹幕"
          onClick={() => void actions.copy()}
        >
          <Copy aria-hidden className={large ? "size-5" : undefined} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size={buttonSize}
          className={cn("rounded-full", glassOptionClass({ overlay: true }))}
          disabled={!actions.canFavorite || actions.favoriting}
          aria-label={actions.favoriteLabel}
          title={actions.favoriteLabel}
          onClick={() => void actions.favorite()}
        >
          {actions.favoriting ? (
            <Spinner aria-hidden className={large ? "size-5" : undefined} />
          ) : (
            <Star aria-hidden className={large ? "size-5" : undefined} />
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size={buttonSize}
          className={cn("rounded-full", glassOptionClass({ overlay: true }))}
          disabled={!actions.canRepeat || actions.sending}
          aria-label={actions.repeatLabel}
          title={actions.repeatLabel}
          onClick={() => void actions.repeat()}
        >
          <SendHorizontal aria-hidden className={large ? "size-5" : undefined} />
        </Button>
        {onDismiss && (
          <>
            <span
              aria-hidden
              className={cn("mx-0.5 h-5 w-px", glassSeparatorClass({ overlay: true }))}
            />
            <Button
              type="button"
              variant="ghost"
              size={buttonSize}
              className={cn("rounded-full", glassOptionClass({ overlay: true }))}
              aria-label="关闭弹幕操作"
              title="关闭"
              onClick={onDismiss}
            >
              <X aria-hidden className={large ? "size-5" : undefined} />
            </Button>
          </>
        )}
      </div>
      {!flipBelow && actions.statusMessage && (
        <CanvasDanmakuActionStatus message={actions.statusMessage} failed={actions.failed} />
      )}
    </div>
  );
});

function CanvasDanmakuActionStatus({ message, failed }: { message: string; failed: boolean }) {
  return (
    <p
      role="status"
      aria-live="polite"
      className={cn(
        "max-w-56 rounded-full px-2 py-0.5 text-center text-[11px] leading-snug whitespace-nowrap",
        glassPanelClass({ overlay: true }),
        failed ? "text-red-200" : "text-white/75",
      )}
    >
      {message}
    </p>
  );
}
