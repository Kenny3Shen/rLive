import { memo, type PointerEvent as ReactPointerEvent } from "react";
import { Copy, MessageSquarePlus, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { glassOptionClass, glassPanelClass } from "@/shared/components/player/glassSurface";
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
 * Horizontal room the pill needs on either side of its anchor, used by the CSS
 * `clamp` that keeps it on screen.
 *
 * Kept close to the real half-width: `clamp` stops centering once the anchor is
 * within this distance of an edge, so an inflated value visibly detaches the pill
 * from the comment it belongs to. Compact is three 36px buttons with 6px gaps and
 * padding (~72px, plus margin for the coarse-pointer `min-w-11` step); large is
 * three 44px buttons with 8px gaps and padding (~88px).
 */
const MENU_HALF_WIDTH_PX = 90;
const MENU_HALF_WIDTH_LARGE_PX = 96;
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
  // `icon-lg` (36px) is the largest built-in step, so the large variant sets its
  // own box. 44px is the conventional minimum comfortable touch target, which is
  // what this variant exists for.
  const buttonClass = large ? "size-11" : undefined;
  const iconClass = large ? "size-6" : "size-5";

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
          // Buttons sit apart rather than flush: they are round targets on a
          // moving picture, and a mis-hit here sends a comment or writes the
          // clipboard, so the gap is deliberate rather than cosmetic.
          "flex items-center rounded-full",
          large ? "gap-2 p-2" : "gap-1.5 p-1.5",
          glassPanelClass({ overlay: true }),
        )}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          className={cn("rounded-full", buttonClass, glassOptionClass({ overlay: true }))}
          aria-label="复制弹幕"
          title="复制弹幕"
          onClick={() => void actions.copy()}
        >
          <Copy aria-hidden className={iconClass} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          className={cn("rounded-full", buttonClass, glassOptionClass({ overlay: true }))}
          disabled={!actions.canFavorite || actions.favoriting}
          aria-label={actions.favoriteLabel}
          title={actions.favoriteLabel}
          onClick={() => void actions.favorite()}
        >
          {actions.favoriting ? (
            <Spinner aria-hidden className={iconClass} />
          ) : (
            <Star aria-hidden className={iconClass} />
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          className={cn("rounded-full", buttonClass, glassOptionClass({ overlay: true }))}
          disabled={!actions.canRepeat || actions.sending}
          aria-label={actions.repeatLabel}
          title={actions.repeatLabel}
          onClick={() => void actions.repeat()}
        >
          {/* A bubble with a plus reads as "add one more comment", which is what
              +1 does. `SendHorizontal` read as "send what I typed" — there is no
              composer here. Square bubbles are already the danmaku symbol in the
              player chrome (`MessageSquareText` / `MessageSquareOff`). */}
          <MessageSquarePlus aria-hidden className={iconClass} />
        </Button>
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
