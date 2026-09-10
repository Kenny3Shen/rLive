import { Tooltip } from "@videojs/react";
import { isValidElement, type ReactElement, type ReactNode } from "react";

import { cn } from "@/components/videojs/lib/resolve-class-name";

export interface ButtonTooltipProps extends Omit<Tooltip.RootProps, "children"> {
  children: ReactElement;
  label?: ReactNode;
}

/** `render` 包装层（PopoverTrigger → MediaButton）最多下探几层去找可访问名。 */
const MAX_TRIGGER_RENDER_DEPTH = 4;

/**
 * 从触发器自身读取 `aria-label`。
 *
 * Video.js 原语（PlayButton、FullscreenButton…）会把文案写进 tooltip context，
 * `Tooltip.Label` 直接取用；业务按钮只是普通 `<button>`，context 里没有文案，
 * `content?.label ?? ""` 取到空串就会画出一个空的 tooltip 框。这些按钮本来就必须
 * 带可访问名，用它兜底既能补上文案，又保证 tooltip 与可访问名永远一致。
 */
function triggerAriaLabel(node: ReactNode, depth = 0): string | undefined {
  if (depth > MAX_TRIGGER_RENDER_DEPTH || !isValidElement(node)) return undefined;
  const props = node.props as { "aria-label"?: unknown; render?: ReactNode };
  const ariaLabel = props["aria-label"];
  if (typeof ariaLabel === "string" && ariaLabel.length > 0) return ariaLabel;
  // `PopoverTrigger render={<MediaButton aria-label=… />}` 把真正的按钮藏在
  // render 里，可访问名也跟着下沉一层。
  return triggerAriaLabel(props.render, depth + 1);
}

/**
 * tooltip 最终展示的文案，`undefined` 表示交给 Video.js context（`Tooltip.Label`）。
 */
export function tooltipTriggerLabel(
  children: ReactNode,
  label?: ReactNode,
): ReactNode | undefined {
  return label ?? triggerAriaLabel(children);
}

export function ButtonTooltip({ children, label, ...props }: ButtonTooltipProps) {
  const content = tooltipTriggerLabel(children, label);
  // 只有走 Video.js context 的原语才有快捷键提示可展示。
  const fromMediaContext = content === undefined;
  return (
    <Tooltip.Root {...props}>
      <Tooltip.Trigger render={children} />
      <Tooltip.Popup
        className={cn(
          "m-0 overflow-visible border-0 text-inherit",
          "media-transitioning:opacity-0 media-transitioning:blur-media-hidden-popup media-transitioning:scale-media-hidden-popup",
          "data-starting-style:[transform:translate(var(--media-popup-translate-x-distance,0),var(--media-popup-translate-y-distance,0))]",
          "data-ending-style:transform-none",
          "data-[side=top]:origin-bottom data-[side=bottom]:origin-top data-[side=left]:origin-right data-[side=right]:origin-left",
          "data-[side=top]:[--media-popup-translate-y-distance:var(--media-popup-translate-distance)]",
          "data-[side=bottom]:[--media-popup-translate-y-distance:calc(var(--media-popup-translate-distance)*-1)]",
          "data-[side=left]:[--media-popup-translate-x-distance:var(--media-popup-translate-distance)]",
          "data-[side=right]:[--media-popup-translate-x-distance:calc(var(--media-popup-translate-distance)*-1)]",
          "before:pointer-events-auto before:absolute",
          "data-[side=top]:before:inset-x-0 data-[side=top]:before:top-full",
          "data-[side=bottom]:before:inset-x-0 data-[side=bottom]:before:bottom-full",
          "data-[side=left]:before:inset-y-0 data-[side=left]:before:left-full",
          "data-[side=right]:before:inset-y-0 data-[side=right]:before:right-full",
          "data-[side=top]:before:h-(--media-popup-side-offset) data-[side=bottom]:before:h-(--media-popup-side-offset)",
          "data-[side=left]:before:w-(--media-popup-side-offset) data-[side=right]:before:w-(--media-popup-side-offset)",
          "transition-media-popup data-ending-style:duration-media-instant",
          "bg-media-popover text-media-popover-foreground surface-media after:surface-media-inset",
          "whitespace-nowrap rounded-media-control py-1 text-media [--media-popup-side-offset:var(--media-tooltip-side-offset)]",
          "data-open:flex data-open:items-center data-open:gap-1",
          "px-2.5",
        )}
      >
        {content ?? <Tooltip.Label />}
        {fromMediaContext && (
          <Tooltip.Shortcut
            className={
              "min-w-[1.5em] rounded-[--spacing(1)] bg-media-muted p-[0.1em] text-center text-media-sm [font-family:inherit] font-semibold leading-tight"
            }
          />
        )}
      </Tooltip.Popup>
    </Tooltip.Root>
  );
}
